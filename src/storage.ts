import fs from "node:fs/promises";
import { Pool } from "pg";
import { config, paths } from "./config";
import {
  AppRepoMapping,
  AutoFixLog,
  AutoFixRun,
  CrashRecord,
  DSYMRecord,
  SourceMappingRecord,
  SourceType,
  SystemSettings,
  WebhookRule,
} from "./types";

const pool = new Pool({
  connectionString: config.databaseUrl,
});

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

function mapDSYMRow(row: {
  id: string;
  app_id: string;
  build_version: string;
  uploaded_at: Date | string;
  zip_path: string;
  extracted_path: string;
  dwarf_path: string;
  uuids: string[];
  repo_url: string | null;
  commit_sha: string | null;
  local_source_dir: string | null;
}): DSYMRecord {
  return {
    id: row.id,
    appId: row.app_id,
    buildVersion: row.build_version,
    uploadedAt: new Date(row.uploaded_at).toISOString(),
    zipPath: row.zip_path,
    extractedPath: row.extracted_path,
    dwarfPath: row.dwarf_path,
    uuids: row.uuids,
    repoUrl: row.repo_url ?? undefined,
    commitSha: row.commit_sha ?? undefined,
    localSourceDir: row.local_source_dir ?? undefined,
  };
}

function mapSourceMappingRow(row: {
  id: string;
  app_id: string;
  build_version: string;
  source_type: SourceType;
  uploaded_at: Date | string;
  repo_url: string | null;
  commit_sha: string | null;
  local_path: string | null;
  zip_path: string | null;
  extracted_path: string | null;
}): SourceMappingRecord {
  return {
    id: row.id,
    appId: row.app_id,
    buildVersion: row.build_version,
    sourceType: row.source_type,
    uploadedAt: new Date(row.uploaded_at).toISOString(),
    repoUrl: row.repo_url ?? undefined,
    commitSha: row.commit_sha ?? undefined,
    localPath: row.local_path ?? undefined,
    zipPath: row.zip_path ?? undefined,
    extractedPath: row.extracted_path ?? undefined,
  };
}

