import path from "node:path";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  baseDir: process.env.DATA_DIR ?? path.resolve(process.cwd(), "data"),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://crash:crash@localhost:5432/crash_reporter",
  webhookUrl: process.env.WEBHOOK_URL,
  webhookAuthHeader: process.env.WEBHOOK_AUTH_HEADER,
  githubToken: process.env.GITHUB_TOKEN,
};

export const paths = {
  uploads: path.join(config.baseDir, "uploads"),
  dsyms: path.join(config.baseDir, "dsyms"),
  sources: path.join(config.baseDir, "sources"),
  crashes: path.join(config.baseDir, "crashes"),
};
