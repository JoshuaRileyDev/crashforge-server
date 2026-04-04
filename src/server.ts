import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { randomBytes, randomUUID } from "node:crypto";
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
import {
  buildDashboardSessionClearCookie,
  buildDashboardSessionCookie,
  createDashboardSession,
  getDashboardSessionTokenFromRequest,
  hashDashboardPassword,
  isDashboardSessionValid,
  revokeDashboardSession,
  verifyDashboardPassword,
} from "./dashboardAuth";
import { enrichWithGithubCodeContext } from "./githubSourceContext";
import { enrichWithFileSystemCodeContext, extractSourceArchive } from "./fileSourceContext";
import { computeCrashSignature } from "./crashSignature";
import { persistArtifactForStorage } from "./objectStorage";
import { extractDSYM, symbolicateCrash } from "./symbolication";
import { sendCrashWebhook } from "./webhook";
import { AppRepoMapping, CrashPayload, CrashRecord, SourceMappingRecord, SourceType, SystemSettings, WebhookRule } from "./types";

const app = express();
app.use(express.json({ limit: "5mb" }));

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

function logCrashIntake(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    scope: "crash-intake",
    level,
    message,
    ...(meta ? { meta } : {}),
  };
  const line = `[CrashForge] ${JSON.stringify(entry)}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function logDSYMIntake(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    scope: "dsym-intake",
    level,
    message,
    ...(meta ? { meta } : {}),
  };
  const line = `[CrashForge] ${JSON.stringify(entry)}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

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

function sanitizeSettingsForClient(settings: SystemSettings): Omit<SystemSettings, "dashboardPasswordHash"> {
  const cloned = { ...settings };
  delete (cloned as { dashboardPasswordHash?: string }).dashboardPasswordHash;
  delete (cloned as { cliApiKeyHash?: string }).cliApiKeyHash;
  return cloned;
}

function requestIsSecure(req: express.Request): boolean {
  if (req.secure) return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (typeof forwardedProto === "string") return forwardedProto.split(",")[0]?.trim() === "https";
  return false;
}

function dashboardPageAuthDeniedResponse(req: express.Request, res: express.Response): void {
  const next = encodeURIComponent(req.originalUrl || "/");
  res.redirect(`/login?next=${next}`);
}

async function checkDashboardAuth(req: express.Request, res: express.Response): Promise<boolean> {
  const settings = await getSystemSettings();
  if (!settings.dashboardAuthEnabled) return true;
  const token = getDashboardSessionTokenFromRequest(req);
  const ok = isDashboardSessionValid(token);
  if (!ok) {
    res.setHeader("Set-Cookie", buildDashboardSessionClearCookie(requestIsSecure(req)));
  }
  return ok;
}

async function requireDashboardPageAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const ok = await checkDashboardAuth(req, res);
  if (!ok) {
    dashboardPageAuthDeniedResponse(req, res);
    return;
  }
  next();
}

async function requireDashboardApiAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const ok = await checkDashboardAuth(req, res);
  if (!ok) {
    res.status(401).json({ error: "Dashboard authentication required" });
    return;
  }
  next();
}

