import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { config, paths } from "./config";
import {
  addDSYMRecord,
  addSourceMapping,
  addAppRepoMapping,
  addWebhookRule,
  deleteAppRepoMapping,
  deleteWebhookRule,
  findBestDSYM,
  findActiveAppRepoMapping,
  findLatestSourceMapping,
  getCrashById,
  getSystemSettings,
  initStorage,
  listAppRepoMappings,
  listAutoFixLogs,
  listRecentAutoFixRuns,
  listWebhookRules,
  listRecentCrashes,
  listDSYMs,
  hasEarlierCrashWithSignature,
  persistCrash,
  updateAppRepoMapping,
  updateSystemSettings,
  updateWebhookRule,
} from "./storage";
import { triggerAutoFix } from "./autoFix";
import { onAutoFixLog } from "./autoFixLogger";
import { enrichWithGithubCodeContext } from "./githubSourceContext";
import { enrichWithFileSystemCodeContext, extractSourceArchive } from "./fileSourceContext";
import { computeCrashSignature } from "./crashSignature";
import { extractDSYM, symbolicateCrash } from "./symbolication";
import { sendCrashWebhook } from "./webhook";
import { AppRepoMapping, CrashPayload, CrashRecord, SourceMappingRecord, SourceType, SystemSettings, WebhookRule } from "./types";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

const upload = multer({
  dest: paths.uploads,
  limits: {
    fileSize: 1024 * 1024 * 300,
  },
});

type CrashStreamEvent = {
  id: string;
  receivedAt: string;
  appId: string;
  buildVersion: string;
  exceptionType: string;
  terminationReason?: string;
  frameCount: number;
  topFrame?: {
    imageName: string;
    symbol?: string;
    symbolicated?: string;
  };
};

const crashStreamClients = new Set<express.Response>();
const autoFixLogStreamClients = new Set<express.Response>();

onAutoFixLog((log) => {
  if (!autoFixLogStreamClients.size) return;
  const payload = `event: log\ndata: ${JSON.stringify(log)}\n\n`;
  for (const client of autoFixLogStreamClients) {
    client.write(payload);
  }
});

function toCrashStreamEvent(record: CrashRecord): CrashStreamEvent {
  const topFrame = record.symbolicatedFrames[0];
  return {
    id: record.id,
    receivedAt: record.receivedAt,
    appId: record.payload.appId,
    buildVersion: record.payload.buildVersion,
    exceptionType: record.payload.exceptionType ?? "UNKNOWN",
    terminationReason: record.payload.terminationReason,
    frameCount: record.symbolicatedFrames.length,
    topFrame: topFrame
      ? {
          imageName: topFrame.imageName,
          symbol: topFrame.symbol,
          symbolicated: topFrame.symbolicated,
        }
      : undefined,
  };
}

function broadcastCrash(record: CrashRecord): void {
  if (!crashStreamClients.size) return;
  const payload = `event: crash\ndata: ${JSON.stringify(toCrashStreamEvent(record))}\n\n`;
  for (const client of crashStreamClients) {
    client.write(payload);
  }
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSourceType(value: unknown): SourceType | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "repo") return "repo";
  if (value === "zip") return "zip";
  if (value === "local_dir" || value === "localDir") return "local_dir";
  return undefined;
}

function booleanFromUnknown(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function webhookRuleInputFromBody(body: unknown): Omit<WebhookRule, "id" | "createdAt" | "updatedAt"> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const input = body as Record<string, unknown>;

  const name = stringFromUnknown(input.name);
  const appId = stringFromUnknown(input.appId);
  const method = stringFromUnknown(input.method)?.toUpperCase() ?? "POST";
  const urlTemplate = stringFromUnknown(input.urlTemplate);
  const authHeaderTemplate = stringFromUnknown(input.authHeaderTemplate);
  const bodyTemplate = typeof input.bodyTemplate === "string" ? input.bodyTemplate : undefined;
  const contentType = stringFromUnknown(input.contentType);
  const isActive = booleanFromUnknown(input.isActive, true);

  if (!name || !appId || !urlTemplate) {
    return undefined;
  }

  const headersTemplateRaw = input.headersTemplate;
  let headersTemplate: Record<string, string> = {};
  if (headersTemplateRaw && typeof headersTemplateRaw === "object" && !Array.isArray(headersTemplateRaw)) {
    headersTemplate = Object.fromEntries(
      Object.entries(headersTemplateRaw).map(([k, v]) => [k, String(v)])
    );
  }

  return {
    name,
    appId,
    isActive,
    method,
    urlTemplate,
    authHeaderTemplate,
    headersTemplate,
    bodyTemplate,
    contentType,
  };
}

