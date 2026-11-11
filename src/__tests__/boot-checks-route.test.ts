import request from "supertest";

const mockConfig = {
  prusalink: { url: "http://printer", username: "maker", password: "pw" },
  camera: { rtspUrl: "rtsp://printer/live", frameIntervalSeconds: 10 },
  obico: { serverUrl: "http://obico", apiKey: "key" },
};
let mockConfigured = true;

jest.mock("../config/config", () => ({
  ...jest.requireActual("../config/config"),
  tryLoadConfig: () => (mockConfigured ? mockConfig : null),
}));
jest.mock("../prusalink/client", () => ({
  createPrusaLinkClient: () => ({
    testConnection: async () => ({
      ok: false,
      reason: "unauthorized",
      error: "Auth failed (401)",
    }),
  }),
}));
const mockTestStream = jest.fn();
jest.mock("../camera/camera", () => ({
  createCamera: () => ({ testStream: mockTestStream }),
}));
let mockRunningCamera: { latestFrame: () => Buffer | null } | null = null;
jest.mock("../camera/registry", () => ({
  getCameraInstance: () => mockRunningCamera,
}));

import { app } from "../server";

beforeEach(() => {
  mockConfigured = true;
  mockRunningCamera = null;
  mockTestStream.mockReset().mockResolvedValue(Buffer.from("jpeg"));
  global.fetch = jest.fn().mockResolvedValue({ status: 200 }) as never;
});

describe("/api/boot-checks", () => {
  it("returns no results before the first run", async () => {
    const res = await request(app).get("/api/boot-checks");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ checkedAt: null, results: [] });
  });

  it("POST re-runs the checks and GET returns the latest results", async () => {
    const post = await request(app).post("/api/boot-checks");
    expect(post.status).toBe(200);
    expect(post.body.checkedAt).toEqual(expect.any(String));
    const auth = post.body.results.find(
      (r: { id: string }) => r.id === "prusalink_auth"
    );
    expect(auth).toEqual({
      id: "prusalink_auth",
      ok: false,
      hint: "prusalinkCredentials",
    });

    const get = await request(app).get("/api/boot-checks");
    expect(get.body).toEqual(post.body);
  });

  const cameraCheck = async () =>
    (await request(app).post("/api/boot-checks")).body.results.find(
      (r: { id: string }) => r.id === "camera_rtsp"
    );

  it("uses the running camera's recent frame instead of a second RTSP session", async () => {
    mockRunningCamera = { latestFrame: () => Buffer.from("jpeg") };
    expect((await cameraCheck()).ok).toBe(true);
    expect(mockTestStream).not.toHaveBeenCalled();
  });

  it("fails the camera check when the running camera has no recent frame", async () => {
    mockRunningCamera = { latestFrame: () => null };
    expect((await cameraCheck()).ok).toBe(false);
    expect(mockTestStream).not.toHaveBeenCalled();
  });

  it("probes the stream when no bridge camera runs", async () => {
    mockTestStream.mockRejectedValue(new Error("ffmpeg failed"));
    expect((await cameraCheck()).ok).toBe(false);
    expect(mockTestStream).toHaveBeenCalled();
  });

  it("POST returns 409 when the bridge is not configured", async () => {
    mockConfigured = false;
    const res = await request(app).post("/api/boot-checks");
    expect(res.status).toBe(409);
  });
});
