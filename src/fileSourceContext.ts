import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import unzipper from "unzipper";
import { SymbolicatedFrame } from "./types";

interface ParsedSymbolLocation {
  file: string;
  line: number;
}

function parseLocation(symbolicated: string): ParsedSymbolLocation | undefined {
  const match = symbolicated.match(/\(([^()]+\.(?:swift|m|mm|c|cc|cpp|h|hpp)):(\d+)\)$/i);
  if (!match) return undefined;

  return {
    file: match[1],
    line: Number(match[2]),
  };
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const entries = await fsPromises.readdir(root, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return listFilesRecursive(fullPath);
      }
      return [fullPath];
    })
  );

  return paths.flat();
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

async function findFileByBasename(root: string, basename: string): Promise<string | undefined> {
  const files = await listFilesRecursive(root);
  return files.find((filePath) => path.basename(filePath) === path.basename(basename));
}

export async function extractSourceArchive(zipPath: string, destinationRoot: string): Promise<{ extractedPath: string }> {
  await fsPromises.mkdir(destinationRoot, { recursive: true });
  const extractedPath = path.join(destinationRoot, path.basename(zipPath, ".zip"));
  await fsPromises.mkdir(extractedPath, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractedPath }))
      .on("close", resolve)
      .on("error", reject);
  });

  return { extractedPath };
}

export async function enrichWithFileSystemCodeContext(frames: SymbolicatedFrame[], sourceRoot: string): Promise<SymbolicatedFrame[]> {
  const out: SymbolicatedFrame[] = [];

  for (const frame of frames) {
    const location = parseLocation(frame.symbolicated);
    if (!location) {
      out.push(frame);
      continue;
    }

    const matchedFile = await findFileByBasename(sourceRoot, location.file);
    if (!matchedFile) {
      out.push(frame);
      continue;
    }

    const content = await fsPromises.readFile(matchedFile, "utf8");
    out.push({
      ...frame,
      codeContext: {
        file: matchedFile,
        line: location.line,
        snippet: extractSnippet(content, location.line, 3),
      },
    });
  }

  return out;
}
