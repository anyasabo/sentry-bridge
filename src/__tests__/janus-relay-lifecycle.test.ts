import { AddressInfo } from "net";
import { WebSocketServer } from "ws";
import { createJanusRelay } from "../janus/relay";

import { healthMonitor } from "../lib/health";
import { HealthState } from "../lib/health-monitor";

const delayAttempts: number[] = [];
jest.mock("../lib/retry", () => ({
  calculateDelay: (attempt: number) => {
    delayAttempts.push(attempt);
    return 20;
  },
}));

function listen(): Promise<WebSocketServer> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("listening", () => resolve(wss));
  });
}

function portOf(wss: WebSocketServer): number {
  return (wss.address() as AddressInfo).port;
}

function closeServer(wss: WebSocketServer): Promise<void> {
  wss.clients.forEach((c) => c.terminate());
  return new Promise((resolve) => wss.close(() => resolve()));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await wait(5);
  }
}

describe("createJanusRelay() lifecycle", () => {
  let janusWss: WebSocketServer;
  let obicoWss: WebSocketServer;

  beforeEach(async () => {
    delayAttempts.length = 0;
    janusWss = await listen();
    obicoWss = await listen();
  });

  afterEach(async () => {
    await closeServer(janusWss);
    await closeServer(obicoWss);
  });

  function makeRelay(janusPort = portOf(janusWss)) {
    return createJanusRelay(
      `ws://127.0.0.1:${janusPort}`,
      `http://127.0.0.1:${portOf(obicoWss)}`,
      1,
      "key"
    );
  }

  it("does not open an Obico connection while Janus is unreachable", async () => {
    const deadPort = portOf(janusWss);
    await closeServer(janusWss);
    let obicoConnections = 0;
    obicoWss.on("connection", () => obicoConnections++);

    const relay = makeRelay(deadPort);
    relay.start();
    await waitFor(() => delayAttempts.length >= 3);
    relay.stop();

    expect(obicoConnections).toBe(0);
    janusWss = await listen();
  });

  it("stop() cancels a pending reconnect so stop()+start() yields one connection pair", async () => {
    let janusConnections = 0;
    let obicoConnections = 0;
    let firstJanusSocket: import("ws").WebSocket | null = null;
    janusWss.on("connection", (ws) => {
      janusConnections++;
      if (janusConnections === 1) firstJanusSocket = ws;
    });
    obicoWss.on("connection", () => obicoConnections++);

    const relay = makeRelay();
    relay.start();
    // Drop Janus only once the first pair is fully established.
    await waitFor(() => obicoConnections === 1 && firstJanusSocket !== null);
    firstJanusSocket!.close();
    await waitFor(() => delayAttempts.length === 1); // reconnect pending
    relay.stop();
    relay.start();
    await waitFor(() => janusConnections === 2 && obicoConnections === 2);
    await wait(100); // a leaked reconnect (20 ms delay) would show up here
    relay.stop();

    expect(janusConnections).toBe(2);
    expect(obicoConnections).toBe(2);
  });

  it("reconnects after the Janus WS drops", async () => {
    let janusConnections = 0;
    janusWss.on("connection", (ws) => {
      janusConnections++;
      if (janusConnections === 1) ws.close();
    });

    const relay = makeRelay();
    relay.start();
    await waitFor(() => janusConnections === 2);
    relay.stop();

    expect(janusConnections).toBe(2);
  });

  it("backs off and stays RECOVERING while Obico is unreachable and Janus is up", async () => {
    const deadObicoPort = portOf(obicoWss);
    await closeServer(obicoWss);
    const states: HealthState[] = [];
    const onChange = (e: { component: string; state: HealthState }) => {
      if (e.component === "janus_relay") states.push(e.state);
    };
    healthMonitor.on("change", onChange);

    const relay = createJanusRelay(
      `ws://127.0.0.1:${portOf(janusWss)}`,
      `http://127.0.0.1:${deadObicoPort}`,
      1,
      "key"
    );
    relay.start();
    await waitFor(() => delayAttempts.length >= 3);
    relay.stop();
    healthMonitor.off("change", onChange as (...args: unknown[]) => void);

    expect(delayAttempts.slice(0, 3)).toEqual([0, 1, 2]);
    expect(states).not.toContain(HealthState.HEALTHY);
    expect(
      healthMonitor
        .getComponentStats("janus_relay")
        .lastErrors.some((e) => e.msg === "Obico WS connection lost")
    ).toBe(true);
    obicoWss = await listen();
  });
});
