import WebSocket from "ws";
import { calculateDelay } from "../lib/retry";
import { resilienceConfig } from "../lib/env-config";
import { healthMonitor } from "../lib/health";
import { HealthState, ErrorSeverity } from "../lib/health-monitor";

export interface JanusRelay {
  start(): void;
  stop(): void;
}

/**
 * Bidirectional WebSocket relay between local Janus and Obico.
 *
 * Janus WS (ws://127.0.0.1:8188, janus-protocol)
 *   ↕
 * Obico   ({serverUrl}/ws/janus/{apiKey}/, token in URL path — JanusWebConsumer)
 *
 * Note: Obico's JanusWebConsumer does NOT parse Authorization headers.
 * Authentication is done via the auth_token in the URL path.
 */
export function createJanusRelay(
  janusWsUrl: string,
  obicoServerUrl: string,
  _printerId: number,
  apiKey: string
): JanusRelay {
  let janusWs: WebSocket | null = null;
  let obicoWs: WebSocket | null = null;
  let stopped = false;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  // Bumped on every connect()/stop(); handlers of older sockets become no-ops.
  let generation = 0;
  // Set when the Obico side dropped first; picks the health message.
  let obicoLost = false;

  // Token-based URL path: /ws/token/janus/{token}/ (JanusWebConsumer, no Auth header needed)
  const obicoUrl =
    obicoServerUrl.replace(/\/$/, "").replace(/^http/, "ws") +
    `/ws/token/janus/${apiKey}/`;

  function clearReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function isCurrent(gen: number): boolean {
    return gen === generation && !stopped;
  }

  // A socket still CONNECTING would emit "closed before the connection was
  // established" on close(); terminate() tears it down without that error.
  function closeSocket(ws: WebSocket | null): void {
    if (!ws) return;
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    } else {
      ws.close();
    }
  }

  function closeSockets(): void {
    closeSocket(janusWs);
    closeSocket(obicoWs);
    janusWs = null;
    obicoWs = null;
  }

  function scheduleReconnect(msg: string): void {
    healthMonitor.setState("janus_relay", HealthState.RECOVERING);
    healthMonitor.pushError("janus_relay", msg, ErrorSeverity.WARN);
    healthMonitor.incrementRestarts("janus_relay");
    const delay = calculateDelay(reconnectAttempt, resilienceConfig.retry);
    reconnectAttempt++;
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (stopped) return;
    const gen = ++generation;
    obicoLost = false;

    const janus = new WebSocket(janusWsUrl, "janus-protocol");
    janusWs = janus;
    obicoWs = null;

    janus.on("open", () => {
      if (!isCurrent(gen)) return;
      console.log("[janus-relay] Janus WS open");
      connectObico(gen, janus);
    });

    // Janus → Obico
    janus.on("message", (data) => {
      if (!isCurrent(gen)) return;
      if (obicoWs?.readyState === WebSocket.OPEN) obicoWs.send(data);
    });

    janus.on("error", (err) => {
      if (!isCurrent(gen)) return;
      console.error("[janus-relay] Janus WS error:", err.message);
    });

    janus.on("close", () => {
      if (!isCurrent(gen)) return;
      console.log("[janus-relay] Janus WS closed");
      // Retire this pair first so errors from sockets we tear down stay silent.
      generation++;
      closeSockets();
      scheduleReconnect(
        obicoLost ? "Obico WS connection lost" : "Janus WS connection lost"
      );
    });
  }

  function connectObico(gen: number, janus: WebSocket): void {
    const obico = new WebSocket(obicoUrl, "janus-protocol");
    obicoWs = obico;

    obico.on("open", () => {
      if (!isCurrent(gen)) return;
      console.log("[janus-relay] Obico WS open");
      // Only a full pair counts as recovered (#74).
      reconnectAttempt = 0;
      healthMonitor.setState("janus_relay", HealthState.HEALTHY);
    });

    // Obico → Janus
    obico.on("message", (data) => {
      if (!isCurrent(gen)) return;
      if (janus.readyState === WebSocket.OPEN) janus.send(data);
    });

    obico.on("error", (err) => {
      if (isCurrent(gen))
        console.error("[janus-relay] Obico WS error:", err.message);
    });

    // Janus close drives the reconnect; closing Janus here triggers it.
    obico.on("close", () => {
      if (!isCurrent(gen)) return;
      console.log("[janus-relay] Obico WS closed");
      obicoLost = true;
      janus.close();
    });
  }

  return {
    start(): void {
      clearReconnect();
      closeSockets();
      stopped = false;
      reconnectAttempt = 0;
      connect();
    },

    stop(): void {
      stopped = true;
      generation++;
      clearReconnect();
      closeSockets();
      healthMonitor.setState("janus_relay", HealthState.DOWN);
    },
  };
}