function appRepoMappingFromBody(body: unknown): Omit<AppRepoMapping, "id" | "createdAt" | "updatedAt"> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const input = body as Record<string, unknown>;
  const appId = stringFromUnknown(input.appId);
  const repoUrl = stringFromUnknown(input.repoUrl);
  const baseBranch = stringFromUnknown(input.baseBranch) ?? "main";
  const isActive = booleanFromUnknown(input.isActive, true);
  if (!appId || !repoUrl) return undefined;
  return { appId, repoUrl, baseBranch, isActive };
}

function settingsFromBody(body: unknown, current: SystemSettings): Omit<SystemSettings, "id" | "createdAt" | "updatedAt"> {
  if (!body || typeof body !== "object") {
    return {
      autoFixEnabled: current.autoFixEnabled,
      llmBaseUrl: current.llmBaseUrl,
      llmApiKey: current.llmApiKey,
      llmModel: current.llmModel,
      githubToken: current.githubToken,
      gitUserName: current.gitUserName,
      gitUserEmail: current.gitUserEmail,
      defaultBaseBranch: current.defaultBaseBranch,
      fixBranchPrefix: current.fixBranchPrefix,
    };
  }
  const input = body as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  const pickOptional = (key: string, fallback: string | undefined): string | undefined => {
    if (!has(key)) return fallback;
    const raw = input[key];
    if (typeof raw !== "string") return fallback;
    const trimmed = raw.trim();
    return trimmed.length ? trimmed : undefined;
  };

  return {
    autoFixEnabled: booleanFromUnknown(input.autoFixEnabled, current.autoFixEnabled),
    llmBaseUrl: pickOptional("llmBaseUrl", current.llmBaseUrl),
    llmApiKey: has("llmApiKey")
      ? (typeof input.llmApiKey === "string" ? input.llmApiKey : current.llmApiKey)
      : current.llmApiKey,
    llmModel: pickOptional("llmModel", current.llmModel),
    githubToken: has("githubToken")
      ? (typeof input.githubToken === "string" ? input.githubToken : current.githubToken)
      : current.githubToken,
    gitUserName: pickOptional("gitUserName", current.gitUserName),
    gitUserEmail: pickOptional("gitUserEmail", current.gitUserEmail),
    defaultBaseBranch: pickOptional("defaultBaseBranch", current.defaultBaseBranch) ?? "main",
    fixBranchPrefix: pickOptional("fixBranchPrefix", current.fixBranchPrefix) ?? "crash-fix",
  };
}

async function enrichFramesUsingSource(
  frames: Awaited<ReturnType<typeof symbolicateCrash>>,
  mapping: SourceMappingRecord | undefined
) {
  if (!mapping) {
    return {
      frames,
      sourceNote: "no source mapping",
    };
  }

  if (mapping.sourceType === "repo" && mapping.repoUrl && mapping.commitSha) {
    return {
      frames: await enrichWithGithubCodeContext(frames, mapping.repoUrl, mapping.commitSha),
      sourceNote: `repo:${mapping.repoUrl}@${mapping.commitSha}`,
    };
  }

  if (mapping.sourceType === "local_dir" && mapping.localPath) {
    return {
      frames: await enrichWithFileSystemCodeContext(frames, mapping.localPath),
      sourceNote: `local_dir:${mapping.localPath}`,
    };
  }

  if (mapping.sourceType === "zip" && mapping.extractedPath) {
    return {
      frames: await enrichWithFileSystemCodeContext(frames, mapping.extractedPath),
      sourceNote: `zip:${mapping.extractedPath}`,
    };
  }

  return {
    frames,
    sourceNote: "source mapping incomplete",
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "crash-reporter", timestamp: new Date().toISOString() });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

app.get("/settings", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "settings.html"));
});

app.get("/logs", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "logs.html"));
});

app.get("/webhooks", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "webhooks.html"));
});

app.get("/v1/dsyms", async (_req, res) => {
  const records = await listDSYMs();
  res.json({ count: records.length, records });
});

