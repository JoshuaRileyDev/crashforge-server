import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import unzipper from "unzipper";
import { CrashPayload, DSYMRecord, SymbolicatedFrame } from "./types";

async function runCommand(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
      }
    });
  });
}

async function findDsymAndDwarf(extractedPath: string): Promise<{ dsymDir: string; dwarfPath: string }> {
  const entries = await fs.readdir(extractedPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(extractedPath, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".dSYM")) {
      const dwarfDir = path.join(fullPath, "Contents", "Resources", "DWARF");
      const dwarfs = await fs.readdir(dwarfDir);
      if (!dwarfs.length) continue;
      return { dsymDir: fullPath, dwarfPath: path.join(dwarfDir, dwarfs[0]) };
    }

    if (entry.isDirectory()) {
      const nested = await findDsymAndDwarf(fullPath).catch(() => undefined);
      if (nested) return nested;
    }
  }

  throw new Error("Could not find a .dSYM bundle with DWARF symbols in uploaded zip");
}

export async function extractDSYM(zipPath: string, destinationRoot: string): Promise<{ extractedPath: string; dwarfPath: string; uuids: string[] }> {
  await fs.mkdir(destinationRoot, { recursive: true });
  const extractedPath = path.join(destinationRoot, path.basename(zipPath, ".zip"));
  await fs.mkdir(extractedPath, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const read = require("node:fs").createReadStream(zipPath);
    read
      .pipe(unzipper.Extract({ path: extractedPath }))
      .on("close", resolve)
      .on("error", reject);
  });

  const { dwarfPath } = await findDsymAndDwarf(extractedPath);
  const uuidRaw = await runCommand("xcrun", ["dwarfdump", "--uuid", dwarfPath]);
  const uuids = uuidRaw
    .split("\n")
    .map((line) => line.match(/UUID: ([A-F0-9-]+)/i)?.[1])
    .filter((v): v is string => Boolean(v));

  return { extractedPath, dwarfPath, uuids };
}

async function symbolicateFrame(frameAddress: string, imageLoadAddress: string | undefined, arch: string, dwarfPath: string): Promise<string> {
  if (!imageLoadAddress) {
    return "<missing loadAddress; cannot symbolicate frame>";
  }

  const primary = await runCommand("xcrun", [
    "atos",
    "-arch",
    arch,
    "-o",
    dwarfPath,
    "-l",
    imageLoadAddress,
    frameAddress,
  ]);

  if (primary && !/^0x[0-9a-f]+ \(in .+\)$/i.test(primary)) {
    return primary;
  }

  // Fallback: some frames resolve better without explicit load address.
  const secondary = await runCommand("xcrun", [
    "atos",
    "-arch",
    arch,
    "-o",
    dwarfPath,
    frameAddress,
  ]);

  return secondary || primary || "<unknown symbol>";
}

async function resolveDwarfPathForImage(dsym: DSYMRecord, imageName: string): Promise<string> {
  const dwarfDir = path.dirname(dsym.dwarfPath);
  const candidates = [imageName];

  if (imageName.endsWith(".debug.dylib")) {
    candidates.push(imageName.replace(/\.debug\.dylib$/, ""));
  } else {
    candidates.push(`${imageName}.debug.dylib`);
  }

  for (const candidate of candidates) {
    const candidatePath = path.join(dwarfDir, candidate);
    try {
      await fs.access(candidatePath);
      return candidatePath;
    } catch {
      // Try next candidate.
    }
  }

  return dsym.dwarfPath;
}

export async function symbolicateCrash(payload: CrashPayload, dsym: DSYMRecord): Promise<SymbolicatedFrame[]> {
  const defaultArch = "arm64";

  const frames = await Promise.all(
    payload.frames.map(async (frame): Promise<SymbolicatedFrame> => {
      const image = payload.binaryImages.find((i) => i.name === frame.imageName);

      try {
        const dwarfPath = await resolveDwarfPathForImage(dsym, frame.imageName);
        const symbolicated = await symbolicateFrame(frame.address, image?.loadAddress, defaultArch, dwarfPath);
        return { ...frame, symbolicated };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...frame, symbolicated: `<symbolication failed: ${message}>` };
      }
    })
  );

  return frames;
}