function getCliApiKeyFromRequest(req: express.Request): string | undefined {
  const keyHeader = req.headers["x-crashforge-api-key"];
  if (typeof keyHeader === "string" && keyHeader.trim()) return keyHeader.trim();

  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

function hasValidCliApiKey(req: express.Request, settings: SystemSettings): boolean {
  if (!settings.cliApiKeyHash) return false;
  const providedKey = getCliApiKeyFromRequest(req);
  if (!providedKey) return false;
  return verifyDashboardPassword(providedKey, settings.cliApiKeyHash);
}

function generateCliApiKey(): string {
  return `cfk_${randomBytes(24).toString("base64url")}`;
}

async function requireDashboardOrCliApiKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const settings = await getSystemSettings();
  if (hasValidCliApiKey(req, settings)) {
    next();
    return;
  }

  const ok = !settings.dashboardAuthEnabled || isDashboardSessionValid(getDashboardSessionTokenFromRequest(req));
  if (!ok) {
    res.setHeader("Set-Cookie", buildDashboardSessionClearCookie(requestIsSecure(req)));
    res.status(401).json({ error: "Dashboard session or x-crashforge-api-key required" });
    return;
  }
  next();
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
      dashboardAuthEnabled: current.dashboardAuthEnabled,
      dashboardPasswordHash: current.dashboardPasswordHash,
      dashboardPasswordSet: current.dashboardPasswordSet,
      cliApiKeyHash: current.cliApiKeyHash,
      cliApiKeySet: current.cliApiKeySet,
      storageProvider: current.storageProvider,
      s3Bucket: current.s3Bucket,
      s3Region: current.s3Region,
      s3Endpoint: current.s3Endpoint,
      s3AccessKeyId: current.s3AccessKeyId,
      s3SecretAccessKey: current.s3SecretAccessKey,
      s3Prefix: current.s3Prefix,
      s3ForcePathStyle: current.s3ForcePathStyle,
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
  const pickStorageProvider = (): "local" | "s3" => {
    if (!has("storageProvider")) return current.storageProvider;
    const raw = input.storageProvider;
    if (raw === "s3") return "s3";
    return "local";
  };

  const rawDashboardPassword = has("dashboardPassword")
    ? (typeof input.dashboardPassword === "string" ? input.dashboardPassword : "")
    : "";
  const dashboardPasswordHash = rawDashboardPassword.trim()
    ? hashDashboardPassword(rawDashboardPassword)
    : current.dashboardPasswordHash;
  const rawCliApiKey = has("cliApiKey")
    ? (typeof input.cliApiKey === "string" ? input.cliApiKey : "")
    : "";
  const cliApiKeyHash = rawCliApiKey.trim() ? hashDashboardPassword(rawCliApiKey) : current.cliApiKeyHash;

  return {
    autoFixEnabled: booleanFromUnknown(input.autoFixEnabled, current.autoFixEnabled),
    dashboardAuthEnabled: booleanFromUnknown(input.dashboardAuthEnabled, current.dashboardAuthEnabled),
    dashboardPasswordHash,
    dashboardPasswordSet: Boolean(dashboardPasswordHash),
    cliApiKeyHash,
    cliApiKeySet: Boolean(cliApiKeyHash),
    storageProvider: pickStorageProvider(),
    s3Bucket: pickOptional("s3Bucket", current.s3Bucket),
    s3Region: pickOptional("s3Region", current.s3Region),
    s3Endpoint: pickOptional("s3Endpoint", current.s3Endpoint),
    s3AccessKeyId: pickOptional("s3AccessKeyId", current.s3AccessKeyId),
    s3SecretAccessKey: has("s3SecretAccessKey")
      ? (typeof input.s3SecretAccessKey === "string"
          ? (input.s3SecretAccessKey.trim() ? input.s3SecretAccessKey : undefined)
          : current.s3SecretAccessKey)
      : current.s3SecretAccessKey,
    s3Prefix: pickOptional("s3Prefix", current.s3Prefix),
    s3ForcePathStyle: booleanFromUnknown(input.s3ForcePathStyle, current.s3ForcePathStyle ?? true),
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

app.get("/login", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "login.html"));
});

app.get("/v1/auth/status", async (req, res) => {
  const settings = await getSystemSettings();
  const token = getDashboardSessionTokenFromRequest(req);
  const authenticated = !settings.dashboardAuthEnabled || isDashboardSessionValid(token);
  return res.json({
    enabled: settings.dashboardAuthEnabled,
    passwordSet: settings.dashboardPasswordSet,
    authenticated,
  });
});

app.post("/v1/auth/login", async (req, res) => {
  const settings = await getSystemSettings();
  if (!settings.dashboardAuthEnabled) {
    return res.json({ ok: true, enabled: false });
  }

  const password = stringFromUnknown((req.body as Record<string, unknown>)?.password) ?? "";
  if (!password) {
    return res.status(400).json({ error: "Password is required" });
  }
  if (!settings.dashboardPasswordHash) {
    return res.status(400).json({ error: "Dashboard password is not configured" });
  }

  if (!verifyDashboardPassword(password, settings.dashboardPasswordHash)) {
    return res.status(401).json({ error: "Invalid password" });
  }

  const token = createDashboardSession();
  res.setHeader("Set-Cookie", buildDashboardSessionCookie(token, requestIsSecure(req)));
  return res.json({ ok: true, enabled: true });
});

app.post("/v1/auth/logout", async (req, res) => {
  const token = getDashboardSessionTokenFromRequest(req);
  revokeDashboardSession(token);
  res.setHeader("Set-Cookie", buildDashboardSessionClearCookie(requestIsSecure(req)));
  return res.json({ ok: true });
});

