import request from "supertest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import express from "express";
import { wizardRouter } from "../routes/wizard";
import * as agentModule from "../obico/agent";

jest.mock("../obico/agent");
jest.mock("../bridge", () => ({
  startBridge: jest.fn(() => Promise.resolve()),
}));

const setup = {
  obicoServerUrl: "http://obico.local",
  code: "AB123",
  prusalink: { url: "http://printer", username: "maker", password: "pw" },
  camera: { rtspUrl: "rtsp://printer/live", frameIntervalSeconds: 10 },
};

describe("POST /api/wizard/verify-pairing", () => {
  let app: express.Express;
  let waitForPairing: jest.Mock;
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CONFIG_PATH;
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pair-"));
    process.env.CONFIG_PATH = path.join(dir, "config.json");
    waitForPairing = jest.fn();
    (agentModule.createObicoAgent as jest.Mock).mockReturnValue({
      waitForPairing,
    });
    app = express();
    app.use(express.json());
    app.use("/api/wizard", wizardRouter);
  });

  it("returns 200 without the apiKey on successful pairing", async () => {
    waitForPairing.mockResolvedValue("token-abc-123");
    const res = await request(app)
      .post("/api/wizard/verify-pairing")
      .send(setup);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("token-abc-123");
    expect(waitForPairing).toHaveBeenCalledWith("http://obico.local", "AB123");
  });

  it("returns 504 with timeout message when waitForPairing rejects with timeout", async () => {
    waitForPairing.mockRejectedValue(new Error("Pairing timed out after 120s"));
    const res = await request(app)
      .post("/api/wizard/verify-pairing")
      .send(setup);
    expect(res.status).toBe(504);
    expect(res.body.message).toMatch(/timed out/i);
  });

  it("returns 410 when waitForPairing rejects with expired", async () => {
    waitForPairing.mockRejectedValue(new Error("Pairing code expired"));
    const res = await request(app)
      .post("/api/wizard/verify-pairing")
      .send(setup);
    expect(res.status).toBe(410);
    expect(res.body.message).toMatch(/expired/i);
  });

  it("returns 400 when obicoServerUrl or code missing", async () => {
    const res = await request(app).post("/api/wizard/verify-pairing").send({});
    expect(res.status).toBe(400);
  });
});
