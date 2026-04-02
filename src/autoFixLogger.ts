import { EventEmitter } from "node:events";
import { addAutoFixLog } from "./storage";
import { AutoFixLog } from "./types";

type LogListener = (log: AutoFixLog) => void;

const emitter = new EventEmitter();

export function onAutoFixLog(listener: LogListener): () => void {
  emitter.on("log", listener);
  return () => emitter.off("log", listener);
}

export async function writeAutoFixLog(
  runId: string,
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>
): Promise<AutoFixLog> {
  const log = await addAutoFixLog(runId, level, message, meta);
  emitter.emit("log", log);
  return log;
}