app.get("/v1/crashes", async (req, res) => {
  const rawLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
  const full = String(req.query.full ?? "0") === "1";
  const records = await listRecentCrashes(limit);
  if (full) {
    return res.json({
      count: records.length,
      records,
    });
  }

  res.json({
    count: records.length,
    records: records.map(toCrashStreamEvent),
  });
});

app.get("/v1/crashes/stream", (req, res) => {
  req.socket.setTimeout(0);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, timestamp: new Date().toISOString() })}\n\n`);
  crashStreamClients.add(res);

  const ping = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(ping);
    crashStreamClients.delete(res);
  });
});

app.get("/v1/crashes/:id", async (req, res) => {
  const id = stringFromUnknown(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Crash id is required" });
  }

  const record = await getCrashById(id);
  if (!record) {
    return res.status(404).json({ error: "Crash not found" });
  }

  return res.json({ record });
});

app.get("/v1/webhook-rules", async (_req, res) => {
  const rules = await listWebhookRules();
  return res.json({ count: rules.length, rules });
});

app.post("/v1/webhook-rules", async (req, res) => {
  const input = webhookRuleInputFromBody(req.body);
  if (!input) {
    return res.status(400).json({
      error: "Invalid webhook rule. Required: name, appId, urlTemplate",
    });
  }

  const created = await addWebhookRule(input);
  return res.status(201).json({ rule: created });
});

app.put("/v1/webhook-rules/:id", async (req, res) => {
  const id = stringFromUnknown(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Webhook rule id is required" });
  }

  const input = webhookRuleInputFromBody(req.body);
  if (!input) {
    return res.status(400).json({
      error: "Invalid webhook rule. Required: name, appId, urlTemplate",
    });
  }

  const updated = await updateWebhookRule(id, input);
  if (!updated) {
    return res.status(404).json({ error: "Webhook rule not found" });
  }

  return res.json({ rule: updated });
});

app.delete("/v1/webhook-rules/:id", async (req, res) => {
  const id = stringFromUnknown(req.params.id);
  if (!id) {
    return res.status(400).json({ error: "Webhook rule id is required" });
  }

  const deleted = await deleteWebhookRule(id);
  if (!deleted) {
    return res.status(404).json({ error: "Webhook rule not found" });
  }

  return res.status(204).send();
});

app.get("/v1/settings", async (_req, res) => {
  const settings = await getSystemSettings();
  return res.json({ settings });
});

app.put("/v1/settings", async (req, res) => {
  const current = await getSystemSettings();
  const patch = settingsFromBody(req.body, current);
  const updated = await updateSystemSettings(patch);
  return res.json({ settings: updated });
});

app.get("/v1/app-repo-mappings", async (_req, res) => {
  const mappings = await listAppRepoMappings();
  return res.json({ count: mappings.length, mappings });
});

app.post("/v1/app-repo-mappings", async (req, res) => {
  const mapping = appRepoMappingFromBody(req.body);
  if (!mapping) {
    return res.status(400).json({ error: "Invalid mapping: appId and repoUrl are required" });
  }
  const created = await addAppRepoMapping(mapping);
  return res.status(201).json({ mapping: created });
});

app.put("/v1/app-repo-mappings/:id", async (req, res) => {
  const id = stringFromUnknown(req.params.id);
  if (!id) return res.status(400).json({ error: "Mapping id is required" });

  const existing = (await listAppRepoMappings()).find((m) => m.id === id);
  if (!existing) return res.status(404).json({ error: "Mapping not found" });

  const next = appRepoMappingFromBody(req.body);
  if (!next) {
    return res.status(400).json({ error: "Invalid mapping: appId and repoUrl are required" });
  }

  if (next.appId !== existing.appId) {
    const already = await findActiveAppRepoMapping(next.appId);
    if (already && already.id !== existing.id) {
      return res.status(409).json({ error: `An active mapping for ${next.appId} already exists` });
    }
  }

  const updated = await updateAppRepoMapping(id, next);
  if (!updated) return res.status(404).json({ error: "Mapping not found" });
  return res.json({ mapping: updated });
});

app.delete("/v1/app-repo-mappings/:id", async (req, res) => {
  const id = stringFromUnknown(req.params.id);
  if (!id) return res.status(400).json({ error: "Mapping id is required" });
  const deleted = await deleteAppRepoMapping(id);
  if (!deleted) return res.status(404).json({ error: "Mapping not found" });
  return res.status(204).send();
});

app.get("/v1/auto-fix-runs", async (req, res) => {
  const rawLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
  const runs = await listRecentAutoFixRuns(limit);
  return res.json({ count: runs.length, runs });
});

app.get("/v1/auto-fix-logs", async (req, res) => {
  const rawLimit = Number(req.query.limit ?? 200);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 200;
  const runId = stringFromUnknown(req.query.runId);
  const logs = await listAutoFixLogs(limit, runId);
  return res.json({ count: logs.length, logs });
});

app.get("/v1/auto-fix-logs/stream", (req, res) => {
  req.socket.setTimeout(0);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, timestamp: new Date().toISOString() })}\n\n`);
  autoFixLogStreamClients.add(res);

  const ping = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(ping);
    autoFixLogStreamClients.delete(res);
  });
});

