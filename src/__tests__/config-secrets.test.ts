import request from "supertest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("../bridge", () => ({
  startBridge: jest.fn(() => Promise.resolve()),
}));

const mockTestConnection = jest.fn();
jest.mock("../prusalink/client", () => ({
  ...jest.requireActual("../prusalink/client"),
  createPrusaLinkClient: jest.fn(() => ({
    testConnection: mockTestConnection,
  })),
}));

const mockWaitForPairing = jest.fn();
jest.mock("../obico/agent", () => ({
  ...jest.requireActual("../obico/agent"),
  createObicoAgent: jest.fn(() => ({ waitForPairing: mockWaitForPairing })),
}));

import { app } from "../server";
import { createPrusaLinkClient } from "../prusalink/client";

const PASSWORD = "printer-secret-xyz";
const API_KEY = "obico-key-abc";

const stored = {
  name: "Core One",
  prusalink: { url: "http://printer", username: "maker", password: PASSWORD },
  camera: { rtspUrl: "rtsp://printer/live", frameIntervalSeconds: 10 },
  obico: { serverUrl: "http://obico", apiKey: API_KEY },
  polling: { statusIntervalMs: 5000 },
};

let dir: string;
let file: string;

function writeStored(config: unknown = stored) {
  fs.writeFileSync(file, JSON.stringify(config));
}
function readStored() {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  file = path.join(dir, "config.json");
  process.env.CONFIG_PATH = file;
  writeStored();
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CONFIG_PATH;
});

describe("GET /api/config", () => {
  it("does not return the stored password or API key", async () => {
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(PASSWORD);
    expect(res.text).not.toContain(API_KEY);
    expect(res.body.prusalink.password).toBeUndefined();
    expect(res.body.obico.apiKey).toBeUndefined();
  });

  it("returns *** plus the last 3 chars for secrets of 8 or more chars", async () => {
    writeStored({
      ...stored,
      prusalink: { ...stored.prusalink, password: "12345678" },
      obico: { ...stored.obico, apiKey: "abcdefghijk" },
    });
    const res = await request(app).get("/api/config");
    expect(res.body.prusalink.passwordHint).toBe("***678");
    expect(res.body.obico.apiKeyHint).toBe("***ijk");
  });

  it("returns only *** for secrets shorter than 8 chars", async () => {
    writeStored({
      ...stored,
      prusalink: { ...stored.prusalink, password: "1234567" },
      obico: { ...stored.obico, apiKey: "abc" },
    });
    const res = await request(app).get("/api/config");
    expect(res.body.prusalink.passwordHint).toBe("***");
    expect(res.body.obico.apiKeyHint).toBe("***");
  });

  it("keeps the non-secret fields", async () => {
    const res = await request(app).get("/api/config");
    expect(res.body.name).toBe("Core One");
    expect(res.body.prusalink.url).toBe("http://printer");
    expect(res.body.prusalink.username).toBe("maker");
    expect(res.body.obico.serverUrl).toBe("http://obico");
  });
});

