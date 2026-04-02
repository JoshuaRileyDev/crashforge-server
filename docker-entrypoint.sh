#!/usr/bin/env sh
set -eu

echo "[CrashForge] Starting server..."
echo "[CrashForge] DATABASE_URL=${DATABASE_URL:-<unset>}"

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[CrashForge] Waiting for PostgreSQL..."
  node <<'NODE'
const { Client } = require("pg");

const connectionString = process.env.DATABASE_URL;
const maxAttempts = Number(process.env.DB_WAIT_MAX_ATTEMPTS || 180);
const sleepMs = Number(process.env.DB_WAIT_INTERVAL_MS || 1000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function canConnect() {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return { ok: true };
  } catch (error) {
    try { await client.end(); } catch {}
    return {
      ok: false,
      error: error && error.message ? String(error.message) : String(error),
      code: error && error.code ? String(error.code) : undefined,
    };
  }
}

(async () => {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await canConnect();
    if (result.ok) {
      console.log("[CrashForge] PostgreSQL is ready.");
      process.exit(0);
    }
    lastError = result;
    const suffix = result.code ? ` code=${result.code}` : "";
    console.log(`[CrashForge] PostgreSQL not ready (${attempt}/${maxAttempts})${suffix}: ${result.error}`);
    await sleep(sleepMs);
  }
  if (lastError) {
    const suffix = lastError.code ? ` code=${lastError.code}` : "";
    console.error(`[CrashForge] Last PostgreSQL error${suffix}: ${lastError.error}`);
  }
  console.error(`[CrashForge] PostgreSQL did not become ready in time after ${maxAttempts} attempts.`);
  process.exit(1);
})();
NODE
fi

exec node dist/server.js
