#!/usr/bin/env sh
set -eu

echo "[CrashForge] Starting server..."
echo "[CrashForge] DATABASE_URL=${DATABASE_URL:-<unset>}"

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[CrashForge] Waiting for PostgreSQL..."
  node <<'NODE'
const { Client } = require("pg");

const connectionString = process.env.DATABASE_URL;
const maxAttempts = 60;
const sleepMs = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function canConnect() {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return true;
  } catch {
    try { await client.end(); } catch {}
    return false;
  }
}

(async () => {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ok = await canConnect();
    if (ok) {
      console.log("[CrashForge] PostgreSQL is ready.");
      process.exit(0);
    }
    console.log(`[CrashForge] PostgreSQL not ready (${attempt}/${maxAttempts}), retrying...`);
    await sleep(sleepMs);
  }
  console.error("[CrashForge] PostgreSQL did not become ready in time.");
  process.exit(1);
})();
NODE
fi

exec node dist/server.js
