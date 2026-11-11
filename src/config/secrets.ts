import { Config } from "./config";

/** Shows which secret is stored without revealing it: "***" + last 3 chars for secrets of 8+ chars. */
export function secretHint(secret: string): string {
  return secret.length >= 8 ? `***${secret.slice(-3)}` : "***";
}

export type PublicConfig = Omit<Config, "prusalink" | "obico"> & {
  prusalink: { url: string; username: string; passwordHint: string };
  obico: { serverUrl: string; apiKeyHint: string };
};

/** The config as the API may return it: secrets replaced by hints. */
export function toPublicConfig(config: Config): PublicConfig {
  const { password, ...prusalink } = config.prusalink;
  const { apiKey, ...obico } = config.obico;
  return {
    ...config,
    prusalink: { ...prusalink, passwordHint: secretHint(password ?? "") },
    obico: { ...obico, apiKeyHint: secretHint(apiKey ?? "") },
  };
}

export interface IncomingSecrets {
  prusalink?: { url?: string; username?: string; password?: string };
  obico?: { serverUrl?: string; apiKey?: string };
}

/** A secret was left empty but the stored one belongs to a different target. */
export class SecretFallbackError extends Error {}

function sameUrl(a?: string, b?: string): boolean {
  return !!a && !!b && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/**
 * Fills empty secrets from the stored config (the UI never receives them).
 * A stored secret is only reused for the target it was stored for: the
 * PrusaLink password for the same URL and username, the Obico API key for the
 * same server URL. Otherwise sending it elsewhere would leak it, so this
 * throws SecretFallbackError. Returns a new object; `incoming` is not changed.
 */
export function mergeStoredSecrets<T extends IncomingSecrets>(
  incoming: T,
  stored: Config | null
): T {
  const merged = { ...incoming };
  const pl = incoming.prusalink;
  if (pl && !pl.password && stored) {
    if (
      !sameUrl(pl.url, stored.prusalink.url) ||
      pl.username !== stored.prusalink.username
    ) {
      throw new SecretFallbackError(
        "A password is required when the PrusaLink URL or username changes"
      );
    }
    merged.prusalink = { ...pl, password: stored.prusalink.password };
  }
  const ob = incoming.obico;
  if (ob && !ob.apiKey && stored) {
    if (!sameUrl(ob.serverUrl, stored.obico.serverUrl)) {
      throw new SecretFallbackError(
        "A new API key is required when the Obico server URL changes; pair again"
      );
    }
    merged.obico = { ...ob, apiKey: stored.obico.apiKey };
  }
  return merged;
}
