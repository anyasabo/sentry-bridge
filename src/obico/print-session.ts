import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { configPath } from "../config/config";

/**
 * The print Obico is following: PrusaLink's job id and the `current_print_ts` sent for it.
 *
 * Obico treats a new `current_print_ts` as a new print. Keeping the pair on disk lets a restarted
 * bridge (a container restart, a redeploy, a recreated agent) send the same timestamp for the same
 * job, so Obico keeps one print instead of splitting it in two. The printer keeps its job counter
 * in EEPROM, so a job id is not reused after a printer reboot.
 */
export interface PrintSession {
  jobId: number;
  startTs: number;
}

export interface PrintSessionStore {
  load(): PrintSession | null;
  save(session: PrintSession): void;
  clear(): void;
}

/** A JSON file. Errors are logged and never thrown: losing the session only costs a split print. */
export function filePrintSessionStore(
  // Beside the config file, so it lives in the same persisted volume.
  path: string = join(dirname(configPath()), "print-session.json")
): PrintSessionStore {
  return {
    load() {
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        if (Number.isInteger(data?.jobId) && Number.isInteger(data?.startTs)) {
          return { jobId: data.jobId, startTs: data.startTs };
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(
            "[obico] print session unreadable, starting a new one:",
            (err as Error).message
          );
        }
      }
      return null;
    },
    save(session) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(session));
        renameSync(tmp, path);
      } catch (err) {
        console.warn(
          "[obico] could not save print session:",
          (err as Error).message
        );
      }
    },
    clear() {
      try {
        rmSync(path, { force: true });
      } catch (err) {
        console.warn(
          "[obico] could not clear print session:",
          (err as Error).message
        );
      }
    },
  };
}
