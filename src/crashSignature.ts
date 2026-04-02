import { createHash } from "node:crypto";
import { CrashRecord } from "./types";

type CrashSignatureInput = Pick<CrashRecord, "payload" | "symbolicatedFrames">;

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function computeCrashSignature(input: CrashSignatureInput): string {
  const payload = input.payload;
  const frameKey = input.symbolicatedFrames
    .map((frame) => `${frame.imageName}|${normalizeText(frame.symbolicated)}|${normalizeText(frame.address)}`)
    .join("\n");

  const key = [
    normalizeText(payload.appId),
    normalizeText(payload.buildVersion),
    normalizeText(payload.exceptionType),
    normalizeText(payload.exceptionCodes),
    normalizeText(payload.terminationReason),
    String(payload.crashedThread ?? ""),
    frameKey,
  ].join("\n---\n");

  return createHash("sha256").update(key, "utf8").digest("hex");
}