function mapWebhookRuleRow(row: {
  id: string;
  name: string;
  app_id: string;
  is_active: boolean;
  method: string;
  url_template: string;
  auth_header_template: string | null;
  headers_template: unknown;
  body_template: string | null;
  content_type: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}): WebhookRule {
  return {
    id: row.id,
    name: row.name,
    appId: row.app_id,
    isActive: row.is_active,
    method: row.method,
    urlTemplate: row.url_template,
    authHeaderTemplate: row.auth_header_template ?? undefined,
    headersTemplate: row.headers_template ? toJsonValue(row.headers_template) : undefined,
    bodyTemplate: row.body_template ?? undefined,
    contentType: row.content_type ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapSystemSettingsRow(row: {
  id: string;
  auto_fix_enabled: boolean;
  dashboard_auth_enabled: boolean;
  dashboard_password_hash: string | null;
  storage_provider: "local" | "s3";
  s3_bucket: string | null;
  s3_region: string | null;
  s3_endpoint: string | null;
  s3_access_key_id: string | null;
  s3_secret_access_key: string | null;
  s3_prefix: string | null;
  s3_force_path_style: boolean | null;
  llm_base_url: string | null;
  llm_api_key: string | null;
  llm_model: string | null;
  github_token: string | null;
  git_user_name: string | null;
  git_user_email: string | null;
  default_base_branch: string | null;
  fix_branch_prefix: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}): SystemSettings {
  return {
    id: row.id,
    autoFixEnabled: row.auto_fix_enabled,
    dashboardAuthEnabled: row.dashboard_auth_enabled,
    dashboardPasswordHash: row.dashboard_password_hash ?? undefined,
    dashboardPasswordSet: Boolean(row.dashboard_password_hash),
    storageProvider: row.storage_provider ?? "local",
    s3Bucket: row.s3_bucket ?? undefined,
    s3Region: row.s3_region ?? undefined,
    s3Endpoint: row.s3_endpoint ?? undefined,
    s3AccessKeyId: row.s3_access_key_id ?? undefined,
    s3SecretAccessKey: row.s3_secret_access_key ?? undefined,
    s3Prefix: row.s3_prefix ?? undefined,
    s3ForcePathStyle: row.s3_force_path_style ?? true,
    llmBaseUrl: row.llm_base_url ?? undefined,
    llmApiKey: row.llm_api_key ?? undefined,
    llmModel: row.llm_model ?? undefined,
    githubToken: row.github_token ?? undefined,
    gitUserName: row.git_user_name ?? undefined,
    gitUserEmail: row.git_user_email ?? undefined,
    defaultBaseBranch: row.default_base_branch ?? undefined,
    fixBranchPrefix: row.fix_branch_prefix ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapAppRepoMappingRow(row: {
  id: string;
  app_id: string;
  repo_url: string;
  base_branch: string;
  is_active: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}): AppRepoMapping {
  return {
    id: row.id,
    appId: row.app_id,
    repoUrl: row.repo_url,
    baseBranch: row.base_branch,
    isActive: row.is_active,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapAutoFixRunRow(row: {
  id: string;
  crash_id: string;
  app_id: string;
  status: "queued" | "running" | "success" | "failed" | "skipped";
  message: string | null;
  branch_name: string | null;
  pr_url: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}): AutoFixRun {
  return {
    id: row.id,
    crashId: row.crash_id,
    appId: row.app_id,
    status: row.status,
    message: row.message ?? undefined,
    branchName: row.branch_name ?? undefined,
    prUrl: row.pr_url ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapAutoFixLogRow(row: {
  id: string;
  run_id: string;
  level: "info" | "warn" | "error";
  message: string;
  meta: unknown;
  created_at: string | Date;
}): AutoFixLog {
  return {
    id: row.id,
    runId: row.run_id,
    level: row.level,
    message: row.message,
    meta: row.meta ? toJsonValue(row.meta) : undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toJsonValue<T>(value: unknown): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value as T;
}

function mapCrashRow(row: {
  id: string;
  received_at: string | Date;
  payload: unknown;
  symbolicated_frames: unknown;
  dsym_snapshot: unknown;
}): CrashRecord {
  return {
    id: row.id,
    receivedAt: new Date(row.received_at).toISOString(),
    payload: toJsonValue(row.payload),
    symbolicatedFrames: toJsonValue(row.symbolicated_frames),
    dsym: row.dsym_snapshot ? toJsonValue(row.dsym_snapshot) : undefined,
  };
}

export async function initStorage(): Promise<void> {
  await Promise.all([
    ensureDir(paths.uploads),
    ensureDir(paths.dsyms),
    ensureDir(paths.crashes),
    ensureDir(paths.sources),
  ]);

  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dsyms (
      id UUID PRIMARY KEY,
      app_id TEXT NOT NULL,
      build_version TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL,
      zip_path TEXT NOT NULL,
      extracted_path TEXT NOT NULL,
      dwarf_path TEXT NOT NULL,
      uuids TEXT[] NOT NULL,
      repo_url TEXT,
      commit_sha TEXT,
      local_source_dir TEXT
    );
  `);

  await pool.query(`
    ALTER TABLE dsyms
    ADD COLUMN IF NOT EXISTS local_source_dir TEXT;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_dsyms_app_build_uploaded
    ON dsyms (app_id, build_version, uploaded_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crashes (
      id UUID PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL,
      symbolicated_frames JSONB NOT NULL,
      crash_signature TEXT,
      dsym_id UUID,
      dsym_snapshot JSONB,
      CONSTRAINT fk_dsym FOREIGN KEY (dsym_id) REFERENCES dsyms(id) ON DELETE SET NULL
    );
  `);

  await pool.query(`
    ALTER TABLE crashes
    ADD COLUMN IF NOT EXISTS crash_signature TEXT;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_crashes_received_at
    ON crashes (received_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_crashes_signature_app
    ON crashes (crash_signature, (payload->>'appId'));
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS source_mappings (
      id UUID PRIMARY KEY,
      app_id TEXT NOT NULL,
      build_version TEXT NOT NULL,
      source_type TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL,
      repo_url TEXT,
      commit_sha TEXT,
      local_path TEXT,
      zip_path TEXT,
      extracted_path TEXT
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_source_mappings_app_build_uploaded
    ON source_mappings (app_id, build_version, uploaded_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_rules (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      app_id TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      method TEXT NOT NULL DEFAULT 'POST',
      url_template TEXT NOT NULL,
      auth_header_template TEXT,
      headers_template JSONB,
      body_template TEXT,
      content_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_webhook_rules_app_active
    ON webhook_rules (app_id, is_active, updated_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      id TEXT PRIMARY KEY,
      auto_fix_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      dashboard_auth_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      dashboard_password_hash TEXT,
      storage_provider TEXT NOT NULL DEFAULT 'local',
      s3_bucket TEXT,
      s3_region TEXT,
      s3_endpoint TEXT,
      s3_access_key_id TEXT,
      s3_secret_access_key TEXT,
      s3_prefix TEXT,
      s3_force_path_style BOOLEAN NOT NULL DEFAULT TRUE,
      llm_base_url TEXT,
      llm_api_key TEXT,
      llm_model TEXT,
      github_token TEXT,
      git_user_name TEXT,
      git_user_email TEXT,
      default_base_branch TEXT NOT NULL DEFAULT 'main',
      fix_branch_prefix TEXT NOT NULL DEFAULT 'crash-fix',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE system_settings
    ADD COLUMN IF NOT EXISTS dashboard_auth_enabled BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await pool.query(`
    ALTER TABLE system_settings
    ADD COLUMN IF NOT EXISTS dashboard_password_hash TEXT;
  `);

  await pool.query(`
    ALTER TABLE system_settings
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'local';
  `);

  await pool.query(`
    ALTER TABLE system_settings
    ADD COLUMN IF NOT EXISTS s3_bucket TEXT;
  `);

  await pool.query(`
    ALTER TABLE system_settings
    ADD COLUMN IF NOT EXISTS s3_region TEXT;
  `);

  await pool.query(`
    ALTER TABLE system_settings
    ADD COLUMN IF NOT EXISTS s3_endpoint TEXT;
  `);

  await pool.query(`
    ALTER TABLE system_settings
    ADD COLUMN IF NOT EXISTS s3_access_key_id TEXT;
  `);

  await pool.query(`
    ALTER TABLE system_settings
    ADD COLUMN IF NOT EXISTS s3_secret_access_key TEXT;
  `);

  await pool.query(`
    ALTER TABLE system_settings
    ADD COLUMN IF NOT EXISTS s3_prefix TEXT;
  `);

  await pool.query(`
    ALTER TABLE system_settings
    ADD COLUMN IF NOT EXISTS s3_force_path_style BOOLEAN NOT NULL DEFAULT TRUE;
  `);

  await pool.query(`
    INSERT INTO system_settings (id)
    VALUES ('default')
    ON CONFLICT (id) DO NOTHING;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_repo_mappings (
      id UUID PRIMARY KEY,
      app_id TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      base_branch TEXT NOT NULL DEFAULT 'main',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_app_repo_mappings_app_id
    ON app_repo_mappings (app_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auto_fix_runs (
      id UUID PRIMARY KEY,
      crash_id UUID NOT NULL,
      app_id TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      branch_name TEXT,
      pr_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_auto_fix_runs_created
    ON auto_fix_runs (created_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auto_fix_logs (
      id UUID PRIMARY KEY,
      run_id UUID NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_auto_fix_log_run FOREIGN KEY (run_id) REFERENCES auto_fix_runs(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_auto_fix_logs_run_created
    ON auto_fix_logs (run_id, created_at DESC);
  `);
}

export async function addDSYMRecord(record: Omit<DSYMRecord, "id" | "uploadedAt">): Promise<DSYMRecord> {
  const result = await pool.query(
    `
      INSERT INTO dsyms (
        id,
        app_id,
        build_version,
        uploaded_at,
        zip_path,
        extracted_path,
        dwarf_path,
        uuids,
        repo_url,
        commit_sha,
        local_source_dir
      ) VALUES (gen_random_uuid(), $1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `,
    [
      record.appId,
      record.buildVersion,
      record.zipPath,
      record.extractedPath,
      record.dwarfPath,
      record.uuids,
      record.repoUrl ?? null,
      record.commitSha ?? null,
      record.localSourceDir ?? null,
    ]
  );

  return mapDSYMRow(result.rows[0]);
}

export async function addSourceMapping(record: Omit<SourceMappingRecord, "id" | "uploadedAt">): Promise<SourceMappingRecord> {
  const result = await pool.query(
    `
      INSERT INTO source_mappings (
        id,
        app_id,
        build_version,
        source_type,
        uploaded_at,
        repo_url,
        commit_sha,
        local_path,
        zip_path,
        extracted_path
      ) VALUES (gen_random_uuid(), $1, $2, $3, NOW(), $4, $5, $6, $7, $8)
      RETURNING *;
    `,
    [
      record.appId,
      record.buildVersion,
      record.sourceType,
      record.repoUrl ?? null,
      record.commitSha ?? null,
      record.localPath ?? null,
      record.zipPath ?? null,
      record.extractedPath ?? null,
    ]
  );

  return mapSourceMappingRow(result.rows[0]);
}

export async function findLatestSourceMapping(appId: string, buildVersion: string): Promise<SourceMappingRecord | undefined> {
  const result = await pool.query(
    `
      SELECT *
      FROM source_mappings
      WHERE app_id = $1
        AND build_version = $2
      ORDER BY uploaded_at DESC
      LIMIT 1;
    `,
    [appId, buildVersion]
  );

  if (!result.rows[0]) return undefined;
  return mapSourceMappingRow(result.rows[0]);
}

export async function findBestDSYM(appId: string, buildVersion: string, preferredUUID?: string): Promise<DSYMRecord | undefined> {
  if (preferredUUID) {
    const byUuid = await pool.query(
      `
        SELECT *
        FROM dsyms
        WHERE app_id = $1
          AND build_version = $2
          AND EXISTS (
            SELECT 1
            FROM unnest(uuids) AS u
            WHERE upper(u) = upper($3)
          )
        ORDER BY uploaded_at DESC
        LIMIT 1;
      `,
      [appId, buildVersion, preferredUUID]
    );

    if (byUuid.rows[0]) {
      return mapDSYMRow(byUuid.rows[0]);
    }
  }

  const latest = await pool.query(
    `
      SELECT *
      FROM dsyms
      WHERE app_id = $1
        AND build_version = $2
      ORDER BY uploaded_at DESC
      LIMIT 1;
    `,
    [appId, buildVersion]
  );

  if (!latest.rows[0]) return undefined;
  return mapDSYMRow(latest.rows[0]);
}

export async function persistCrash(record: CrashRecord, crashSignature?: string): Promise<void> {
  await pool.query(
    `
      INSERT INTO crashes (id, received_at, payload, symbolicated_frames, crash_signature, dsym_id, dsym_snapshot)
      VALUES ($1, $2::timestamptz, $3::jsonb, $4::jsonb, $5, $6::uuid, $7::jsonb);
    `,
    [
      record.id,
      record.receivedAt,
      JSON.stringify(record.payload),
      JSON.stringify(record.symbolicatedFrames),
      crashSignature ?? null,
      record.dsym?.id ?? null,
      JSON.stringify(record.dsym ?? null),
    ]
  );
}

export async function hasEarlierCrashWithSignature(
  appId: string,
  crashSignature: string,
  excludeCrashId: string
): Promise<boolean> {
  const result = await pool.query(
    `
      SELECT id
      FROM crashes
      WHERE crash_signature = $1
        AND payload->>'appId' = $2
        AND id <> $3::uuid
      ORDER BY received_at DESC
      LIMIT 1;
    `,
    [crashSignature, appId, excludeCrashId]
  );

  return Boolean(result.rows[0]);
}

export async function listRecentCrashes(limit: number): Promise<CrashRecord[]> {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;
  const result = await pool.query(
    `
      SELECT id, received_at, payload, symbolicated_frames, dsym_snapshot
      FROM crashes
      ORDER BY received_at DESC
      LIMIT $1;
    `,
    [normalizedLimit]
  );

  return result.rows.map(mapCrashRow);
}

export async function getCrashById(id: string): Promise<CrashRecord | undefined> {
  const result = await pool.query(
    `
      SELECT id, received_at, payload, symbolicated_frames, dsym_snapshot
      FROM crashes
      WHERE id = $1
      LIMIT 1;
    `,
    [id]
  );

  if (!result.rows[0]) return undefined;
  return mapCrashRow(result.rows[0]);
}

export async function listDSYMs(): Promise<DSYMRecord[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM dsyms
      ORDER BY uploaded_at DESC;
    `
  );

  return result.rows.map(mapDSYMRow);
}

export async function listWebhookRules(): Promise<WebhookRule[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM webhook_rules
      ORDER BY updated_at DESC, created_at DESC;
    `
  );

  return result.rows.map(mapWebhookRuleRow);
}

export async function listActiveWebhookRulesForApp(appId: string): Promise<WebhookRule[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM webhook_rules
      WHERE is_active = TRUE
        AND (app_id = $1 OR app_id = '*')
      ORDER BY updated_at DESC, created_at DESC;
    `,
    [appId]
  );

  return result.rows.map(mapWebhookRuleRow);
}

export async function addWebhookRule(
  rule: Omit<WebhookRule, "id" | "createdAt" | "updatedAt">
): Promise<WebhookRule> {
  const result = await pool.query(
    `
      INSERT INTO webhook_rules (
        id,
        name,
        app_id,
        is_active,
        method,
        url_template,
        auth_header_template,
        headers_template,
        body_template,
        content_type,
        created_at,
        updated_at
      ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NOW(), NOW())
      RETURNING *;
    `,
    [
      rule.name,
      rule.appId,
      rule.isActive,
      rule.method,
      rule.urlTemplate,
      rule.authHeaderTemplate ?? null,
      JSON.stringify(rule.headersTemplate ?? {}),
      rule.bodyTemplate ?? null,
      rule.contentType ?? null,
    ]
  );

  return mapWebhookRuleRow(result.rows[0]);
}

export async function updateWebhookRule(
  id: string,
  patch: Omit<WebhookRule, "id" | "createdAt" | "updatedAt">
): Promise<WebhookRule | undefined> {
  const result = await pool.query(
    `
      UPDATE webhook_rules
      SET
        name = $2,
        app_id = $3,
        is_active = $4,
        method = $5,
        url_template = $6,
        auth_header_template = $7,
        headers_template = $8::jsonb,
        body_template = $9,
        content_type = $10,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `,
    [
      id,
      patch.name,
      patch.appId,
      patch.isActive,
      patch.method,
      patch.urlTemplate,
      patch.authHeaderTemplate ?? null,
      JSON.stringify(patch.headersTemplate ?? {}),
      patch.bodyTemplate ?? null,
      patch.contentType ?? null,
    ]
  );

  if (!result.rows[0]) return undefined;
  return mapWebhookRuleRow(result.rows[0]);
}

export async function deleteWebhookRule(id: string): Promise<boolean> {
  const result = await pool.query(
    `
      DELETE FROM webhook_rules
      WHERE id = $1;
    `,
    [id]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function getSystemSettings(): Promise<SystemSettings> {
  const result = await pool.query(
    `
      SELECT *
      FROM system_settings
      WHERE id = 'default'
      LIMIT 1;
    `
  );

  return mapSystemSettingsRow(result.rows[0]);
}

export async function updateSystemSettings(
  patch: Omit<SystemSettings, "id" | "createdAt" | "updatedAt">
): Promise<SystemSettings> {
  const result = await pool.query(
    `
      UPDATE system_settings
      SET
        auto_fix_enabled = $1,
        dashboard_auth_enabled = $2,
        dashboard_password_hash = COALESCE($3, dashboard_password_hash),
        storage_provider = $4,
        s3_bucket = $5,
        s3_region = $6,
        s3_endpoint = $7,
        s3_access_key_id = $8,
        s3_secret_access_key = $9,
        s3_prefix = $10,
        s3_force_path_style = $11,
        llm_base_url = $12,
        llm_api_key = $13,
        llm_model = $14,
        github_token = $15,
        git_user_name = $16,
        git_user_email = $17,
        default_base_branch = $18,
        fix_branch_prefix = $19,
        updated_at = NOW()
      WHERE id = 'default'
      RETURNING *;
    `,
    [
      patch.autoFixEnabled,
      patch.dashboardAuthEnabled,
      patch.dashboardPasswordHash ?? null,
      patch.storageProvider ?? "local",
      patch.s3Bucket ?? null,
      patch.s3Region ?? null,
      patch.s3Endpoint ?? null,
      patch.s3AccessKeyId ?? null,
      patch.s3SecretAccessKey ?? null,
      patch.s3Prefix ?? null,
      patch.s3ForcePathStyle ?? true,
      patch.llmBaseUrl ?? null,
      patch.llmApiKey ?? null,
      patch.llmModel ?? null,
      patch.githubToken ?? null,
      patch.gitUserName ?? null,
      patch.gitUserEmail ?? null,
      patch.defaultBaseBranch ?? "main",
      patch.fixBranchPrefix ?? "crash-fix",
    ]
  );

  return mapSystemSettingsRow(result.rows[0]);
}

export async function listAppRepoMappings(): Promise<AppRepoMapping[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM app_repo_mappings
      ORDER BY updated_at DESC;
    `
  );
  return result.rows.map(mapAppRepoMappingRow);
}

export async function findActiveAppRepoMapping(appId: string): Promise<AppRepoMapping | undefined> {
  const result = await pool.query(
    `
      SELECT *
      FROM app_repo_mappings
      WHERE app_id = $1
        AND is_active = TRUE
      LIMIT 1;
    `,
    [appId]
  );
  if (!result.rows[0]) return undefined;
  return mapAppRepoMappingRow(result.rows[0]);
}

export async function addAppRepoMapping(mapping: Omit<AppRepoMapping, "id" | "createdAt" | "updatedAt">): Promise<AppRepoMapping> {
  const result = await pool.query(
    `
      INSERT INTO app_repo_mappings (id, app_id, repo_url, base_branch, is_active, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (app_id)
      DO UPDATE SET
        repo_url = EXCLUDED.repo_url,
        base_branch = EXCLUDED.base_branch,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
      RETURNING *;
    `,
    [mapping.appId, mapping.repoUrl, mapping.baseBranch, mapping.isActive]
  );
  return mapAppRepoMappingRow(result.rows[0]);
}

export async function updateAppRepoMapping(
  id: string,
  mapping: Omit<AppRepoMapping, "id" | "createdAt" | "updatedAt">
): Promise<AppRepoMapping | undefined> {
  const result = await pool.query(
    `
      UPDATE app_repo_mappings
      SET
        app_id = $2,
        repo_url = $3,
        base_branch = $4,
        is_active = $5,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `,
    [id, mapping.appId, mapping.repoUrl, mapping.baseBranch, mapping.isActive]
  );
  if (!result.rows[0]) return undefined;
  return mapAppRepoMappingRow(result.rows[0]);
}

export async function deleteAppRepoMapping(id: string): Promise<boolean> {
  const result = await pool.query(
    `
      DELETE FROM app_repo_mappings
      WHERE id = $1;
    `,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function createAutoFixRun(
  input: Omit<AutoFixRun, "id" | "createdAt" | "updatedAt">
): Promise<AutoFixRun> {
  const result = await pool.query(
    `
      INSERT INTO auto_fix_runs (id, crash_id, app_id, status, message, branch_name, pr_url, created_at, updated_at)
      VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING *;
    `,
    [input.crashId, input.appId, input.status, input.message ?? null, input.branchName ?? null, input.prUrl ?? null]
  );
  return mapAutoFixRunRow(result.rows[0]);
}

export async function updateAutoFixRun(
  id: string,
  patch: Partial<Pick<AutoFixRun, "status" | "message" | "branchName" | "prUrl">>
): Promise<AutoFixRun | undefined> {
  const result = await pool.query(
    `
      UPDATE auto_fix_runs
      SET
        status = COALESCE($2, status),
        message = COALESCE($3, message),
        branch_name = COALESCE($4, branch_name),
        pr_url = COALESCE($5, pr_url),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *;
    `,
    [id, patch.status ?? null, patch.message ?? null, patch.branchName ?? null, patch.prUrl ?? null]
  );
  if (!result.rows[0]) return undefined;
  return mapAutoFixRunRow(result.rows[0]);
}

export async function listRecentAutoFixRuns(limit = 50): Promise<AutoFixRun[]> {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;
  const result = await pool.query(
    `
      SELECT *
      FROM auto_fix_runs
      ORDER BY created_at DESC
      LIMIT $1;
    `,
    [normalizedLimit]
  );
  return result.rows.map(mapAutoFixRunRow);
}

export async function addAutoFixLog(
  runId: string,
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>
): Promise<AutoFixLog> {
  const result = await pool.query(
    `
      INSERT INTO auto_fix_logs (id, run_id, level, message, meta, created_at)
      VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::jsonb, NOW())
      RETURNING *;
    `,
    [runId, level, message, JSON.stringify(meta ?? {})]
  );
  return mapAutoFixLogRow(result.rows[0]);
}

export async function listAutoFixLogs(limit = 200, runId?: string): Promise<AutoFixLog[]> {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(2000, Math.floor(limit))) : 200;
  if (runId) {
    const result = await pool.query(
      `
        SELECT *
        FROM auto_fix_logs
        WHERE run_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT $2;
      `,
      [runId, normalizedLimit]
    );
    return result.rows.map(mapAutoFixLogRow);
  }

  const result = await pool.query(
    `
      SELECT *
      FROM auto_fix_logs
      ORDER BY created_at DESC
      LIMIT $1;
    `,
    [normalizedLimit]
  );
  return result.rows.map(mapAutoFixLogRow);
}

export async function closeStorage(): Promise<void> {
  await pool.end();
}
