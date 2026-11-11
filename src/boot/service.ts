import { Config, tryLoadConfig } from "../config/config";
import { createPrusaLinkClient } from "../prusalink/client";
import { createCamera } from "../camera/camera";
import { getCameraInstance } from "../camera/registry";
import { BootCheckDeps, BootCheckResult, runBootChecks } from "./checks";

export interface BootCheckReport {
  checkedAt: string | null;
  results: BootCheckResult[];
}

const OBICO_TIMEOUT_MS = 5000;
const MIN_FRAME_MAX_AGE_MS = 15_000;

// Same probes the setup wizard uses (PrusaLink testConnection, camera
// testStream); Obico only needs to answer any HTTP response. While the bridge
// camera runs, its recent frame is the evidence: a second RTSP session would
// compete with it on the printer.
const liveDeps: BootCheckDeps = {
  testPrusaLink: (c: Config) =>
    createPrusaLinkClient({
      baseUrl: c.prusalink.url,
      username: c.prusalink.username,
      password: c.prusalink.password,
    }).testConnection(),
  testCamera: async (camera) => {
    const running = getCameraInstance();
    if (!running) return createCamera(camera).testStream();
    const maxAgeMs = Math.max(
      MIN_FRAME_MAX_AGE_MS,
      3 * camera.frameIntervalSeconds * 1000
    );
    if (!running.latestFrame(maxAgeMs)) throw new Error("no recent frame");
  },
  reachObico: async (serverUrl) => {
    const res = await fetch(serverUrl, {
      signal: AbortSignal.timeout(OBICO_TIMEOUT_MS),
    });
    await res.body?.cancel();
  },
};

let report: BootCheckReport = { checkedAt: null, results: [] };
let inFlight: Promise<BootCheckReport> | null = null;

export function getBootCheckReport(): BootCheckReport {
  return report;
}

/** Runs all checks once; concurrent callers share the same run. Resolves
 *  null when the bridge is not configured. */
export function runAndStoreBootChecks(
  config: Config | null = tryLoadConfig()
): Promise<BootCheckReport | null> {
  if (!config) return Promise.resolve(null);
  if (!inFlight) {
    inFlight = runBootChecks(config, liveDeps)
      .then((results) => {
        report = { checkedAt: new Date().toISOString(), results };
        return report;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}
