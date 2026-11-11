import * as nodeHttp from "node:http";
import * as zlib from "node:zlib";
import { BSON } from "bson";

// Obico's http.tunnelv2 protocol, as implemented by moonraker-obico
// (tunnel.py, send_http_to_local_v2). Scope decided in ADR-0010.

export interface TunnelRequest {
  ref: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  data?: unknown;
  timeout?: number;
}

/** Fields of an agent WebSocket message the bridge reacts to. */
export interface AgentMessage {
  passthru?: unknown;
  commands?: unknown;
  janus?: unknown;
  "http.tunnelv2"?: TunnelRequest;
}

export interface TunnelResponse {
  status: number;
  body: Buffer;
  headers: Record<string, string>;
}

export interface TunnelOptions {
  localPort: number;
  bridgeUrl?: string;
}

// Obico sends JSON text frames, and BSON binary frames for messages with
// binary payloads (http.tunnelv2 requests, see obico-server consumers.py).
export function decodeAgentFrame(
  data: Buffer,
  isBinary: boolean
): AgentMessage {
  const msg: unknown = isBinary
    ? BSON.deserialize(data, { promoteBuffers: true })
    : JSON.parse(data.toString());
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return {};
  return msg as AgentMessage;
}

/** BSON frame in the shape moonraker-obico sends: raw, optionally zlib-compressed bytes. */
export function encodeTunnelResponse(ref: string, res: TunnelResponse): Buffer {
  const compressed = res.body.length >= 1000;
  return Buffer.from(
    BSON.serialize({
      "http.tunnelv2": {
        ref,
        response: {
          status: res.status,
          compressed,
          content: compressed ? zlib.deflateSync(res.body) : res.body,
          cookies: [],
          headers: res.headers,
        },
      },
    })
  );
}

const ALLOWED_METHODS = ["GET", "POST", "DELETE"];

// Endpoints proxied through the tunnel (ADR-0010). Obico itself calls none of
// the bridge's /api routes through the tunnel; only the read-only,
// OctoPrint-shaped file list is exposed. Everything else is LAN-only.
const ALLOWED_ENDPOINTS: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/api/files" },
];

/**
 * Returns the pathname of a tunnel path if it is in canonical form, else null.
 * Rejects traversal segments, encoded dots/slashes/backslashes/NUL, backslashes
 * and empty segments, so the matched path is the one Express routes.
 */
export function canonicalTunnelPathname(path: string): string | null {
  const pathname = path.split("?")[0];
  if (!pathname.startsWith("/")) return null;
  if (/%(2e|2f|5c|00)/i.test(pathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  const segments = decoded.split("/").slice(1);
  if (
    decoded !== "/" &&
    segments.some((s) => s === "" || s === "." || s === "..")
  )
    return null;
  return decoded;
}

function isAllowedEndpoint(method: string, pathname: string): boolean {
  return ALLOWED_ENDPOINTS.some(
    (e) => e.method === method && e.path === pathname
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function lanOnlyPage(bridgeUrl?: string): Buffer {
  const link = bridgeUrl
    ? `<p><a href="${escapeHtml(bridgeUrl)}/">Open SentryBridge on your LAN: ${escapeHtml(bridgeUrl)}/</a></p>`
    : "<p>Open the bridge at its LAN address.</p>";
  return Buffer.from(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>SentryBridge</title>` +
      `<style>body{font-family:sans-serif;max-width:40em;margin:3em auto;padding:0 1em}</style></head>` +
      `<body><h1>SentryBridge</h1>` +
      `<p>The SentryBridge web UI is only available on the local network (LAN). ` +
      `It is not exposed through the Obico tunnel.</p>${link}</body></html>`
  );
}

function text(status: number, body: string): TunnelResponse {
  return { status, body: Buffer.from(body), headers: {} };
}

function doLocalRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer | null,
  timeoutMs: number
): Promise<TunnelResponse> {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      { host: "127.0.0.1", port, path, method, headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const respHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") respHeaders[k] = v;
            else if (Array.isArray(v)) respHeaders[k] = v.join(", ");
          }
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            headers: respHeaders,
          });
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body && body.length > 0) req.write(body);
    req.end();
  });
}

export async function handleTunnelRequest(
  tunnel: TunnelRequest,
  options: TunnelOptions
): Promise<TunnelResponse> {
  const method = (tunnel.method ?? "GET").toUpperCase();
  const path = tunnel.path ?? "/";
  if (!ALLOWED_METHODS.includes(method)) {
    return text(405, "method not allowed");
  }
  const pathname = canonicalTunnelPathname(path);
  if (method === "GET" && pathname === "/") {
    return {
      status: 200,
      body: lanOnlyPage(options.bridgeUrl),
      headers: { "Content-Type": "text/html; charset=utf-8" },
    };
  }
  if (pathname === null || !isAllowedEndpoint(method, pathname)) {
    return text(403, "path not allowed");
  }

  // Drop any client Accept-Encoding: the response body goes back as raw bytes.
  // Drop Host, Origin and Sec-Fetch-*: the bridge makes this request itself,
  // and the request guard would reject Obico's values.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(tunnel.headers ?? {})) {
    const key = k.toLowerCase();
    if (
      key === "accept-encoding" ||
      key === "host" ||
      key === "origin" ||
      key.startsWith("sec-fetch-")
    )
      continue;
    headers[k] = v;
  }
  headers["Accept-Encoding"] = "identity";
  // Obico sends the request body as raw bytes (BSON binary)
  const body =
    Buffer.isBuffer(tunnel.data) && tunnel.data.length > 0 ? tunnel.data : null;
  const timeoutMs = Math.min((tunnel.timeout ?? 10) * 1000, 10_000);
  try {
    return await doLocalRequest(
      options.localPort,
      method,
      path,
      headers,
      body,
      timeoutMs
    );
  } catch (err) {
    const isTimeout =
      (err as NodeJS.ErrnoException)?.code === "ETIMEDOUT" ||
      (err as Error).message === "timeout";
    return text(isTimeout ? 504 : 502, String(err));
  }
}
