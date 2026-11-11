import { isIP } from "node:net";
import type { RequestHandler } from "express";

// Protects the login-less bridge against requests a foreign website makes
// through a LAN user's browser: DNS rebinding (unknown Host) and cross-site
// writes (CSRF).

export interface GuardInput {
  method: string;
  host?: string;
  origin?: string;
  secFetchSite?: string;
}

export interface GuardDecision {
  allowed: boolean;
  reason?: string;
}

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Parses the comma-separated ALLOWED_HOSTS value into lower-case hostnames. */
export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/** Splits a Host header into hostname and port; null if malformed. */
function parseHost(host: string): { hostname: string; port: string } | null {
  const m = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/i.exec(host);
  if (!m) return null;
  return { hostname: m[1].toLowerCase(), port: m[2] ?? "" };
}

function isAllowedHostname(hostname: string, allowedHosts: string[]): boolean {
  if (hostname.startsWith("[")) return isIP(hostname.slice(1, -1)) === 6;
  if (isIP(hostname) === 4) return true;
  if (allowedHosts.includes(hostname)) return true;
  const labels = hostname.split(".");
  if (!labels.every((l) => LABEL.test(l))) return false;
  if (labels.length === 1) return hostname !== "local";
  return labels.length >= 2 && labels[labels.length - 1] === "local";
}

function sameOrigin(origin: string, host: { hostname: string; port: string }) {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname.toLowerCase() === host.hostname && url.port === host.port;
}

export function checkRequest(
  input: GuardInput,
  allowedHosts: string[]
): GuardDecision {
  const host = input.host ? parseHost(input.host) : null;
  if (!host || !isAllowedHostname(host.hostname, allowedHosts)) {
    return {
      allowed: false,
      reason:
        "Host not allowed. Access the bridge by IP address, localhost, a single-label hostname or a .local name, or add this hostname to the ALLOWED_HOSTS environment variable.",
    };
  }
  if (SAFE_METHODS.includes(input.method.toUpperCase()))
    return { allowed: true };

  const site = input.secFetchSite?.toLowerCase();
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return { allowed: false, reason: "Cross-site request rejected." };
  }
  if (input.origin !== undefined && !sameOrigin(input.origin, host)) {
    return { allowed: false, reason: "Cross-origin request rejected." };
  }
  return { allowed: true };
}

export function requestGuard(
  allowedHosts: string[] = parseAllowedHosts(process.env.ALLOWED_HOSTS)
): RequestHandler {
  return (req, res, next) => {
    const decision = checkRequest(
      {
        method: req.method,
        host: req.headers.host,
        origin: req.headers.origin,
        secFetchSite: req.get("sec-fetch-site"),
      },
      allowedHosts
    );
    if (decision.allowed) return next();
    res.status(403).json({ error: decision.reason });
  };
}
