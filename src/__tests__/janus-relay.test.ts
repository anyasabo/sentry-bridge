import { WebSocketServer, WebSocket } from "ws";
import { AddressInfo } from "node:net";
import { createJanusRelay } from "../janus/relay";

function boundPort(wss: WebSocketServer): number {
  return (wss.address() as AddressInfo).port;
}

describe("createJanusRelay()", () => {
  let janusWss: WebSocketServer;
  let obicoWss: WebSocketServer;
  let janusPort: number;
  let obicoPort: number;

  beforeEach((done) => {
    janusWss = new WebSocketServer({ port: 0 });
    obicoWss = new WebSocketServer({ port: 0 });
    let ready = 0;
    const onListening = () => {
      if (++ready === 2) {
        janusPort = boundPort(janusWss);
        obicoPort = boundPort(obicoWss);
        done();
      }
    };
    janusWss.on("listening", onListening);
    obicoWss.on("listening", onListening);
  });

  afterEach((done) => {
    let closed = 0;
    const onClose = () => {
      if (++closed === 2) done();
    };
    janusWss.close(onClose);
    obicoWss.close(onClose);
  });

  it("relays messages from Janus → Obico", (done) => {
    const relay = createJanusRelay(
      `ws://127.0.0.1:${janusPort}`,
      `http://127.0.0.1:${obicoPort}`,
      99,
      "test-key"
    );

    let janusServerSocket: WebSocket | null = null;

    janusWss.on("connection", (ws) => {
      janusServerSocket = ws;
    });

    obicoWss.on("connection", (ws) => {
      ws.on("message", (data) => {
        expect(data.toString()).toBe('{"type":"janus"}');
        relay.stop();
        done();
      });
    });

    relay.start();

    setTimeout(() => {
      janusServerSocket?.send('{"type":"janus"}');
    }, 100);
  });

  it("relays messages from Obico → Janus", (done) => {
    const relay = createJanusRelay(
      `ws://127.0.0.1:${janusPort}`,
      `http://127.0.0.1:${obicoPort}`,
      99,
      "test-key"
    );

    let obicoServerSocket: WebSocket | null = null;

    obicoWss.on("connection", (ws) => {
      obicoServerSocket = ws;
    });

    janusWss.on("connection", (ws) => {
      ws.on("message", (data) => {
        expect(data.toString()).toBe('{"type":"obico"}');
        relay.stop();
        done();
      });
    });

    relay.start();

    setTimeout(() => {
      obicoServerSocket?.send('{"type":"obico"}');
    }, 100);
  });

  it("connects to Obico WS with janus-protocol subprotocol", (done) => {
    const relay = createJanusRelay(
      `ws://127.0.0.1:${janusPort}`,
      `http://127.0.0.1:${obicoPort}`,
      99,
      "key"
    );

    obicoWss.on("connection", (_ws, req) => {
      expect(req.headers["sec-websocket-protocol"]).toBe("janus-protocol");
      relay.stop();
      done();
    });

    relay.start();
  });

  it("uses auth token in Obico WS URL path (not Authorization header)", (done) => {
    const relay = createJanusRelay(
      `ws://127.0.0.1:${janusPort}`,
      `http://127.0.0.1:${obicoPort}`,
      99,
      "secret-token"
    );

    obicoWss.on("connection", (_ws, req) => {
      expect(req.url).toBe("/ws/token/janus/secret-token/");
      expect(req.headers["authorization"]).toBeUndefined();
      relay.stop();
      done();
    });

    relay.start();
  });
});
