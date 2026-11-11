import { Config, saveConfig, tryLoadConfig } from "../config/config";
import { assertRtspUrl, RtspUrlError } from "../config/rtsp";
import { mergeStoredSecrets } from "../config/secrets";
import { startBridge } from "../bridge";

/** The config to save, with empty secrets filled from the stored config. */
export function resolveSetup(body: Partial<Config>): Config {
  const merged = mergeStoredSecrets(body, tryLoadConfig());
  if (
    !merged.prusalink?.url ||
    !merged.prusalink?.username ||
    !merged.prusalink?.password ||
    !merged.camera?.rtspUrl ||
    !merged.obico?.serverUrl ||
    !merged.obico?.apiKey
  ) {
    throw new SetupError("All config fields are required");
  }
  try {
    assertRtspUrl(merged.camera.rtspUrl);
  } catch (err) {
    if (err instanceof RtspUrlError) throw new SetupError(err.message);
    throw err;
  }
  return {
    name: merged.name || undefined,
    prusalink: merged.prusalink,
    camera: {
      rtspUrl: merged.camera.rtspUrl,
      frameIntervalSeconds: merged.camera.frameIntervalSeconds ?? 10,
    },
    obico: merged.obico,
    polling: merged.polling ?? { statusIntervalMs: 5000 },
  };
}

/** Invalid setup input; maps to HTTP 400. */
export class SetupError extends Error {}

export function saveSetup(config: Config): void {
  saveConfig(config);
  startBridge().catch((err) =>
    console.error("[bridge] Failed to start after config save:", err)
  );
}
