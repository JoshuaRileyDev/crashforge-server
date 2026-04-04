import fs from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SystemSettings } from "./types";

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.trim().replace(/^\/+|\/+$/g, "");
}

function buildObjectKey(parts: string[]): string {
  return parts
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function createS3Client(settings: SystemSettings): S3Client {
  if (!settings.s3AccessKeyId || !settings.s3SecretAccessKey) {
    throw new Error("S3 storage selected but access key credentials are missing");
  }

  return new S3Client({
    region: settings.s3Region || "us-east-1",
    endpoint: settings.s3Endpoint || undefined,
    forcePathStyle: settings.s3ForcePathStyle ?? true,
    credentials: {
      accessKeyId: settings.s3AccessKeyId,
      secretAccessKey: settings.s3SecretAccessKey,
    },
  });
}

export function isS3StorageEnabled(settings: SystemSettings): boolean {
  return settings.storageProvider === "s3";
}

export async function persistArtifactForStorage(
  localPath: string,
  objectKeyParts: string[],
  contentType: string,
  settings: SystemSettings
): Promise<string> {
  if (!isS3StorageEnabled(settings)) {
    return localPath;
  }

  if (!settings.s3Bucket) {
    throw new Error("S3 storage selected but bucket is not configured");
  }

  const prefix = normalizePrefix(settings.s3Prefix);
  const key = buildObjectKey(prefix ? [prefix, ...objectKeyParts] : objectKeyParts);
  const body = await fs.readFile(localPath);
  const client = createS3Client(settings);

  await client.send(
    new PutObjectCommand({
      Bucket: settings.s3Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  await fs.rm(localPath, { force: true });
  return `s3://${settings.s3Bucket}/${key}`;
}
