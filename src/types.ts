export type UUID = string;

export interface BinaryImage {
  name: string;
  uuid?: UUID;
  loadAddress?: string;
  path?: string;
}

export interface CrashFrame {
  index: number;
  imageName: string;
  address: string;
  symbol?: string;
}

export interface CrashPayload {
  appId: string;
  buildVersion: string;
  appVersion?: string;
  deviceModel?: string;
  osVersion?: string;
  timestamp?: string;
  incidentIdentifier?: string;
  crashedThread?: number;
  exceptionType?: string;
  exceptionCodes?: string;
  terminationReason?: string;
  rawReport?: string;
  binaryImages: BinaryImage[];
  frames: CrashFrame[];
  metadata?: Record<string, unknown>;
}

export type SourceType = "repo" | "local_dir" | "zip";

export interface SourceMappingRecord {
  id: string;
  appId: string;
  buildVersion: string;
  sourceType: SourceType;
  uploadedAt: string;
  repoUrl?: string;
  commitSha?: string;
  localPath?: string;
  zipPath?: string;
  extractedPath?: string;
}

export interface DSYMRecord {
  id: string;
  appId: string;
  buildVersion: string;
  uploadedAt: string;
  zipPath: string;
  extractedPath: string;
  dwarfPath: string;
  uuids: string[];
  repoUrl?: string;
  commitSha?: string;
  localSourceDir?: string;
}

export interface SymbolicatedFrame extends CrashFrame {
  symbolicated: string;
  codeContext?: {
    file: string;
    line: number;
    snippet: string[];
  };
}

export interface CrashRecord {
  id: string;
  receivedAt: string;
  payload: CrashPayload;
  symbolicatedFrames: SymbolicatedFrame[];
  dsym?: DSYMRecord;
}

export interface WebhookRule {
  id: string;
  name: string;
  appId: string;
  isActive: boolean;
  method: string;
  urlTemplate: string;
  authHeaderTemplate?: string;
  headersTemplate?: Record<string, string>;
  bodyTemplate?: string;
  contentType?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SystemSettings {
  id: string;
  autoFixEnabled: boolean;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  githubToken?: string;
  gitUserName?: string;
  gitUserEmail?: string;
  defaultBaseBranch?: string;
  fixBranchPrefix?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppRepoMapping {
  id: string;
  appId: string;
  repoUrl: string;
  baseBranch: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AutoFixRun {
  id: string;
  crashId: string;
  appId: string;
  status: "queued" | "running" | "success" | "failed" | "skipped";
  message?: string;
  branchName?: string;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutoFixLog {
  id: string;
  runId: string;
  level: "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}
