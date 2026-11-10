import * as fs from "node:fs";
import * as path from "node:path";
import { configPath } from "../config/config";

/** The start time the bridge assigned to a PrusaLink job id. */
export interface PrintStart {
  jobId: number;
  /** Unix seconds; sent to Obico as current_print_ts. */
  ts: number;
  /** Set once -1 was sent: Obico refuses this ts again, so the job id needs a new one. */
  ended?: boolean;
}

export interface PrintStartStore {
  load(): PrintStart | null;
  save(record: PrintStart): void;
}

/** print-state.json in the directory of the config file. */
export function printStartStorePath(): string {
  return path.join(path.dirname(configPath()), "print-state.json");
}

/** Keeps the PrintStart in memory only, e.g. for the pairing agent. */
export function createMemoryPrintStartStore(): PrintStartStore {
  let current: PrintStart | null = null;
  return {
    load: () => current,
    save: (record) => {
      current = record;
    },
  };
}

/**
 * Keeps the last PrintStart in a JSON file so it survives a restart of the bridge.
 * A missing or corrupt file loads as null; a failed write is logged, not thrown.
 */
export function createFilePrintStartStore(filePath: string): PrintStartStore {
  return {
    load() {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (!Number.isInteger(data?.jobId) || !Number.isInteger(data?.ts))
          return null;
        return data.ended === true
          ? { jobId: data.jobId, ts: data.ts, ended: true }
          : { jobId: data.jobId, ts: data.ts };
      } catch {
        return null;
      }
    },
    save(record) {
      // Write a temp file in the same directory, then rename: a crash mid-write
      // never leaves a truncated print-state.json behind.
      const tmpPath = `${filePath}.tmp`;
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(record), "utf-8");
        fs.renameSync(tmpPath, filePath);
      } catch (err) {
        console.error(
          "[obico] could not save print start to",
          filePath,
          (err as Error).message
        );
      }
    },
  };
}
