import { AddressInfo } from "net";
import { WebSocketServer, WebSocket } from "ws";
import { createObicoAgent } from "../obico/agent";
import { PrusaLinkCommandDispatcher } from "../obico/types";

jest.mock("node:fs", () => ({
  ...jest.requireActual("node:fs"),
  existsSync: () => false,
}));

const dispatcher: PrusaLinkCommandDispatcher = {
  pause: jest.fn().mockResolvedValue(undefined),
  resume: jest.fn().mockResolvedValue(undefined),
  cancel: jest.fn().mockResolvedValue(undefined),
  startPrint: jest.fn().mockResolvedValue(undefined),
  uploadFile: jest.fn().mockResolvedValue(undefined),
} as unknown as PrusaLinkCommandDispatcher;

function listen(): Promise<WebSocketServer> {
  return new Promise((resolve) => {
    const wss: WebSocketServer = new WebSocketServer({ port: 0 }, () =>
      resolve(wss)
    );
  });
}

function portOf(wss: WebSocketServer): number {
  return (wss.address() as AddressInfo).port;
}

function close(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.terminate();
  return new Promise((resolve) => wss.close(() => resolve()));
}

describe("Janus signaling passthrough", () => {
  let obico: WebSocketServer;
  let janus: WebSocketServer;

  beforeEach(async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    obico = await listen();
    janus = await listen();
  });

  afterEach(async () => {
    await close(obico);
    await close(janus);
    jest.restoreAllMocks();
  });

  it("forwards messages that arrive while the Janus socket connects, over one socket", async () => {
    const janusConnections: WebSocket[] = [];
    const received: string[] = [];
    janus.on("connection", (socket) => {
      janusConnections.push(socket);
      socket.on("message", (data) => received.push(data.toString()));
    });
    obico.on("connection", (socket) => {
      // Back to back, so the second arrives before the first socket is open.
      socket.send(JSON.stringify({ janus: '{"janus":"keepalive","n":1}' }));
      socket.send(JSON.stringify({ janus: '{"janus":"keepalive","n":2}' }));
    });

    const agent = createObicoAgent(
      { serverUrl: `http://localhost:${portOf(obico)}`, apiKey: "key" },
      { fetch: jest.fn() },
      dispatcher
    );
    agent.setJanusUrl(`ws://localhost:${portOf(janus)}`);
    agent.connect();

    await new Promise((resolve) => setTimeout(resolve, 300));
    agent.disconnect();

    expect(janusConnections).toHaveLength(1);
    expect(received).toEqual([
      '{"janus":"keepalive","n":1}',
      '{"janus":"keepalive","n":2}',
    ]);
  });
  it("ignores null and non-string janus payloads", async () => {
    const janusConnections: WebSocket[] = [];
    const received: string[] = [];
    janus.on("connection", (socket) => {
      janusConnections.push(socket);
      socket.on("message", (data) => received.push(data.toString()));
    });
    obico.on("connection", (socket) => {
      socket.send(JSON.stringify({ janus: null }));
      socket.send(JSON.stringify({ janus: { janus: "keepalive" } }));
      socket.send(JSON.stringify({ janus: 42 }));
      socket.send(JSON.stringify({ janus: '{"janus":"keepalive","n":1}' }));
    });

    const agent = createObicoAgent(
      { serverUrl: `http://localhost:${portOf(obico)}`, apiKey: "key" },
      { fetch: jest.fn() },
      dispatcher
    );
    agent.setJanusUrl(`ws://localhost:${portOf(janus)}`);
    agent.connect();

    await new Promise((resolve) => setTimeout(resolve, 300));
    agent.disconnect();

    expect(janusConnections).toHaveLength(1);
    expect(received).toEqual(['{"janus":"keepalive","n":1}']);
  });
});
