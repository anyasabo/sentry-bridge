import * as fs from "node:fs";
import * as path from "node:path";

/** The start time the bridge assigned to a PrusaLink job id. */
export interface PrintStart {
  jobId: number;
  /** Unix seconds; sent to Obico as current_print_ts. */
  ts: number;
}

export interface PrintStartStore {
  load(): PrintStart | null;
  save(record: PrintStart): void;
}

/** print-state.json in the directory of the config file. */
export function printStartStorePath(): string {
  const configPath = process.env.CONFIG_PATH ?? "/config/config.json";
  return path.join(path.dirname(configPath), "print-state.json");
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
        return Number.isInteger(data?.jobId) && Number.isInteger(data?.ts)
          ? { jobId: data.jobId, ts: data.ts }
          : null;
      } catch {
        return null;
      }
    },
    save(record) {
      try {
        fs.writeFileSync(filePath, JSON.stringify(record), "utf-8");
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
