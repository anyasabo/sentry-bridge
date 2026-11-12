import DigestFetch from "digest-fetch";
import {
  ConnectionTestResult,
  FileEntry,
  JobInfo,
  PrinterStatus,
  PrusaLinkClient,
  PrusaLinkConfig,
} from "./types";
import { createCircuitBreaker } from "../lib/circuit-breaker";
import { resilienceConfig } from "../lib/env-config";
import { healthMonitor, circuitBreakerRegistry } from "../lib/health";
import {
  HealthState,
  ErrorSeverity,
  markReported,
} from "../lib/health-monitor";
import { withRetry } from "../lib/retry";

export interface HttpFetcher {
  fetch(url: string, options?: RequestInit): Promise<Response>;
}

function createDigestFetcher(username: string, password: string): HttpFetcher {
  const client = new DigestFetch(username, password);
  return { fetch: (url, opts) => client.fetch(url, opts ?? {}) };
}

export interface PrusaLinkClientOptions {
  /** Per-request timeout in ms (default 10 s). */
  timeoutMs?: number;
  /** Timeout for file uploads in ms (default 10 min; uploads may be large). */
  uploadTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 600_000;

class ServerErrorResponse extends Error {
  constructor(readonly response: Response) {
    super(`PrusaLink HTTP ${response.status}`);
  }
}

interface RequestOptions {
  init?: RequestInit;
  timeoutMs?: number;
  /** Parse a 2xx JSON body (except 204) within the request timeout. */
  json?: boolean;
}

interface PrusaLinkResponse {
  res: Response;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
}

/**
 * Fetches and, if requested, reads the body under one timeout, so a printer
 * that sends headers and then stalls the body is aborted as well.
 */
async function fetchWithTimeout(
  http: HttpFetcher,
  url: string,
  opts: RequestInit,
  timeoutMs: number,
  json: boolean
): Promise<PrusaLinkResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`PrusaLink request timed out after ${timeoutMs} ms`));
      controller.abort();
    }, timeoutMs);
  });
  const exchange = (async (): Promise<PrusaLinkResponse> => {
    const res = await http.fetch(url, { ...opts, signal: controller.signal });
    if (res.status >= 500) {
      // Release the socket; callers only need the status.
      res.body?.cancel().catch(() => {});
      throw new ServerErrorResponse(res);
    }
    if (json && res.ok && res.status !== 204) {
      return { res, body: await res.json() };
    }
    return { res };
  })();
  // The losing side of the race must not surface as an unhandled rejection.
  exchange.catch(() => {});
  try {
    // Race as well as abort, so a fetcher that ignores the signal cannot hang us.
    return await Promise.race([exchange, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createPrusaLinkClient(
  config: PrusaLinkConfig,
  fetcher?: HttpFetcher,
  options: PrusaLinkClientOptions = {}
): PrusaLinkClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  const http = fetcher ?? createDigestFetcher(config.username, config.password);
  const base = config.baseUrl.replace(/\/$/, "");
  const cb = createCircuitBreaker(resilienceConfig.circuitBreaker);
  circuitBreakerRegistry.set("prusalink", cb);

  async function send(
    method: string,
    path: string,
    { init, timeoutMs: timeout = timeoutMs, json = false }: RequestOptions = {}
  ): Promise<PrusaLinkResponse> {
    try {
      // 5xx means PrusaLink itself is failing and counts toward the breaker.
      // 4xx (401, 404, 409, ...) are caller/state errors: the printer is
      // reachable, so they are returned to the caller and do not trip it.
      const result = await cb.execute(() =>
        fetchWithTimeout(
          http,
          `${base}${path}`,
          { method, ...init },
          timeout,
          json
        )
      );
      healthMonitor.setState("prusalink", HealthState.HEALTHY);
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      if (err instanceof ServerErrorResponse) {
        // The printer answered, so it is degraded rather than down. The
        // failure is already counted by the breaker; the caller maps the status.
        healthMonitor.setState("prusalink", HealthState.DEGRADED);
        healthMonitor.pushError("prusalink", msg, ErrorSeverity.ERROR);
        return { res: err.response };
      }
      healthMonitor.setState("prusalink", HealthState.DOWN);
      healthMonitor.pushError(
        "prusalink",
        msg,
        msg === "Circuit breaker is OPEN"
          ? ErrorSeverity.WARN
          : ErrorSeverity.ERROR
      );
      throw markReported(err as Error);
    }
  }

  async function request(
    method: string,
    path: string,
    opts?: RequestOptions
  ): Promise<Response> {
    return (await send(method, path, opts)).res;
  }

  function getJson(path: string): Promise<PrusaLinkResponse> {
    return send("GET", path, { json: true });
  }

  /** Error for a non-2xx status; a 5xx was already reported by send(). */
  function statusError(op: string, res: Response): Error {
    const err = new Error(`${op} failed: ${res.status}`);
    return res.status >= 500 ? markReported(err) : err;
  }

  function get(path: string): Promise<Response> {
    return request("GET", path);
  }

  async function getJobId(): Promise<number> {
    const { res, body } = await getJson("/api/v1/job");
    if (res.status === 204) throw new Error("No active job");
    if (!res.ok) throw statusError("getJob", res);
    return body.id as number;
  }

  return {
    async getInfo() {
      const { res, body } = await getJson("/api/v1/info");
      if (!res.ok) throw new Error(`getInfo failed: ${res.status}`);
      return { hostname: body.hostname as string };
    },

    async testConnection(): Promise<ConnectionTestResult> {
      try {
        const res = await get("/api/v1/info");
        if (res.status === 401)
          return {
            ok: false,
            reason: "unauthorized",
            error: "Auth failed (401)",
          };
        if (!res.ok)
          return {
            ok: false,
            reason: "unreachable",
            error: `HTTP ${res.status}`,
          };
        return { ok: true };
      } catch (err: unknown) {
        return {
          ok: false,
          reason: "unreachable",
          error: (err as Error).message,
        };
      }
    },

    async getStatus(): Promise<PrinterStatus> {
      const { res, body } = await getJson("/api/v1/status");
      if (!res.ok) throw new Error(`getStatus failed: ${res.status}`);
      const p = body.printer;
      return {
        state: p.state,
        tempBed: p.temp_bed,
        targetBed: p.target_bed,
        tempNozzle: p.temp_nozzle,
        targetNozzle: p.target_nozzle,
        axisZ: p.axis_z,
        axisX: p.axis_x,
        axisY: p.axis_y,
        flow: p.flow,
        speed: p.speed,
        fanHotend: p.fan_hotend,
        fanPrint: p.fan_print,
      };
    },

    async getJob(): Promise<JobInfo | null> {
      const { res, body } = await getJson("/api/v1/job");
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`getJob failed: ${res.status}`);
      return {
        id: body.id,
        state: body.state,
        progress: body.progress,
        timePrinting: body.time_printing,
        timeRemaining: body.time_remaining,
        fileName: body.file?.name ?? null,
        displayName: body.file?.display_name ?? null,
        currentLayer: body.current_layer ?? null,
        totalLayers: body.total_layers ?? null,
        posZMm: body.pos_z_mm ?? null,
      };
    },

    async pause(): Promise<void> {
      const id = await getJobId();
      const res = await request("PUT", `/api/v1/job/${id}/pause`);
      if (res.status === 409)
        throw new Error("Conflict: invalid state transition");
      if (!res.ok) throw statusError("pause", res);
    },

    async resume(): Promise<void> {
      const id = await getJobId();
      const res = await request("PUT", `/api/v1/job/${id}/resume`);
      if (res.status === 409)
        throw new Error("Conflict: invalid state transition");
      if (!res.ok) throw statusError("resume", res);
    },

    async cancel(): Promise<void> {
      const id = await getJobId();
      const res = await request("DELETE", `/api/v1/job/${id}`);
      if (res.status === 409)
        throw new Error("Conflict: invalid state transition");
      if (!res.ok) throw statusError("cancel", res);
    },

    async listFiles(): Promise<FileEntry[]> {
      const { res, body } = await getJson("/api/v1/files/usb/");
      if (!res.ok) throw new Error(`listFiles failed: ${res.status}`);
      const children: any[] = body.children ?? [];
      return children
        .filter((f: any) => f.type === "PRINT_FILE")
        .map((f: any): FileEntry => ({
          name: f.name,
          displayName: (f.display_name as string) ?? (f.name as string),
          path: `/usb/${f.name}`,
          size: f.size ?? 0,
          date: new Date((f.m_timestamp ?? 0) * 1000).toISOString(),
        }));
    },

    async uploadFile(filename: string, data: Buffer): Promise<void> {
      const res = await request("PUT", `/api/v1/files/usb/${filename}`, {
        init: {
          body: data,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(data.byteLength),
          },
        },
        timeoutMs: uploadTimeoutMs,
      });
      if (!res.ok) throw new Error(`uploadFile failed: ${res.status}`);
    },

    async startPrint(filename: string): Promise<void> {
      await withRetry(
        async () => {
          const res = await request("HEAD", `/api/v1/files/usb/${filename}`);
          if (!res.ok) throw new Error(`file not indexed yet: ${res.status}`);
        },
        { maxAttempts: 10, baseDelayMs: 500, maxDelayMs: 500, jitter: false }
      );
      const res = await request("POST", `/api/v1/files/usb/${filename}`);
      if (!res.ok) throw new Error(`startPrint failed: ${res.status}`);
    },

    async deleteFile(filename: string): Promise<void> {
      const res = await request("DELETE", `/api/v1/files/usb/${filename}`);
      if (!res.ok) throw new Error(`deleteFile failed: ${res.status}`);
    },
  };
}