app.get("/", requireDashboardPageAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

app.get("/settings", requireDashboardPageAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "settings.html"));
});

app.get("/logs", requireDashboardPageAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "logs.html"));
});

app.get("/webhooks", requireDashboardPageAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "webhooks.html"));
});

app.get("/v1/dsyms", requireDashboardApiAuth, async (_req, res) => {
  const records = await listDSYMs();
  res.json({ count: records.length, records });
});

app.get("/v1/crashes", requireDashboardApiAuth, async (req, res) => {
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

app.get("/v1/crashes/stream", requireDashboardApiAuth, (req, res) => {
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

app.get("/v1/crashes/:id", requireDashboardApiAuth, async (req, res) => {
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

app.get("/v1/webhook-rules", requireDashboardApiAuth, async (_req, res) => {
  const rules = await listWebhookRules();
  return res.json({ count: rules.length, rules });
});

app.post("/v1/webhook-rules", requireDashboardApiAuth, async (req, res) => {
  const input = webhookRuleInputFromBody(req.body);
  if (!input) {
    return res.status(400).json({
      error: "Invalid webhook rule. Required: name, appId, urlTemplate",
    });
  }

  const created = await addWebhookRule(input);
  return res.status(201).json({ rule: created });
});

app.put("/v1/webhook-rules/:id", requireDashboardApiAuth, async (req, res) => {
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

app.delete("/v1/webhook-rules/:id", requireDashboardApiAuth, async (req, res) => {
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

app.get("/v1/settings", requireDashboardApiAuth, async (_req, res) => {
  const settings = await getSystemSettings();
  return res.json({ settings: sanitizeSettingsForClient(settings) });
});

app.put("/v1/settings", requireDashboardApiAuth, async (req, res) => {
  const current = await getSystemSettings();
  const patch = settingsFromBody(req.body, current);
  if (patch.dashboardAuthEnabled && !patch.dashboardPasswordHash && !current.dashboardPasswordHash) {
    return res.status(400).json({ error: "Set a dashboard password before enabling password protection" });
  }
  const updated = await updateSystemSettings(patch);
  return res.json({ settings: sanitizeSettingsForClient(updated) });
});

app.post("/v1/settings/cli-api-key/generate", requireDashboardApiAuth, async (_req, res) => {
  const current = await getSystemSettings();
  const patch = settingsFromBody({}, current);
  const apiKey = generateCliApiKey();
  patch.cliApiKeyHash = hashDashboardPassword(apiKey);
  patch.cliApiKeySet = true;
  const updated = await updateSystemSettings(patch);
  return res.status(201).json({
    apiKey,
    settings: sanitizeSettingsForClient(updated),
  });
});

app.get("/v1/app-repo-mappings", requireDashboardOrCliApiKey, async (_req, res) => {
  const mappings = await listAppRepoMappings();
  return res.json({ count: mappings.length, mappings });
});

app.post("/v1/app-repo-mappings", requireDashboardOrCliApiKey, async (req, res) => {
  const mapping = appRepoMappingFromBody(req.body);
  if (!mapping) {
    return res.status(400).json({ error: "Invalid mapping: appId and repoUrl are required" });
  }
  const created = await addAppRepoMapping(mapping);
  return res.status(201).json({ mapping: created });
});

app.put("/v1/app-repo-mappings/:id", requireDashboardOrCliApiKey, async (req, res) => {
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

app.delete("/v1/app-repo-mappings/:id", requireDashboardOrCliApiKey, async (req, res) => {
  const id = stringFromUnknown(req.params.id);
  if (!id) return res.status(400).json({ error: "Mapping id is required" });
  const deleted = await deleteAppRepoMapping(id);
  if (!deleted) return res.status(404).json({ error: "Mapping not found" });
  return res.status(204).send();
});

app.get("/v1/auto-fix-runs", requireDashboardApiAuth, async (req, res) => {
  const rawLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
  const runs = await listRecentAutoFixRuns(limit);
  return res.json({ count: runs.length, runs });
});

app.get("/v1/auto-fix-logs", requireDashboardApiAuth, async (req, res) => {
  const rawLimit = Number(req.query.limit ?? 200);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 200;
  const runId = stringFromUnknown(req.query.runId);
  const logs = await listAutoFixLogs(limit, runId);
  return res.json({ count: logs.length, logs });
});

app.get("/v1/auto-fix-logs/stream", requireDashboardApiAuth, (req, res) => {
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

    const settings = await getSystemSettings();
    const storedZipPath = await persistArtifactForStorage(
      canonicalZipPath,
      ["sources", appId, buildVersion, `${randomUUID()}.zip`],
      "application/zip",
      settings
    );

    const mapping = await addSourceMapping({
      appId,
      buildVersion,
      sourceType: "zip",
      repoUrl: undefined,
      commitSha: undefined,
      localPath: undefined,
      zipPath: storedZipPath,
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
    logDSYMIntake("info", "dSYM upload received", {
      ip: req.ip,
      appId,
      buildVersion,
      sourceType,
      hasFile: Boolean(file),
      fileName: file?.originalname,
      fileSize: file?.size,
    });

    if (!file || !appId || !buildVersion) {
      logDSYMIntake("warn", "dSYM upload rejected: missing required fields", {
        appId,
        buildVersion,
        hasFile: Boolean(file),
      });
      return res.status(400).json({
        error: "Missing required fields: dsym(file), appId, buildVersion",
      });
    }

    const canonicalZipPath = path.join(paths.uploads, `${randomUUID()}.zip`);
    await fs.rename(file.path, canonicalZipPath);

    const extractionRoot = path.join(paths.dsyms, appId, buildVersion);
    const extracted = await extractDSYM(canonicalZipPath, extractionRoot);

    const settings = await getSystemSettings();
    const storedZipPath = await persistArtifactForStorage(
      canonicalZipPath,
      ["dsyms", appId, buildVersion, `${randomUUID()}.zip`],
      "application/zip",
      settings
    );

    const record = await addDSYMRecord({
      appId,
      buildVersion,
      zipPath: storedZipPath,
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

    logDSYMIntake("info", "dSYM upload indexed", {
      dsymId: record.id,
      appId: record.appId,
      buildVersion: record.buildVersion,
      uuidCount: record.uuids.length,
      sourceType,
    });

    return res.status(201).json({
      message: "dSYM uploaded and indexed",
      record,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDSYMIntake("error", "dSYM upload failed", {
      error: message,
    });
    return res.status(500).json({ error: message });
  }
});

app.post("/v1/crashes", async (req, res) => {
  try {
    const payload = req.body as CrashPayload;
    logCrashIntake("info", "Crash report received", {
      ip: req.ip,
      appId: payload?.appId,
      buildVersion: payload?.buildVersion,
      exceptionType: payload?.exceptionType,
      frameCount: Array.isArray(payload?.frames) ? payload.frames.length : 0,
      binaryImageCount: Array.isArray(payload?.binaryImages) ? payload.binaryImages.length : 0,
      captureMode: typeof payload?.metadata?.captureMode === "string" ? payload.metadata.captureMode : undefined,
    });

    if (!payload?.appId || !payload?.buildVersion || !Array.isArray(payload.frames) || !Array.isArray(payload.binaryImages)) {
      logCrashIntake("warn", "Crash report rejected: invalid payload", {
        appId: payload?.appId,
        buildVersion: payload?.buildVersion,
      });
      return res.status(400).json({
        error: "Invalid payload: appId, buildVersion, frames[], binaryImages[] required",
      });
    }

    const preferredUUID = payload.binaryImages[0]?.uuid;
    const dsym = await findBestDSYM(payload.appId, payload.buildVersion, preferredUUID);
    if (!dsym) {
      logCrashIntake("warn", "Crash report rejected: no matching dSYM", {
        appId: payload.appId,
        buildVersion: payload.buildVersion,
        preferredUUID,
      });
      return res.status(404).json({
        error: "No matching dSYM found for appId/buildVersion",
      });
    }
    logCrashIntake("info", "Matched dSYM for crash", {
      appId: payload.appId,
      buildVersion: payload.buildVersion,
      dsymId: dsym.id,
      preferredUUID,
      dsymUUIDCount: dsym.uuids.length,
    });

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
    logCrashIntake("info", "Crash persisted", {
      crashId: record.id,
      appId: payload.appId,
      buildVersion: payload.buildVersion,
      sourceNote: enriched.sourceNote,
      crashSignature,
    });
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
    logCrashIntake("info", "Crash processing complete", {
      crashId: record.id,
      duplicateCrash: isDuplicateCrash,
      autoFixTriggered: !isDuplicateCrash,
    });

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
    logCrashIntake("error", "Crash processing failed", {
      error: message,
    });
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
