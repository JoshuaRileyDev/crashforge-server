# CrashForge Server

CrashForge Server ingests iOS crash payloads, symbolicates them with uploaded dSYMs, enriches frames with source context, sends webhooks, and can open automated fix PRs.

## What this server does

- Accepts dSYM uploads per app/build.
- Accepts crash payloads from iOS clients/SDKs.
- Symbolicates addresses to symbols using `xcrun atos`.
- Enriches frames using one of:
  - GitHub repo + commit SHA
  - local source directory
  - uploaded source zip
- Streams crash events and auto-fix logs to a web UI via SSE.
- Supports webhook routing with per-app templated rules.
- Runs optional auto-fix PR generation (OpenAI-compatible LLM + GitHub).
- Suppresses duplicate auto-fix runs for identical crash signatures.
- Cleans up temporary cloned repos after each auto-fix run.
- Supports optional dashboard password protection.
- Supports storage provider selection (`local` or `s3`) from settings.

## Repository scope

This README is for the server repository only.

- Swift SDK repo: `https://github.com/JoshuaRileyDev/crashforge-ios-sdk`

## Requirements

- macOS host for symbolication (`xcrun dwarfdump`, `xcrun atos`)
- Node.js 20+
- PostgreSQL 14+
- Xcode command line tools

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

UI:

- Dashboard: `http://localhost:3000`
- Settings / Auto-fix config: `http://localhost:3000/settings`
- Webhook rules: `http://localhost:3000/webhooks`
- Live auto-fix logs: `http://localhost:3000/logs`
- Login page (when enabled): `http://localhost:3000/login`

## Docker + Postgres

Bring up both services:

```bash
docker compose up -d --build
```

If you changed `.env`, restart with:

```bash
docker compose up -d --build --force-recreate
```

Ports:

- API: `http://localhost:3000`

Notes:

- The server container now waits for PostgreSQL readiness before starting.
- PostgreSQL is internal-only in Compose (no host port published).
- Inside Docker Compose, server DB host is `postgres` on private network `crashforge-backend`.
- For Compose overrides use `APP_DATABASE_URL`, not `DATABASE_URL`.

## API reference

### `POST /v1/dsyms`

Upload dSYM zip for an app/build.

Required multipart fields:

- `appId`
- `buildVersion`
- `dsym` (zip file)

Optional multipart fields:

- `sourceType`: `repo | local_dir`
- `repoUrl` + `commitSha` (repo mode)
- `localSourceDir` (local dir mode)

### `POST /v1/sources`

Upload source zip for source-mode `zip`.

Multipart fields:

- `appId`
- `buildVersion`
- `sources` (zip file)

### `POST /v1/source-config`

Register source mapping manually.

JSON:

- `appId`
- `buildVersion`
- `sourceType`: `repo | local_dir | zip`
- Plus source-specific fields (`repoUrl`, `commitSha`, `localPath`, `extractedPath`).

### `POST /v1/crashes`

Submit crash payload.

Required:

- `appId`
- `buildVersion`
- `frames[]`
- `binaryImages[]`

Optional metadata overrides:

- `metadata.sourceType`
- `metadata.repoUrl`
- `metadata.commitSha`
- `metadata.localPath`

Response includes:

- `crashId`
- `symbolicatedFrames`
- `duplicateCrash` (boolean)
- `autoFixTriggered` (boolean)

### `GET /v1/crashes`

- Query: `limit` (default `50`)
- Query: `full=1` to include full payload/symbolication details.

### `GET /v1/crashes/:id`

Fetch a single full crash record by id.

### `GET /v1/crashes/stream`

SSE stream of new crash summaries.

### `GET /v1/settings`

Read automation settings.

### `PUT /v1/settings`

Update automation settings:

- `dashboardAuthEnabled`
- `dashboardPassword`
- `cliApiKey` (for CLI repo mapping auth)
- `autoFixEnabled`
- `llmBaseUrl`
- `llmApiKey`
- `llmModel`
- `githubToken`
- `gitUserName`
- `gitUserEmail`
- `defaultBaseBranch`
- `fixBranchPrefix`

### `POST /v1/settings/cli-api-key/generate`

Generate and rotate a new CLI API key. Returns plaintext key once and stores only hash server-side.

### `GET /v1/app-repo-mappings`

List appId -> repo mappings.

### `POST /v1/app-repo-mappings`

Upsert mapping fields:

- `appId`
- `repoUrl`
- `baseBranch`
- `isActive`

Auth: dashboard session cookie or `x-crashforge-api-key` (also accepts `Authorization: Bearer <key>`).

### `PUT /v1/app-repo-mappings/:id`

Update one mapping.

### `DELETE /v1/app-repo-mappings/:id`

Delete one mapping.

### `GET /v1/auto-fix-runs`

List recent auto-fix runs.

### `GET /v1/auto-fix-logs`

List persisted auto-fix logs (`limit`, optional `runId`).

### `GET /v1/auto-fix-logs/stream`

SSE stream for real-time auto-fix logs.

## Source resolution order

For each crash, source context is selected in this order:

1. Crash payload metadata override.
2. Latest `source_mappings` row for `appId + buildVersion`.
3. Fallback from uploaded dSYM metadata (`repoUrl`/`commitSha`/`localSourceDir`).

## Webhook templates

Per-app webhook rules support `{{...}}` placeholders.

Examples:

- `{{crash.id}}`
- `{{crash.payload.appId}}`
- `{{crash.payload.exceptionType}}`
- `{{crash.payload.terminationReason}}`
- `{{crash.symbolicatedFrames.0.symbolicated}}`
- `{{crash.dsym.repoUrl}}`

## Auto-fix PR flow

When `autoFixEnabled=true` and crash is not a duplicate signature:

1. Resolve app-to-repo mapping.
2. Clone target repo and create fix branch.
3. Ask configured model for structured JSON edit plan (Vercel AI SDK).
4. Apply/stage edits, commit, push.
5. Open draft PR (GitHub API with token, or `gh` CLI fallback).
6. Remove temporary clone directory.

## Build phase integration (Xcode)

Use [`BUILD_PHASE_AGENT_GUIDE.md`](./BUILD_PHASE_AGENT_GUIDE.md) for the complete script and required xcconfig variables.

## Project layout

- `src/`: API, storage, symbolication, auto-fix pipeline
- `public/`: dashboard/settings/webhooks/logs UI
- `data/`: local runtime storage folders
- `swift-sdk/`: iOS SDK package (to become separate repo)
- `ios-sample/`: demo Xcode app

## Validation

```bash
npm run check
npm run build
```

Optional end-to-end local checks (if sample/SDK still present in workspace):

```bash
cd swift-sdk && swift test
xcodebuild -project ios-sample/CrashDemoApp/CrashDemoApp.xcodeproj -scheme CrashDemoApp -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build
```
