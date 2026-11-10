import WebSocket from "ws";
import * as nodeHttp from "node:http";
import * as zlib from "node:zlib";
import { createReadStream, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin, basename as pathBasename } from "node:path";
import {
  ObicoAgent,
  ObicoAgentConfig,
  HttpFetcher,
  PrusaLinkCommandDispatcher,
  buildStatusMessage,
} from "./types";
import { PrinterStatus, JobInfo } from "../prusalink/types";
import {
  PrintStartStore,
  createFilePrintStartStore,
  printStartStorePath,
} from "./print-start-store";
import { createCircuitBreaker } from "../lib/circuit-breaker";
import { calculateDelay } from "../lib/retry";
import { resilienceConfig } from "../lib/env-config";
import { healthMonitor, circuitBreakerRegistry } from "../lib/health";
import { HealthState, ErrorSeverity } from "../lib/health-monitor";

export function createObicoAgent(
  config: ObicoAgentConfig,
  http: HttpFetcher,
  dispatcher: PrusaLinkCommandDispatcher,
  printStartStore: PrintStartStore = createFilePrintStartStore(
    printStartStorePath()
  )
): ObicoAgent {
  const cb = createCircuitBreaker(resilienceConfig.circuitBreaker);
  circuitBreakerRegistry.set("obico_ws", cb);

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disconnecting = false;
  let activePrintFileId: number | null = null;
  let lastPrintState: string | null = null;
  let cachedJob: JobInfo | null = null;
  let printStart = printStartStore.load();

  // Start time of the given PrusaLink job: the stored one if the job id matches,
  // otherwise now (a new print), persisted so a restarted bridge sends the same value.
  function printStartTsFor(job: JobInfo | null): number | null {
    if (job === null) return null;
    if (printStart?.jobId !== job.id) {
      printStart = { jobId: job.id, ts: Math.floor(Date.now() / 1000) };
      printStartStore.save(printStart);
    }
    return printStart.ts;
  }

  // Janus signaling — Obico sends {"janus": "<json>"} on the agent WS.
  // We forward to local Janus and send responses back on the same WS.
  let janusWsUrl: string | null = null;
  let janusWs: WebSocket | null = null;
  const janusQueue: string[] = [];

  function ensureJanusWs(): void {
    if (janusWs && janusWs.readyState === WebSocket.OPEN) return;
    if (!janusWsUrl) return;

    janusWs = new WebSocket(janusWsUrl, "janus-protocol");
    janusWs.on("open", () => {
      console.log(
        "[obico/janus] Local Janus WS open — flushing",
        janusQueue.length,
        "queued messages"
      );
      for (const msg of janusQueue) janusWs!.send(msg);
      janusQueue.length = 0;
    });
    janusWs.on("message", (data) => {
      // Forward Janus response back to Obico via agent WS
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ janus: data.toString() }));
      }
    });
    janusWs.on("close", () => {
      console.log("[obico/janus] Local Janus WS closed");
      janusWs = null;
    });
    janusWs.on("error", (err) =>
      console.error("[obico/janus] Local Janus WS error:", err.message)
    );
  }

  function handleJanus(jsonStr: string): void {
    ensureJanusWs();
    if (janusWs?.readyState === WebSocket.OPEN) {
      janusWs.send(jsonStr);
    } else {
      janusQueue.push(jsonStr);
    }
  }

  function wsUrl(serverUrl: string): string {
    return serverUrl.replace(/\/$/, "").replace(/^http/, "ws") + "/ws/dev/";
  }

  function apiUrl(serverUrl: string, path: string): string {
    return serverUrl.replace(/\/$/, "") + path;
  }

  let onOpenCallback: (() => void) | null = null;
  let reconnectAttempt = 0;

  function openWebSocket(url: string): void {
    cb.execute(
      () =>
        new Promise<void>((resolve, reject) => {
          ws = new WebSocket(url, {
            headers: { authorization: `bearer ${config.apiKey}` },
          });

          let settled = false;

          ws.on("open", () => {
            console.log("[obico] WebSocket connected to", url);
            reconnectAttempt = 0;
            healthMonitor.setState("obico_ws", HealthState.HEALTHY);
            if (onOpenCallback) onOpenCallback();
            if (!settled) {
              settled = true;
              resolve();
            }
          });

          ws.on("message", (data) => {
            console.log("[obico] ← received:", data.toString());
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const msg = JSON.parse(data.toString()) as any;
              if (msg.passthru) handlePassthru(msg.passthru);
              if (Array.isArray(msg.commands)) handleCommands(msg.commands);
              if (msg.janus) handleJanus(msg.janus);
              if (msg["http.tunnelv2"]) {
                handleHttpTunnel(msg["http.tunnelv2"]).catch((e) =>
                  console.error("[obico] handleHttpTunnel failed:", e)
                );
              }
            } catch {
              // ignore malformed messages
            }
          });

          ws.on("close", (code, reason) => {
            console.log(`[obico] WebSocket closed: ${code} ${reason}`);
            ws = null;
            if (!disconnecting) {
              const msg = `WebSocket closed (code ${code})`;
              healthMonitor.setState("obico_ws", HealthState.RECOVERING);
              healthMonitor.pushError("obico_ws", msg, ErrorSeverity.WARN);
              healthMonitor.incrementRestarts("obico_ws");
              scheduleReconnect(url);
            }
            if (!settled) {
              settled = true;
              reject(new Error(`WebSocket closed before open (code ${code})`));
            }
          });

          ws.on("error", (err) => {
            console.error("[obico] WebSocket error:", err.message);
            if (!settled) {
              settled = true;
              reject(err);
            }
          });
        })
    ).catch(() => {
      // CB open or initial connect failed — close handler only fires if ws was
      // created. If CB rejected before ws was created, schedule reconnect here.
      if (!disconnecting && !reconnectTimer) scheduleReconnect(url);
    });
  }

  function scheduleReconnect(url: string): void {
    const delay = calculateDelay(reconnectAttempt, resilienceConfig.retry);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => openWebSocket(url), delay);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function extractArgs(passthru: any): any {
    if (Array.isArray(passthru.args) && passthru.args.length > 0)
      return passthru.args[0];
    if (passthru.kwargs && typeof passthru.kwargs === "object")
      return passthru.kwargs;
    return {};
  }

  function sendPassthruAck(ref: string, ret: unknown): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ passthru: { ref, ret } }));
    }
  }

  function sendPassthruError(ref: string, error: string): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ passthru: { ref, error } }));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleStartLocalPrint(passthru: any): Promise<void> {
    const ref = passthru.ref;
    const args = extractArgs(passthru);
    try {
      if (!args.url || typeof args.url !== "string") {
        throw new Error("missing url in start_printer_local_print args");
      }
      const urlPath = new URL(args.url).pathname;
      const filename = pathBasename(urlPath);
      if (!filename) throw new Error("could not derive filename from url");
      await dispatcher.startPrint(filename);
      sendPassthruAck(ref, "Success");
    } catch (err) {
      sendPassthruError(ref, err instanceof Error ? err.message : String(err));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleDownloadAndPrint(passthru: any): Promise<void> {
    const ref = passthru.ref;
    const args = extractArgs(passthru);
    let tmpPath: string | null = null;
    try {
      const { url, safe_filename, id, filename } = args;
      if (!url || typeof url !== "string") throw new Error("missing url");
      if (!safe_filename || typeof safe_filename !== "string")
        throw new Error("missing safe_filename");

      // SSRF-Mitigation: only http/https allowed (commands come from authenticated WebSocket)
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(
          `unsafe download url (disallowed protocol): ${parsed.protocol}`
        );
      }

      // Path-Traversal-Mitigation: basename
      const cleanName = pathBasename(safe_filename);
      if (!cleanName || cleanName === "." || cleanName === "..") {
        throw new Error("invalid safe_filename after basename");
      }

      // Download into memory buffer and upload directly (no temp file needed)
      const res = await http.fetch(url, { method: "GET" });
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await dispatcher.uploadFile(cleanName, buf);

      await dispatcher.startPrint(cleanName);

      // PRINT-04: track fileId (only download-flow has an ID)
      if (typeof id === "number") activePrintFileId = id;

      sendPassthruAck(ref, { target_path: filename ?? cleanName });
    } catch (err) {
      sendPassthruError(ref, err instanceof Error ? err.message : String(err));
    } finally {
      if (tmpPath) {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
      }
    }
  }

  function doLocalRequest(
    port: number,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer | null,
    timeoutMs: number
  ): Promise<{
    status: number;
    body: Buffer;
    respHeaders: Record<string, string>;
  }> {
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
              respHeaders,
            });
          });
          res.on("error", reject);
        }
      );
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });
      req.on("error", reject);
      if (body && body.length > 0) {
        req.write(body);
      }
      req.end();
    });
  }

  function sendTunnelResponse(
    ref: string,
    status: number,
    body: Buffer,
    respHeaders: Record<string, string>
  ): void {
    const compressed = body.length >= 1000;
    const finalContent = compressed ? zlib.deflateSync(body) : body;
    const payload = {
      "http.tunnelv2": {
        ref,
        response: {
          status,
          compressed,
          content: finalContent.toString("base64"),
          cookies: [],
          headers: respHeaders,
        },
      },
    };
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  const ALLOWED_TUNNEL_METHODS = ["GET", "POST", "DELETE"] as const;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleHttpTunnel(tunnel: any): Promise<void> {
    const ref: string = tunnel.ref;
    const method: string = (tunnel.method ?? "GET").toUpperCase();
    const path: string = tunnel.path ?? "/";
    const headers: Record<string, string> = tunnel.headers ?? {};
    const timeoutMs = Math.min((tunnel.timeout ?? 10) * 1000, 10_000);

    // EoP-Mitigation (T-13-03 / Phase 14): Whitelist GET, POST, DELETE
    if (
      !ALLOWED_TUNNEL_METHODS.includes(
        method as (typeof ALLOWED_TUNNEL_METHODS)[number]
      )
    ) {
      sendTunnelResponse(ref, 405, Buffer.from("method not allowed"), {});
      return;
    }
    if (!path.startsWith("/api/")) {
      sendTunnelResponse(ref, 403, Buffer.from("path not allowed"), {});
      return;
    }

    // Decode optional request body (Obico sends base64 in tunnel.data for POST)
    let body: Buffer | null = null;
    if (typeof tunnel.data === "string" && tunnel.data.length > 0) {
      try {
        body = Buffer.from(tunnel.data, "base64");
      } catch {
        body = null;
      }
    }

    const port = config.localPort ?? 3000;
    try {
      const {
        status,
        body: respBody,
        respHeaders,
      } = await doLocalRequest(port, method, path, headers, body, timeoutMs);
      sendTunnelResponse(ref, status, respBody, respHeaders);
    } catch (err) {
      const isTimeout =
        (err as NodeJS.ErrnoException)?.code === "ETIMEDOUT" ||
        (err as Error).message === "timeout";
      const code = isTimeout ? 504 : 502;
      sendTunnelResponse(ref, code, Buffer.from(String(err)), {});
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleCommands(commands: any[]): void {
    for (const command of commands) {
      switch (command.cmd) {
        case "pause":
          dispatcher
            .pause()
            .catch((e) => console.error("[obico] pause failed:", e.message));
          break;
        case "resume":
          dispatcher
            .resume()
            .catch((e) => console.error("[obico] resume failed:", e.message));
          break;
        case "cancel":
          dispatcher
            .cancel()
            .catch((e) => console.error("[obico] cancel failed:", e.message));
          break;
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handlePassthru(passthru: any): void {
    if (passthru.target === "Printer") {
      switch (passthru.func) {
        case "pause":
          dispatcher
            .pause()
            .catch((e) => console.error("[obico] pause failed:", e.message));
          break;
        case "resume":
          dispatcher
            .resume()
            .catch((e) => console.error("[obico] resume failed:", e.message));
          break;
        case "cancel":
          dispatcher
            .cancel()
            .catch((e) => console.error("[obico] cancel failed:", e.message));
          break;
      }
      return;
    }
    if (
      passthru.target === "file_operations" &&
      passthru.func === "start_printer_local_print"
    ) {
      handleStartLocalPrint(passthru).catch((e) =>
        console.error("[obico] handleStartLocalPrint failed:", e)
      );
      return;
    }
    if (passthru.target === "file_downloader" && passthru.func === "download") {
      handleDownloadAndPrint(passthru).catch((e) =>
        console.error("[obico] handleDownloadAndPrint failed:", e)
      );
      return;
    }
  }

  return {
    connect(onOpen?: () => void): void {
      disconnecting = false;
      reconnectAttempt = 0;
      onOpenCallback = onOpen ?? null;
      healthMonitor.setState("obico_ws", HealthState.RECOVERING);
      openWebSocket(wsUrl(config.serverUrl));
    },

    disconnect(code: number = 1000): void {
      disconnecting = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.close(code);
        ws = null;
      }
      healthMonitor.setState("obico_ws", HealthState.DOWN);
    },

    async startPairing(serverUrl: string): Promise<string> {
      const res = await http.fetch(apiUrl(serverUrl, "/api/v1/octo/verify/"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`startPairing failed: ${res.status}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;
      return body.code as string;
    },

    async waitForPairing(
      serverUrl: string,
      code: string,
      timeoutMs = 120_000
    ): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      const url = `${apiUrl(serverUrl, "/api/v1/octo/verify/")}?code=${code}`;
      for (;;) {
        if (Date.now() >= deadline) {
          throw new Error("Pairing timed out after 120s");
        }
        const res = await http.fetch(url, { method: "POST" });
        if (res.status === 410) throw new Error("Pairing code expired");
        if (res.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const body = (await res.json()) as any;
          if (body.verified_at) return body.printer.auth_token as string;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    },

    sendStatus(status: PrinterStatus, job: JobInfo | null): void {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log(
          "[obico] sendStatus skipped — WS not open (state:",
          ws?.readyState,
          ")"
        );
        return;
      }

      // Cache the most recent job when available
      if (job !== null) {
        cachedJob = job;
      }

      const isActiveState =
        status.state === "PRINTING" ||
        status.state === "PAUSED" ||
        status.state === "ATTENTION" ||
        status.state === "FINISHING";
      const wasActiveState =
        lastPrintState === "PRINTING" ||
        lastPrintState === "PAUSED" ||
        lastPrintState === "ATTENTION";
      const isFinishingOrFinished =
        status.state === "FINISHING" || status.state === "FINISHED";
      const wasFinishingState =
        lastPrintState === "FINISHED" || lastPrintState === "FINISHING";

      // Reset AFTER sending — only when transitioning to true IDLE.
      // FINISHED is a long-lived state on Prusa Core One (printer waits for
      // user to acknowledge at panel before moving to IDLE). Every FINISHED
      // poll must keep the cached job context, otherwise file.name goes null
      // on subsequent ticks and Obico's UI flickers between "has file" and
      // "no file" → inconsistent display.
      const shouldResetAfterSend =
        (status.state === "IDLE" || status.state === "STOPPED") &&
        (wasActiveState || wasFinishingState);

      // During FINISHING or FINISHED, use cached job if no fresh job available
      const effectiveJob = job ?? (isFinishingOrFinished ? cachedJob : null);

      // Reset fileId only on true idle/stopped — not FINISHED/FINISHING (preserve for the finishing status message)
      if (
        (status.state === "IDLE" || status.state === "STOPPED") &&
        activePrintFileId !== null
      ) {
        activePrintFileId = null;
      }

      const msg = buildStatusMessage(
        status,
        effectiveJob,
        config.streamUrl,
        activePrintFileId,
        isActiveState ? printStartTsFor(effectiveJob) : null
      );
      const json = JSON.stringify(msg);

      if (isFinishingOrFinished) {
        console.log(
          "[obico] finishing/finished tick — effectiveJob source:",
          job !== null ? "fresh" : cachedJob !== null ? "cached" : "none",
          "file.name:",
          msg.status.job.file.name
        );
      }

      console.log(
        "[obico] sending status:",
        status.state,
        json.substring(0, 200)
      );
      ws.send(json);

      lastPrintState = status.state;

      // Reset print context AFTER sending — the Done tick needs full job context
      if (shouldResetAfterSend) {
        cachedJob = null;
      }
    },

    async sendFrame(jpeg: Buffer): Promise<void> {
      const form = new FormData();
      form.append(
        "pic",
        new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }),
        "pic.jpg"
      );
      await http.fetch(apiUrl(config.serverUrl, "/api/v1/octo/pic/"), {
        method: "POST",
        headers: { Authorization: `Token ${config.apiKey}` },
        body: form,
      });
    },

    async fetchPrinterId(): Promise<number | null> {
      try {
        const url = apiUrl(config.serverUrl, "/api/v1/octo/printer/");
        const res = await http.fetch(url, {
          headers: { Authorization: `Token ${config.apiKey}` },
        });
        if (!res.ok) return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = (await res.json()) as any;
        return typeof body.printer?.id === "number" ? body.printer.id : null;
      } catch {
        return null;
      }
    },

    setJanusUrl(url: string): void {
      janusWsUrl = url;
    },

    async updateAgentInfo(): Promise<void> {
      try {
        const url = apiUrl(config.serverUrl, "/api/v1/octo/printer/");
        const body = {
          agent_name: "moonraker_obico",
          agent_version: "2.1.0",
        };
        const res = await http.fetch(url, {
          method: "PATCH",
          headers: {
            Authorization: `Token ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          console.log(
            "[obico] Agent info updated (agent_name/agent_version/webcams)"
          );
        } else {
          console.warn("[obico] updateAgentInfo failed:", res.status);
        }
      } catch (err) {
        console.warn("[obico] updateAgentInfo error:", err);
      }
    },
  };
}