describe("POST /api/setup/save", () => {
  const body = {
    name: "Renamed",
    prusalink: { url: "http://printer", username: "maker", password: "" },
    camera: { rtspUrl: "rtsp://printer/live", frameIntervalSeconds: 10 },
    obico: { serverUrl: "http://obico", apiKey: "" },
  };

  it("keeps stored secrets when the secret fields are empty", async () => {
    const res = await request(app).post("/api/setup/save").send(body);
    expect(res.status).toBe(200);
    const saved = readStored();
    expect(saved.prusalink.password).toBe(PASSWORD);
    expect(saved.obico.apiKey).toBe(API_KEY);
    expect(saved.name).toBe("Renamed");
  });

  it("keeps stored secrets when the secret fields are missing", async () => {
    const res = await request(app)
      .post("/api/setup/save")
      .send({
        ...body,
        prusalink: { url: "http://printer", username: "maker" },
        obico: { serverUrl: "http://obico" },
      });
    expect(res.status).toBe(200);
    expect(readStored().prusalink.password).toBe(PASSWORD);
    expect(readStored().obico.apiKey).toBe(API_KEY);
  });

  it("replaces secrets when the fields are filled", async () => {
    const res = await request(app)
      .post("/api/setup/save")
      .send({
        ...body,
        prusalink: { ...body.prusalink, password: "new-pass" },
        obico: { ...body.obico, apiKey: "new-key" },
      });
    expect(res.status).toBe(200);
    expect(readStored().prusalink.password).toBe("new-pass");
    expect(readStored().obico.apiKey).toBe("new-key");
  });

  it("refuses the stored password when the PrusaLink URL changed", async () => {
    const res = await request(app)
      .post("/api/setup/save")
      .send({ ...body, prusalink: { ...body.prusalink, url: "http://evil" } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/password is required/i);
    expect(readStored().prusalink.url).toBe("http://printer");
  });

  it("refuses the stored password when the username changed", async () => {
    const res = await request(app)
      .post("/api/setup/save")
      .send({ ...body, prusalink: { ...body.prusalink, username: "other" } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/password is required/i);
  });

  it("refuses the stored API key when the Obico server URL changed", async () => {
    const res = await request(app)
      .post("/api/setup/save")
      .send({
        ...body,
        obico: { serverUrl: "http://other-obico", apiKey: "" },
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/api key is required/i);
    expect(readStored().obico.serverUrl).toBe("http://obico");
  });

  it("accepts a changed URL when a new password is sent", async () => {
    const res = await request(app)
      .post("/api/setup/save")
      .send({
        ...body,
        prusalink: { url: "http://printer2", username: "maker", password: "p" },
      });
    expect(res.status).toBe(200);
    expect(readStored().prusalink.url).toBe("http://printer2");
    expect(readStored().obico.apiKey).toBe(API_KEY);
  });

  it("rejects empty secrets when nothing is stored", async () => {
    fs.rmSync(file);
    const res = await request(app).post("/api/setup/save").send(body);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/wizard/test-prusalink", () => {
  it("uses the stored password when the password is empty", async () => {
    mockTestConnection.mockResolvedValue({ ok: true });
    const res = await request(app)
      .post("/api/wizard/test-prusalink")
      .send({ url: "http://printer", username: "maker", password: "" });
    expect(res.status).toBe(200);
    expect(createPrusaLinkClient).toHaveBeenCalledWith({
      baseUrl: "http://printer",
      username: "maker",
      password: PASSWORD,
    });
  });

  it("uses the given password when one is sent", async () => {
    mockTestConnection.mockResolvedValue({ ok: true });
    await request(app)
      .post("/api/wizard/test-prusalink")
      .send({ url: "http://printer", username: "maker", password: "typed" });
    expect(createPrusaLinkClient).toHaveBeenCalledWith(
      expect.objectContaining({ password: "typed" })
    );
  });

  it("refuses the stored password for a foreign URL", async () => {
    const res = await request(app)
      .post("/api/wizard/test-prusalink")
      .send({ url: "http://attacker", username: "maker", password: "" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/password is required/i);
    expect(createPrusaLinkClient).not.toHaveBeenCalled();
  });

  it("refuses the stored password for a different username", async () => {
    const res = await request(app)
      .post("/api/wizard/test-prusalink")
      .send({ url: "http://printer", username: "other" });
    expect(res.status).toBe(400);
    expect(createPrusaLinkClient).not.toHaveBeenCalled();
  });

  it("returns 400 when no password is sent and none is stored", async () => {
    fs.rmSync(file);
    const res = await request(app)
      .post("/api/wizard/test-prusalink")
      .send({ url: "http://printer", username: "maker" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/wizard/verify-pairing", () => {
  const setup = {
    prusalink: { url: "http://printer", username: "maker", password: "" },
    camera: { rtspUrl: "rtsp://printer/live", frameIntervalSeconds: 10 },
    obicoServerUrl: "http://new-obico",
    code: "123456",
  };

  it("saves the paired key and does not return it", async () => {
    mockWaitForPairing.mockResolvedValue("fresh-paired-key");
    const res = await request(app)
      .post("/api/wizard/verify-pairing")
      .send(setup);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("fresh-paired-key");
    const saved = readStored();
    expect(saved.obico).toEqual({
      serverUrl: "http://new-obico",
      apiKey: "fresh-paired-key",
    });
    expect(saved.prusalink.password).toBe(PASSWORD);
  });

  it("refuses before pairing when the stored password does not apply", async () => {
    const res = await request(app)
      .post("/api/wizard/verify-pairing")
      .send({ ...setup, prusalink: { ...setup.prusalink, url: "http://x" } });
    expect(res.status).toBe(400);
    expect(mockWaitForPairing).not.toHaveBeenCalled();
  });
});