app.post("/v1/source-config", async (req, res) => {
  try {
    const appId = stringFromUnknown(req.body?.appId);
    const buildVersion = stringFromUnknown(req.body?.buildVersion);
    const sourceType = normalizeSourceType(req.body?.sourceType);

    if (!appId || !buildVersion || !sourceType) {
      return res.status(400).json({
        error: "Required: appId, buildVersion, sourceType(repo|zip|local_dir)",
      });
    }

    const record = await addSourceMapping({
      appId,
      buildVersion,
      sourceType,
      repoUrl: stringFromUnknown(req.body?.repoUrl),
      commitSha: stringFromUnknown(req.body?.commitSha),
      localPath: stringFromUnknown(req.body?.localPath),
      zipPath: undefined,
      extractedPath: stringFromUnknown(req.body?.extractedPath),
    });

    return res.status(201).json({
      message: "Source mapping stored",
      record,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

app.post("/v1/sources", upload.single("sources"), async (req, res) => {
  try {
    const file = req.file;
    const appId = stringFromUnknown(req.body?.appId);
    const buildVersion = stringFromUnknown(req.body?.buildVersion);

    if (!file || !appId || !buildVersion) {
      return res.status(400).json({
        error: "Required multipart: sources(file), appId, buildVersion",
      });
    }

    const canonicalZipPath = path.join(paths.uploads, `${randomUUID()}.zip`);
    await fs.rename(file.path, canonicalZipPath);

    const extractionRoot = path.join(paths.sources, appId, buildVersion);
    const extracted = await extractSourceArchive(canonicalZipPath, extractionRoot);

    const mapping = await addSourceMapping({
      appId,
      buildVersion,
      sourceType: "zip",
      repoUrl: undefined,
      commitSha: undefined,
      localPath: undefined,
      zipPath: canonicalZipPath,
      extractedPath: extracted.extractedPath,
    });

    return res.status(201).json({
      message: "Source zip uploaded and indexed",
      mapping,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

app.post("/v1/dsyms", upload.single("dsym"), async (req, res) => {
  try {
    const file = req.file;
    const appId = stringFromUnknown(req.body?.appId);
    const buildVersion = stringFromUnknown(req.body?.buildVersion);
    const repoUrl = stringFromUnknown(req.body?.repoUrl);
    const commitSha = stringFromUnknown(req.body?.commitSha);
    const localSourceDir = stringFromUnknown(req.body?.localSourceDir);
    const sourceType = normalizeSourceType(req.body?.sourceType);

    if (!file || !appId || !buildVersion) {
      return res.status(400).json({
        error: "Missing required fields: dsym(file), appId, buildVersion",
      });
    }

    const canonicalZipPath = path.join(paths.uploads, `${randomUUID()}.zip`);
    await fs.rename(file.path, canonicalZipPath);

    const extractionRoot = path.join(paths.dsyms, appId, buildVersion);
    const extracted = await extractDSYM(canonicalZipPath, extractionRoot);

    const record = await addDSYMRecord({
      appId,
      buildVersion,
      zipPath: canonicalZipPath,
      extractedPath: extracted.extractedPath,
      dwarfPath: extracted.dwarfPath,
      uuids: extracted.uuids,
      repoUrl,
      commitSha,
      localSourceDir,
    });

    if (sourceType === "repo" && repoUrl && commitSha) {
      await addSourceMapping({
        appId,
        buildVersion,
        sourceType: "repo",
        repoUrl,
        commitSha,
        localPath: undefined,
        zipPath: undefined,
        extractedPath: undefined,
      });
    }

    if (sourceType === "local_dir" && localSourceDir) {
      await addSourceMapping({
        appId,
        buildVersion,
        sourceType: "local_dir",
        repoUrl: undefined,
        commitSha: undefined,
        localPath: localSourceDir,
        zipPath: undefined,
        extractedPath: undefined,
      });
    }

    return res.status(201).json({
      message: "dSYM uploaded and indexed",
      record,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

app.post("/v1/crashes", async (req, res) => {
  try {
    const payload = req.body as CrashPayload;

    if (!payload?.appId || !payload?.buildVersion || !Array.isArray(payload.frames) || !Array.isArray(payload.binaryImages)) {
      return res.status(400).json({
        error: "Invalid payload: appId, buildVersion, frames[], binaryImages[] required",
      });
    }

    const preferredUUID = payload.binaryImages[0]?.uuid;
    const dsym = await findBestDSYM(payload.appId, payload.buildVersion, preferredUUID);
    if (!dsym) {
      return res.status(404).json({
        error: "No matching dSYM found for appId/buildVersion",
      });
    }

    const symbolicatedFrames = await symbolicateCrash(payload, dsym);

    const payloadSourceType = normalizeSourceType(payload.metadata?.sourceType);
    const payloadRepoUrl = stringFromUnknown(payload.metadata?.repoUrl);
    const payloadCommitSha = stringFromUnknown(payload.metadata?.commitSha);
    const payloadLocalPath = stringFromUnknown(payload.metadata?.localPath);

    let sourceMapping: SourceMappingRecord | undefined;

    if (payloadSourceType === "repo" && payloadRepoUrl && payloadCommitSha) {
      sourceMapping = {
        id: "payload",
        appId: payload.appId,
        buildVersion: payload.buildVersion,
        sourceType: "repo",
        uploadedAt: new Date().toISOString(),
        repoUrl: payloadRepoUrl,
        commitSha: payloadCommitSha,
      };
    } else if (payloadSourceType === "local_dir" && payloadLocalPath) {
      sourceMapping = {
        id: "payload",
        appId: payload.appId,
        buildVersion: payload.buildVersion,
        sourceType: "local_dir",
        uploadedAt: new Date().toISOString(),
        localPath: payloadLocalPath,
      };
    } else {
      sourceMapping = await findLatestSourceMapping(payload.appId, payload.buildVersion);

      if (!sourceMapping && dsym.repoUrl && dsym.commitSha) {
        sourceMapping = {
          id: "dsym",
          appId: payload.appId,
          buildVersion: payload.buildVersion,
          sourceType: "repo",
          uploadedAt: new Date().toISOString(),
          repoUrl: dsym.repoUrl,
          commitSha: dsym.commitSha,
        };
      }

      if (!sourceMapping && dsym.localSourceDir) {
        sourceMapping = {
          id: "dsym",
          appId: payload.appId,
          buildVersion: payload.buildVersion,
          sourceType: "local_dir",
          uploadedAt: new Date().toISOString(),
          localPath: dsym.localSourceDir,
        };
      }
    }

    const enriched = await enrichFramesUsingSource(symbolicatedFrames, sourceMapping);

    const record = {
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      payload,
      symbolicatedFrames: enriched.frames,
      dsym,
    };

    const crashSignature = computeCrashSignature(record);
    await persistCrash(record, crashSignature);
    broadcastCrash(record);

    sendCrashWebhook(record).catch((error) => {
      console.error("Webhook delivery failed:", error);
    });

    const isDuplicateCrash = await hasEarlierCrashWithSignature(payload.appId, crashSignature, record.id);
    if (!isDuplicateCrash) {
      triggerAutoFix(record).catch((error) => {
        console.error("Auto-fix pipeline failed:", error);
      });
    }

    return res.status(202).json({
      message: "Crash accepted and processed",
      crashId: record.id,
      symbolicatedFrames: enriched.frames,
      sourceNote: enriched.sourceNote,
      duplicateCrash: isDuplicateCrash,
      autoFixTriggered: !isDuplicateCrash,
      note: "dSYM cannot decompile full source; symbolication + optional source context was applied when possible.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

async function start(): Promise<void> {
  await initStorage();
  app.listen(config.port, () => {
    console.log(`Crash reporter listening on http://localhost:${config.port}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
