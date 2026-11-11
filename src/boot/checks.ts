import { Config } from "../config/config";
import { ConnectionTestResult } from "../prusalink/types";

// Non-blocking startup diagnostics (#13). The bridge starts regardless; these
// results only tell the user what to fix. Hints are i18n keys, never raw error
// text, so no secret can leak into a result.

export type BootCheckId =
  | "prusalink_reachable"
  | "prusalink_auth"
  | "camera_rtsp"
  | "obico_reachable"
  | "obico_paired";

export type BootCheckHint =
  | "prusalinkUnreachable"
  | "prusalinkCredentials"
  | "cameraUnreachable"
  | "obicoUnreachable"
  | "obicoNotPaired";

export interface BootCheckResult {
  id: BootCheckId;
  ok: boolean;
  hint: BootCheckHint | null;
}

export interface BootCheckDeps {
  testPrusaLink(config: Config): Promise<ConnectionTestResult>;
  /** Resolves when the camera delivers a frame, rejects otherwise. */
  testCamera(camera: Config["camera"]): Promise<unknown>;
  /** Resolves when the server answers any HTTP response, rejects otherwise. */
  reachObico(serverUrl: string): Promise<void>;
}

// Defer each probe so a synchronous throw becomes a failed check.
const attempt = <T>(fn: () => Promise<T>) => Promise.resolve().then(fn);
const succeeds = (fn: () => Promise<unknown>) =>
  attempt(fn).then(
    () => true,
    () => false
  );

export async function runBootChecks(
  config: Config,
  deps: BootCheckDeps
): Promise<BootCheckResult[]> {
  const [prusa, cameraOk, obicoOk] = await Promise.all([
    attempt(() => deps.testPrusaLink(config)).catch(() => ({
      ok: false,
      reason: "unreachable" as const,
    })),
    succeeds(() => deps.testCamera(config.camera)),
    succeeds(() => deps.reachObico(config.obico.serverUrl)),
  ]);

  const reachable = prusa.ok || prusa.reason === "unauthorized";
  const check = (id: BootCheckId, ok: boolean, hint: BootCheckHint) => ({
    id,
    ok,
    hint: ok ? null : hint,
  });

  return [
    check("prusalink_reachable", reachable, "prusalinkUnreachable"),
    check(
      "prusalink_auth",
      prusa.ok,
      reachable ? "prusalinkCredentials" : "prusalinkUnreachable"
    ),
    check("camera_rtsp", cameraOk, "cameraUnreachable"),
    check("obico_reachable", obicoOk, "obicoUnreachable"),
    check("obico_paired", Boolean(config.obico.apiKey), "obicoNotPaired"),
  ];
}
