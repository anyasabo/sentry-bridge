import * as fs from "fs";
import * as os from "os";
import { EventEmitter } from "events";

export const configEmitter = new EventEmitter();

export interface Config {
  name?: string;
  prusalink: { url: string; username: string; password: string };
  camera: { rtspUrl: string; frameIntervalSeconds: number };
  obico: { serverUrl: string; apiKey: string };
  polling: { statusIntervalMs: number };
  shutdown?: { ffmpegKillTimeoutSeconds: number };
  bridgeUrl?: string;
}

export function detectBridgeUrl(port: number): string {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        return `http://${addr.address}:${port}`;
      }
    }
  }
  return `http://localhost:${port}`;
}

export function getBridgeUrl(config: Config, port: number): string {
  return config.bridgeUrl ?? detectBridgeUrl(port);
}

function configPath(): string {
  return process.env.CONFIG_PATH ?? "/config/config.json";
}

export function loadConfig(): Config {
  const filePath = configPath();

  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf-8");

  try {
    return JSON.parse(raw) as Config;
  } catch {
    throw new Error(`Config file contains invalid JSON: ${filePath}`);
  }
}

export function saveConfig(config: Config): void {
  const filePath = configPath();
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
  configEmitter.emit("config-changed", config);
}

export function isConfigured(): boolean {
  try {
    const config = loadConfig();
    return !!(
      config.prusalink?.url &&
      config.prusalink?.username &&
      config.prusalink?.password &&
      config.camera?.rtspUrl &&
      config.obico?.serverUrl &&
      config.obico?.apiKey
    );
  } catch {
    return false;
  }
}
