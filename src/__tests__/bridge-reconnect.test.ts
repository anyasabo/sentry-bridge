import request from "supertest";
import { app } from "../server";

// Mock reconnectComponent so tests never touch real bridge state
jest.mock("../bridge", () => ({
  __esModule: true,
  reconnectComponent: jest.fn(),
}));

import { reconnectComponent } from "../bridge";
const mockReconnect = reconnectComponent as jest.MockedFunction<
  typeof reconnectComponent
>;

describe("POST /api/bridge/reconnect", () => {
  beforeEach(() => {
    mockReconnect.mockReset();
    mockReconnect.mockResolvedValue(undefined);
  });

  test("returns 400 when component field is missing", async () => {
    const res = await request(app).post("/api/bridge/reconnect").send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/prusalink, obico, or camera/);
    expect(mockReconnect).not.toHaveBeenCalled();
  });

  test("returns 400 when component is not in allowlist", async () => {
    const res = await request(app)
      .post("/api/bridge/reconnect")
      .send({ component: "janus" });
    expect(res.status).toBe(400);
    expect(mockReconnect).not.toHaveBeenCalled();
  });

  test("returns 200 and calls reconnectComponent for prusalink", async () => {
    const res = await request(app)
      .post("/api/bridge/reconnect")
      .send({ component: "prusalink" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockReconnect).toHaveBeenCalledWith("prusalink");
  });

  test("passes 'obico' through to reconnectComponent (mapping is internal)", async () => {
    const res = await request(app)
      .post("/api/bridge/reconnect")
      .send({ component: "obico" });
    expect(res.status).toBe(200);
    expect(mockReconnect).toHaveBeenCalledWith("obico");
  });

  test("returns 500 when reconnectComponent throws", async () => {
    mockReconnect.mockRejectedValueOnce(new Error("boom"));
    const res = await request(app)
      .post("/api/bridge/reconnect")
      .send({ component: "camera" });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("boom");
  });
});

import { circuitBreakerRegistry } from "../lib/health";
import { createObicoAgent } from "../obico/agent";
import { createPrusaLinkClient } from "../prusalink/client";

describe("circuitBreakerRegistry — registration on creation", () => {
  beforeEach(() => {
    circuitBreakerRegistry.delete("prusalink");
    circuitBreakerRegistry.delete("obico_ws");
  });

  // The camera registers when its stream starts, not on creation, so a
  // one-off camera cannot replace it (see camera.test.ts).
  it("prusalink and obico_ws register their CB when created", () => {
    createPrusaLinkClient({
      baseUrl: "http://localhost:1",
      username: "u",
      password: "p",
    });
    createObicoAgent(
      {
        serverUrl: "http://localhost:1",
        apiKey: "k",
        streamUrl: "http://x/stream",
      },
      { fetch: jest.fn() } as any,
      { pause: jest.fn(), resume: jest.fn(), cancel: jest.fn() } as any
    );

    expect(circuitBreakerRegistry.get("prusalink")).toBeDefined();
    expect(circuitBreakerRegistry.get("obico_ws")).toBeDefined();
  });
});
