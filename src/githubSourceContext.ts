import axios from "axios";
import path from "node:path";
import { config } from "./config";
import { SymbolicatedFrame } from "./types";

interface ParsedRepo {
  owner: string;
  repo: string;
}

interface ParsedSymbolLocation {
  file: string;
  line: number;
}

interface GitTreeNode {
  path: string;
  type: "blob" | "tree";
}

interface GithubTreeResponse {
  tree: GitTreeNode[];
}

interface GithubContentResponse {
  content?: string;
  encoding?: string;
}

function parseRepoUrl(repoUrl: string): ParsedRepo | undefined {
  const match = repoUrl.trim().match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) return undefined;
  return {
    owner: match[1],
    repo: match[2],
  };
}

function parseLocation(symbolicated: string): ParsedSymbolLocation | undefined {
  const match = symbolicated.match(/\(([^()]+\.(?:swift|m|mm|c|cc|cpp|h|hpp)):(\d+)\)$/i);
  if (!match) return undefined;

  return {
    file: match[1],
    line: Number(match[2]),
  };
}

function extractSnippet(source: string, lineNumber: number, radius: number): string[] {
  const lines = source.split("\n");
  const start = Math.max(1, lineNumber - radius);
  const end = Math.min(lines.length, lineNumber + radius);
  const snippet: string[] = [];

  for (let i = start; i <= end; i += 1) {
    const marker = i === lineNumber ? ">" : " ";
    snippet.push(`${marker}${i.toString().padStart(4, " ")} | ${lines[i - 1]}`);
  }

  return snippet;
}

function pickLikelyPath(nodes: GitTreeNode[], fileFromSymbol: string): string | undefined {
  const basename = path.basename(fileFromSymbol);
  const fileMatches = nodes.filter((n) => n.type === "blob" && path.basename(n.path) === basename);
  if (!fileMatches.length) return undefined;

  const normalizedSymbol = fileFromSymbol.replace(/\\/g, "/");
  const exactSuffix = fileMatches.find((n) => normalizedSymbol.endsWith(n.path));
  if (exactSuffix) return exactSuffix.path;

  return fileMatches.sort((a, b) => a.path.length - b.path.length)[0].path;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (config.githubToken) {
    headers.Authorization = `Bearer ${config.githubToken}`;
  }

  return headers;
}

async function fetchTree(owner: string, repo: string, commitSha: string): Promise<GitTreeNode[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${commitSha}`;
  const response = await axios.get<GithubTreeResponse>(url, {
    params: { recursive: 1 },
    headers: githubHeaders(),
    timeout: 20_000,
  });

  return response.data.tree || [];
}

async function fetchFileContent(owner: string, repo: string, filePath: string, commitSha: string): Promise<string | undefined> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`;
  const response = await axios.get<GithubContentResponse>(url, {
    params: { ref: commitSha },
    headers: githubHeaders(),
    timeout: 20_000,
  });

  if (response.data.encoding === "base64" && response.data.content) {
    return Buffer.from(response.data.content, "base64").toString("utf8");
  }

  return undefined;
}

export async function enrichWithGithubCodeContext(
  frames: SymbolicatedFrame[],
  repoUrl: string,
  commitSha: string
): Promise<SymbolicatedFrame[]> {
  const parsedRepo = parseRepoUrl(repoUrl);
  if (!parsedRepo) return frames;

  let tree: GitTreeNode[] = [];
  try {
    tree = await fetchTree(parsedRepo.owner, parsedRepo.repo, commitSha);
  } catch {
    return frames;
  }

  const out: SymbolicatedFrame[] = [];
  for (const frame of frames) {
    const location = parseLocation(frame.symbolicated);
    if (!location) {
      out.push(frame);
      continue;
    }

    const matchedPath = pickLikelyPath(tree, location.file);
    if (!matchedPath) {
      out.push(frame);
      continue;
    }

    try {
      const content = await fetchFileContent(parsedRepo.owner, parsedRepo.repo, matchedPath, commitSha);
      if (!content) {
        out.push(frame);
        continue;
      }

      out.push({
        ...frame,
        codeContext: {
          file: `${repoUrl.replace(/\.git$/, "")}/blob/${commitSha}/${matchedPath}`,
          line: location.line,
          snippet: extractSnippet(content, location.line, 3),
        },
      });
    } catch {
      out.push(frame);
    }
  }

  return out;
}
