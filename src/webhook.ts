import axios from "axios";
import { config } from "./config";
import { listActiveWebhookRulesForApp } from "./storage";
import { CrashRecord, WebhookRule } from "./types";

type TemplateContext = {
  crash: {
    id: string;
    receivedAt: string;
    payload: CrashRecord["payload"];
    symbolicatedFrames: CrashRecord["symbolicatedFrames"];
    dsym: CrashRecord["dsym"];
  };
};

function getByPath(input: unknown, pathExpression: string): unknown {
  const parts = pathExpression.split(".").map((part) => part.trim()).filter(Boolean);
  let current: unknown = input;

  for (const part of parts) {
    if (current == null) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
      continue;
    }

    if (typeof current === "object" && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
      continue;
    }

    return undefined;
  }

  return current;
}

function renderTemplate(template: string | undefined, context: TemplateContext): string | undefined {
  if (!template) return template;
  return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_match, expression) => {
    const value = getByPath(context, String(expression));
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
  });
}

function buildTemplateContext(record: CrashRecord): TemplateContext {
  return {
    crash: {
      id: record.id,
      receivedAt: record.receivedAt,
      payload: record.payload,
      symbolicatedFrames: record.symbolicatedFrames,
      dsym: record.dsym,
    },
  };
}

async function sendLegacyEnvWebhook(record: CrashRecord): Promise<void> {
  if (!config.webhookUrl) return;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.webhookAuthHeader) {
    headers.Authorization = config.webhookAuthHeader;
  }

  await axios.post(
    config.webhookUrl,
    {
      event: "crash.processed",
      crashId: record.id,
      receivedAt: record.receivedAt,
      appId: record.payload.appId,
      buildVersion: record.payload.buildVersion,
      incidentIdentifier: record.payload.incidentIdentifier,
      exceptionType: record.payload.exceptionType,
      exceptionCodes: record.payload.exceptionCodes,
      terminationReason: record.payload.terminationReason,
      repoUrl: record.dsym?.repoUrl ?? record.payload.metadata?.repoUrl,
      commitSha: record.dsym?.commitSha ?? record.payload.metadata?.commitSha,
      symbolicatedFrames: record.symbolicatedFrames,
      note: "dSYM symbolication gives symbol/file-line context, not full source decompilation",
    },
    { headers, timeout: 10_000 }
  );
}

async function sendRuleWebhook(rule: WebhookRule, record: CrashRecord): Promise<void> {
  const context = buildTemplateContext(record);
  const method = rule.method.toUpperCase();
  const url = renderTemplate(rule.urlTemplate, context);

  if (!url) {
    throw new Error(`Webhook rule ${rule.id} produced empty URL`);
  }

  const renderedAuth = renderTemplate(rule.authHeaderTemplate, context);
  const renderedHeadersTemplate = rule.headersTemplate ?? {};
  const headers: Record<string, string> = {};

  if (rule.contentType) {
    headers["Content-Type"] = renderTemplate(rule.contentType, context) ?? rule.contentType;
  }

  if (renderedAuth) {
    headers.Authorization = renderedAuth;
  }

  for (const [key, value] of Object.entries(renderedHeadersTemplate)) {
    const renderedValue = renderTemplate(value, context);
    if (!renderedValue) continue;
    headers[key] = renderedValue;
  }

  const renderedBody = renderTemplate(rule.bodyTemplate, context);
  let body: unknown = undefined;

  if (renderedBody != null && renderedBody.length > 0) {
    const contentType = (headers["Content-Type"] ?? "").toLowerCase();
    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(renderedBody);
      } catch {
        body = renderedBody;
      }
    } else {
      body = renderedBody;
    }
  }

  await axios.request({
    method,
    url,
    headers,
    data: body,
    timeout: 10_000,
  });
}

export async function sendCrashWebhook(record: CrashRecord): Promise<void> {
  try {
    await sendLegacyEnvWebhook(record);
  } catch (error) {
    console.error("Legacy env webhook failed:", error);
  }

  const rules = await listActiveWebhookRulesForApp(record.payload.appId);
  if (!rules.length) return;

  await Promise.all(
    rules.map(async (rule) => {
      try {
        await sendRuleWebhook(rule, record);
      } catch (error) {
        console.error(`Webhook rule ${rule.id} (${rule.name}) failed:`, error);
      }
    })
  );
}
