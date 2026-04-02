import axios from "axios";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import {
  createAutoFixRun,
  findActiveAppRepoMapping,
  getSystemSettings,
  updateAutoFixRun,
} from "./storage";
import { writeAutoFixLog } from "./autoFixLogger";
import { CrashRecord } from "./types";

type AutoFixEdit = {
  filePath: string;
  newText: string;
  oldText?: string;
  startLine?: number;
  endLine?: number;
  rationale?: string;
};

type AutoFixEditPlan = {
  summary?: string;
  edits: AutoFixEdit[];
};

async function runCommand(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
    });
  });
}

function normalizeRepoRelativePath(filePath: string): string | undefined {
  const trimmed = filePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!trimmed || path.isAbsolute(trimmed) || trimmed.includes("..")) return undefined;
  return trimmed;
}

function extractJsonObject(raw: string): string | undefined {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return undefined;
  return trimmed.slice(first, last + 1);
}

function parseEditPlan(raw: string): AutoFixEditPlan | undefined {
  const json = extractJsonObject(raw);
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as AutoFixEditPlan;
    if (!parsed || !Array.isArray(parsed.edits)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function sanitizeBranchName(input: string): string {
  return input.replace(/[^a-zA-Z0-9/_-]+/g, "-").replace(/--+/g, "-").replace(/^[-/]+|[-/]+$/g, "");
}

function parseGithubRepo(url: string): { owner: string; repo: string } | undefined {
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return undefined;
}

function withGithubToken(repoUrl: string, token: string): string {
  if (!repoUrl.startsWith("https://")) return repoUrl;
  const withoutProtocol = repoUrl.replace(/^https:\/\//, "");
  return `https://x-access-token:${encodeURIComponent(token)}@${withoutProtocol}`;
}

async function tryCreatePrWithGhCli(
  repoDir: string,
  title: string,
  body: string,
  headBranch: string,
  baseBranch: string
): Promise<string | undefined> {
  try {
    const output = await runCommand(
      "gh",
      [
        "pr",
        "create",
        "--title",
        title,
        "--body",
        body,
        "--head",
        headBranch,
        "--base",
        baseBranch,
        "--draft",
      ],
      repoDir
    );
    const url = output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("https://github.com/"));
    return url;
  } catch {
    return undefined;
  }
}

async function generateEditPlan(
  record: CrashRecord,
  llmBaseUrl: string,
  llmApiKey: string,
  llmModel: string
): Promise<AutoFixEditPlan | undefined> {
  const topFrames = record.symbolicatedFrames.slice(0, 12).map((f) => f.symbolicated).join("\n");
  const prompt = [
    "You are an autonomous iOS crash-fix assistant.",
    "Given crash details and repository context, propose a minimal code fix as structured edits.",
    "Return ONLY strict JSON with this exact shape:",
    '{ "summary": "string", "edits": [ { "filePath": "relative/path.swift", "oldText": "exact text to replace", "newText": "replacement text" } ] }',
    "Rules:",
    "- Prefer edits with oldText+newText.",
    "- Optionally use startLine/endLine + newText if exact oldText is not stable.",
    "- filePath must be repository-relative.",
    "- Keep edits minimal and compile-safe.",
    "- If unsure, return {\"summary\":\"No safe fix\",\"edits\":[]}.",
    "",
    `Crash ID: ${record.id}`,
    `App ID: ${record.payload.appId}`,
    `Exception: ${record.payload.exceptionType ?? "UNKNOWN"}`,
    `Reason: ${record.payload.terminationReason ?? "UNKNOWN"}`,
    "Top Frames:",
    topFrames,
    "",
    "Raw Report:",
    record.payload.rawReport ?? "",
  ].join("\n");

  const openai = createOpenAI({
    apiKey: llmApiKey,
    baseURL: llmBaseUrl.replace(/\/$/, ""),
  });

  const result = await generateText({
    model: openai(llmModel),
    system: "Return only strict JSON edit plan output.",
    prompt,
    temperature: 0.1,
    maxRetries: 1,
  });

  return parseEditPlan(result.text);
}

function replaceLineRange(content: string, startLine: number, endLine: number, replacement: string): string | undefined {
  if (startLine < 1 || endLine < startLine) return undefined;
  const lines = content.split("\n");
  if (startLine > lines.length || endLine > lines.length) return undefined;
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(endLine);
  return [...before, replacement, ...after].join("\n");
}

async function applyEditPlan(repoDir: string, plan: AutoFixEditPlan): Promise<{ appliedEdits: number; changedFiles: string[] }> {
  const editsByFile = new Map<string, AutoFixEdit[]>();
  for (const edit of plan.edits) {
    if (!edit || typeof edit.filePath !== "string" || typeof edit.newText !== "string") continue;
    const normalizedPath = normalizeRepoRelativePath(edit.filePath);
    if (!normalizedPath) continue;
    const bucket = editsByFile.get(normalizedPath) ?? [];
    bucket.push({ ...edit, filePath: normalizedPath });
    editsByFile.set(normalizedPath, bucket);
  }

  let appliedEdits = 0;
  const changedFiles: string[] = [];

  for (const [filePath, edits] of editsByFile.entries()) {
    const fullPath = path.join(repoDir, filePath);
    let content: string;
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    let fileChanged = false;
    for (const edit of edits) {
      if (typeof edit.oldText === "string" && edit.oldText.length > 0) {
        if (!content.includes(edit.oldText)) continue;
        content = content.replace(edit.oldText, edit.newText);
        fileChanged = true;
        appliedEdits += 1;
        continue;
      }

      if (
        typeof edit.startLine === "number" &&
        Number.isInteger(edit.startLine) &&
        typeof edit.endLine === "number" &&
        Number.isInteger(edit.endLine)
      ) {
        const replaced = replaceLineRange(content, edit.startLine, edit.endLine, edit.newText);
        if (!replaced) continue;
        content = replaced;
        fileChanged = true;
        appliedEdits += 1;
      }
    }

    if (fileChanged) {
      await fs.writeFile(fullPath, content, "utf8");
      await runCommand("git", ["add", "--", filePath], repoDir);
      changedFiles.push(filePath);
    }
  }

  return { appliedEdits, changedFiles };
}

async function buildRepoPromptContext(repoDir: string, record: CrashRecord): Promise<string> {
  const trackedFilesRaw = await runCommand("git", ["ls-files"], repoDir).catch(() => "");
  const trackedFiles = trackedFilesRaw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const candidateFiles = new Set<string>();
  const framePathRegex = /\(([^()]+\.swift):\d+\)$/;
  for (const frame of record.symbolicatedFrames) {
    const symbolicated = frame.symbolicated ?? "";
    const match = symbolicated.match(framePathRegex);
    if (match?.[1]) {
      const filename = match[1].split("/").pop() ?? match[1];
      const repoMatch = trackedFiles.find((f) => f.endsWith(`/${filename}`) || f === filename);
      if (repoMatch) {
        candidateFiles.add(repoMatch);
      }
    }
  }

  const selectedFiles = Array.from(candidateFiles).slice(0, 6);
  const fileSnippets: string[] = [];
  for (const file of selectedFiles) {
    try {
      const fullPath = path.join(repoDir, file);
      const content = await fs.readFile(fullPath, "utf8");
      fileSnippets.push(`FILE: ${file}\n${content.slice(0, 12000)}`);
    } catch {
      // Ignore unreadable files.
    }
  }

  const fileListPreview = trackedFiles.slice(0, 300).join("\n");
  return [
    "Repository tracked files (first 300):",
    fileListPreview || "<none>",
    "",
    "Likely relevant file contents:",
    fileSnippets.length ? fileSnippets.join("\n\n---\n\n") : "<none>",
  ].join("\n");
}

export async function triggerAutoFix(record: CrashRecord): Promise<void> {
  const run = await createAutoFixRun({
    crashId: record.id,
    appId: record.payload.appId,
    status: "queued",
    message: "Queued",
  });

  let tmpRoot: string | undefined;

  try {
    await writeAutoFixLog(run.id, "info", "Auto-fix run started", { crashId: record.id, appId: record.payload.appId });
    const settings = await getSystemSettings();
    if (!settings.autoFixEnabled) {
      await updateAutoFixRun(run.id, { status: "skipped", message: "Auto-fix disabled in settings" });
      await writeAutoFixLog(run.id, "warn", "Skipped: auto-fix disabled");
      return;
    }

    const mapping = await findActiveAppRepoMapping(record.payload.appId);
    if (!mapping) {
      await updateAutoFixRun(run.id, { status: "skipped", message: `No app repo mapping for ${record.payload.appId}` });
      await writeAutoFixLog(run.id, "warn", "Skipped: no app repo mapping", { appId: record.payload.appId });
      return;
    }

    if (!settings.llmBaseUrl || !settings.llmApiKey || !settings.llmModel) {
      await updateAutoFixRun(run.id, { status: "skipped", message: "Missing LLM settings" });
      await writeAutoFixLog(run.id, "warn", "Skipped: missing LLM settings");
      return;
    }

    await updateAutoFixRun(run.id, { status: "running", message: "Cloning repo and preparing branch" });
    await writeAutoFixLog(run.id, "info", "Cloning repository", { repoUrl: mapping.repoUrl });

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crash-fix-"));
    const authRepoUrl = settings.githubToken ? withGithubToken(mapping.repoUrl, settings.githubToken) : mapping.repoUrl;
    await runCommand("git", ["clone", authRepoUrl, "repo"], tmpRoot);
    const repoDir = path.join(tmpRoot, "repo");

    await runCommand("git", ["checkout", mapping.baseBranch || settings.defaultBaseBranch || "main"], repoDir);
    await writeAutoFixLog(run.id, "info", "Checked out base branch", { baseBranch: mapping.baseBranch || settings.defaultBaseBranch || "main" });

    const prefix = settings.fixBranchPrefix || "crash-fix";
    const branchName = sanitizeBranchName(`${prefix}/${record.payload.appId}-${record.id.slice(0, 8)}`);
    await runCommand("git", ["checkout", "-b", branchName], repoDir);
    await writeAutoFixLog(run.id, "info", "Created fix branch", { branchName });

    if (settings.gitUserName) {
      await runCommand("git", ["config", "user.name", settings.gitUserName], repoDir);
    }
    if (settings.gitUserEmail) {
      await runCommand("git", ["config", "user.email", settings.gitUserEmail], repoDir);
    }

    await updateAutoFixRun(run.id, { message: "Generating edit plan with LLM", branchName });
    const repoContext = await buildRepoPromptContext(repoDir, record);
    await writeAutoFixLog(run.id, "info", "Sending prompt to model", {
      model: settings.llmModel,
      llmBaseUrl: settings.llmBaseUrl,
      promptPreview: [
        `Crash ID: ${record.id}`,
        `App ID: ${record.payload.appId}`,
        `Exception: ${record.payload.exceptionType ?? "UNKNOWN"}`,
        `Reason: ${record.payload.terminationReason ?? "UNKNOWN"}`,
      ].join("\n"),
    });

    const editPromptRecord: CrashRecord = {
      ...record,
      payload: {
        ...record.payload,
        rawReport: [record.payload.rawReport ?? "", "", repoContext].join("\n"),
      },
    };
    const editPlan = await generateEditPlan(editPromptRecord, settings.llmBaseUrl, settings.llmApiKey, settings.llmModel);
    if (!editPlan) {
      await updateAutoFixRun(run.id, {
        status: "skipped",
        message: "Model did not return a valid edit plan",
        branchName,
      });
      await writeAutoFixLog(run.id, "warn", "Model returned no valid edit plan");
      return;
    }
    await writeAutoFixLog(run.id, "info", "Model returned edit plan", {
      edits: Array.isArray(editPlan.edits) ? editPlan.edits.length : 0,
      summary: editPlan.summary ?? "",
    });

    const applyResult = await applyEditPlan(repoDir, editPlan);
    await writeAutoFixLog(run.id, "info", "Applied structured edits", {
      appliedEdits: applyResult.appliedEdits,
      changedFiles: applyResult.changedFiles,
    });

    if (applyResult.appliedEdits === 0 || applyResult.changedFiles.length === 0) {
      await updateAutoFixRun(run.id, {
        status: "skipped",
        message: "Edit plan produced no applicable file changes",
        branchName,
      });
      await writeAutoFixLog(run.id, "warn", "No applicable edits from model output");
      return;
    }

    const stagedFilesRaw = await runCommand("git", ["diff", "--cached", "--name-only"], repoDir);
    if (!stagedFilesRaw.trim()) {
      await updateAutoFixRun(run.id, {
        status: "skipped",
        message: "No staged changes after applying edits",
        branchName,
      });
      await writeAutoFixLog(run.id, "warn", "No staged changes after applying edits");
      return;
    }

    await runCommand("git", ["commit", "-m", `chore: attempt fix for crash ${record.id.slice(0, 8)}`], repoDir);
    await writeAutoFixLog(run.id, "info", "Committed patch");
    await runCommand("git", ["push", "-u", "origin", branchName], repoDir);
    await writeAutoFixLog(run.id, "info", "Pushed branch", { branchName });

    const repoInfo = parseGithubRepo(mapping.repoUrl);
    if (!repoInfo) {
      await updateAutoFixRun(run.id, { status: "failed", message: "Could not parse GitHub repo URL", branchName });
      await writeAutoFixLog(run.id, "error", "Failed: could not parse GitHub repo URL", { repoUrl: mapping.repoUrl });
      return;
    }

    const prTitle = `Auto-fix attempt for crash ${record.id.slice(0, 8)}`;
    const prBase = mapping.baseBranch || settings.defaultBaseBranch || "main";
    const prBody = [
      `Automated crash-fix attempt.`,
      ``,
      `Crash ID: ${record.id}`,
      `App ID: ${record.payload.appId}`,
      `Exception: ${record.payload.exceptionType ?? "UNKNOWN"}`,
      `Reason: ${record.payload.terminationReason ?? "UNKNOWN"}`,
    ].join("\n");

    let prUrl: string | undefined;

    if (settings.githubToken) {
      await writeAutoFixLog(run.id, "info", "Creating PR via GitHub API");
      const prResponse = await axios.post(
        `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/pulls`,
        {
          title: prTitle,
          head: branchName,
          base: prBase,
          body: prBody,
          draft: true,
        },
        {
          headers: {
            Authorization: `Bearer ${settings.githubToken}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          timeout: 20_000,
        }
      );
      prUrl = prResponse.data?.html_url as string | undefined;
    } else {
      await writeAutoFixLog(run.id, "info", "Creating PR via gh CLI fallback");
      prUrl = await tryCreatePrWithGhCli(repoDir, prTitle, prBody, branchName, prBase);
    }

    await updateAutoFixRun(run.id, {
      status: "success",
      message: prUrl ? "PR created" : "Changes pushed (PR not auto-created)",
      branchName,
      prUrl,
    });
    await writeAutoFixLog(run.id, "info", "Run completed", { status: "success", prUrl, branchName });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateAutoFixRun(run.id, { status: "failed", message });
    await writeAutoFixLog(run.id, "error", "Run failed", { error: message });
  } finally {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(async (cleanupError) => {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        await writeAutoFixLog(run.id, "warn", "Failed to cleanup temporary worktree", { error: message });
      });
    }
  }
}
