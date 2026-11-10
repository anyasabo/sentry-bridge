import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import * as zlib from "node:zlib";
import { createObicoAgent } from "../obico/agent";
import { ObicoAgentConfig, PrusaLinkCommandDispatcher } from "../obico/types";
import { PrinterStatus, JobInfo } from "../prusalink/types";
import { buildStatusMessage } from "../obico/types";
import { PrintStart, PrintStartStore } from "../obico/print-start-store";
import { Readable } from "node:stream";

// Mock node:fs so download tests don't touch the real filesystem
jest.mock("node:fs", () => ({
  writeFileSync: jest.fn(),
  createReadStream: jest.fn(
    () =>
      new Readable({
        read() {
          this.push(null);
        },
      })
  ),
  statSync: jest.fn(() => ({ size: 100 })),
  unlinkSync: jest.fn(),
}));

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function getPort(): number {
  return 10000 + Math.floor(Math.random() * 5000);
}

function mockResponse(status: number, body?: object): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body ?? {}),
    text: () => Promise.resolve(body ? JSON.stringify(body) : ""),
  } as unknown as Response;
}

const mockFetch = jest.fn();
const mockHttp = { fetch: mockFetch };

const mockDispatcher: PrusaLinkCommandDispatcher = {
  pause: jest.fn().mockResolvedValue(undefined),
  resume: jest.fn().mockResolvedValue(undefined),
  cancel: jest.fn().mockResolvedValue(undefined),
  startPrint: jest.fn().mockResolvedValue(undefined),
  uploadFile: jest.fn().mockResolvedValue(undefined),
};

const idleStatus: PrinterStatus = {
  state: "IDLE",
  tempBed: 25.0,
  targetBed: 0,
  tempNozzle: 26.0,
  targetNozzle: 0,
  axisZ: 0,
  axisX: 0,
  axisY: 0,
  flow: 100,
  speed: 100,
  fanHotend: 0,
  fanPrint: 0,
};

const printingStatus: PrinterStatus = { ...idleStatus, state: "PRINTING" };

const activeJob: JobInfo = {
  id: 1,
  state: "PRINTING",
  progress: 42.5,
  timePrinting: 1800,
  timeRemaining: 2400,
  fileName: "benchy.gcode",
  displayName: "benchy_0.2mm.gcode",
  currentLayer: null,
  totalLayers: null,
  posZMm: null,
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────────
// buildStatusMessage() — pure function, no I/O
// ──────────────────────────────────────────────────────────────────────────────

describe("buildStatusMessage()", () => {
  it("reflects IDLE state correctly", () => {
    const msg = buildStatusMessage(idleStatus, null);
    expect(msg.status.state.text).toBe("Operational");
    expect(msg.status.state.flags.ready).toBe(true);
    expect(msg.status.state.flags.printing).toBe(false);
    expect(msg.current_print_ts).toBe(-1);
    expect(msg.status.job.file.name).toBeNull();
  });

  it("reflects PRINTING state with job info", () => {
    const msg = buildStatusMessage(
      printingStatus,
      activeJob,
      undefined,
      null,
      1700000000
    );
    expect(msg.status.state.text).toBe("Printing");
    expect(msg.status.state.flags.printing).toBe(true);
    expect(msg.current_print_ts).toBe(1700000000);
    expect(msg.status.job.file.name).toBe("benchy_0.2mm.gcode");
    expect(msg.status.progress.completion).toBe(42.5);
    expect(msg.status.temperatures.tool0.actual).toBe(26.0);
    expect(msg.status.temperatures.bed.actual).toBe(25.0);
  });

  it("sends current_print_ts null while printing with no known print start", () => {
    const msg = buildStatusMessage(printingStatus, null);
    expect(msg.current_print_ts).toBeNull();
  });

  it("sends current_print_ts null in BUSY, which can occur during a print", () => {
    const msg = buildStatusMessage({ ...idleStatus, state: "BUSY" }, null);
    expect(msg.current_print_ts).toBeNull();
  });

  it("reflects PAUSED state", () => {
    const msg = buildStatusMessage(
      { ...idleStatus, state: "PAUSED" },
      activeJob
    );
    expect(msg.status.state.flags.paused).toBe(true);
    expect(msg.status.state.flags.printing).toBe(false);
  });

  it("reflects FINISHED state — finishing flag true, current_print_ts=-1 (Print Done signal)", () => {
    const msg = buildStatusMessage(
      { ...idleStatus, state: "FINISHED" },
      activeJob
    );
    expect(msg.status.state.text).toBe("Operational");
    expect(msg.status.state.flags.finishing).toBe(true);
    expect(msg.status.state.flags.printing).toBe(false);
    expect(msg.current_print_ts).toBe(-1);
  });

  it("reflects ERROR state", () => {
    const msg = buildStatusMessage({ ...idleStatus, state: "ERROR" }, null);
    expect(msg.status.state.flags.error).toBe(true);
    expect(msg.status.state.error).toBeTruthy();
  });

  it("includes settings.webcams at top-level when streamUrl provided", () => {
    const msg = buildStatusMessage(
      idleStatus,
      null,
      "http://bridge.local/stream"
    );
    expect(msg.settings?.webcams).toHaveLength(1);
    expect(msg.settings?.webcams?.[0]).toMatchObject({
      stream_url: "http://bridge.local/stream",
      snapshot_url: "http://bridge.local/api/camera/snapshot",
      stream_mode: "h264_transcode",
      is_primary_camera: true,
      stream_id: 1,
    });
  });

  it("omits settings.webcams when streamUrl not provided", () => {
    const msg = buildStatusMessage(idleStatus, null);
    expect(msg.settings).toBeUndefined();
  });

  it("FINISHING state sets finishing flag and preserves current_print_ts", () => {
    const msg = buildStatusMessage(
      { ...idleStatus, state: "FINISHING" },
      activeJob,
      undefined,
      null,
      1700000000
    );
    expect(msg.status.state.text).toBe("Finishing");
    expect(msg.status.state.flags.finishing).toBe(true);
    expect(msg.status.state.flags.printing).toBe(false);
    expect(msg.current_print_ts).toBe(1700000000);
  });

  it("maps job.currentLayer/totalLayers into progress", () => {
    const jobWithLayers: JobInfo = {
      ...activeJob,
      currentLayer: 12,
      totalLayers: 80,
      posZMm: null,
    };
    const msg = buildStatusMessage(printingStatus, jobWithLayers);
    expect(msg.status.progress.currentLayer).toBe(12);
    expect(msg.status.progress.totalLayers).toBe(80);
  });

  it("uses job.posZMm when available, falls back to status.axisZ", () => {
    const jobWithZ: JobInfo = { ...activeJob, posZMm: 4.6 };
    const statusWithAxisZ: PrinterStatus = {
      ...idleStatus,
      state: "PRINTING",
      axisZ: 2.0,
    };
    const msgWithJobZ = buildStatusMessage(statusWithAxisZ, jobWithZ);
    expect(msgWithJobZ.status.progress.currentZ).toBe(4.6);

    const jobNoZ: JobInfo = { ...activeJob, posZMm: null };
    const msgFallback = buildStatusMessage(statusWithAxisZ, jobNoZ);
    expect(msgFallback.status.progress.currentZ).toBe(2.0);
  });

  it("FINISHING with null job still produces valid message with finishing flag and unknown ts", () => {
    const msg = buildStatusMessage({ ...idleStatus, state: "FINISHING" }, null);
    expect(msg.status.state.flags.finishing).toBe(true);
    expect(msg.status.progress.currentLayer).toBeNull();
    expect(msg.status.progress.totalLayers).toBeNull();
    expect(msg.current_print_ts).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// startPairing() / waitForPairing()
// ──────────────────────────────────────────────────────────────────────────────

describe("startPairing()", () => {
  it("POSTs to /api/v1/octo/verify/ and returns pairing code", async () => {
    mockFetch.mockResolvedValue(
      mockResponse(200, { code: "AB123", expired_at: "2026-01-01T00:00:00Z" })
    );
    const agent = createObicoAgent(
      { serverUrl: "http://obico.local", apiKey: "" },
      mockHttp,
      mockDispatcher
    );
    const code = await agent.startPairing("http://obico.local");
    expect(code).toBe("AB123");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/octo/verify/"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws on non-200 response", async () => {
    mockFetch.mockResolvedValue(mockResponse(500));
    const agent = createObicoAgent(
      { serverUrl: "http://obico.local", apiKey: "" },
      mockHttp,
      mockDispatcher
    );
    await expect(agent.startPairing("http://obico.local")).rejects.toThrow();
  });
});

describe("waitForPairing()", () => {
  afterEach(() => {
    // Ensure fake timers are always restored even if a test throws
    jest.useRealTimers();
  });

  it("polls verify endpoint and returns auth_token when confirmed", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(202)) // not yet confirmed
      .mockResolvedValueOnce(
        mockResponse(200, {
          printer: { auth_token: "abc123def456abc1" },
          verified_at: "2026-01-01T00:00:00Z",
        })
      );
    const agent = createObicoAgent(
      { serverUrl: "http://obico.local", apiKey: "" },
      mockHttp,
      mockDispatcher
    );
    const token = await agent.waitForPairing("http://obico.local", "AB123");
    expect(token).toBe("abc123def456abc1");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws on 410 Gone (code expired)", async () => {
    mockFetch.mockResolvedValue(mockResponse(410));
    const agent = createObicoAgent(
      { serverUrl: "http://obico.local", apiKey: "" },
      mockHttp,
      mockDispatcher
    );
    await expect(
      agent.waitForPairing("http://obico.local", "AB123")
    ).rejects.toThrow(/expired/i);
  });

  it("rejects with a timeout error after 120s when never confirmed", async () => {
    // Use real timers with a short injected deadline so the test completes
    // in milliseconds rather than 120 real seconds. The production default
    // is 120_000 ms (hardcoded per D3). The optional 3rd parameter lets
    // tests override the deadline — same pattern as camera.testStream(timeoutMs).
    mockFetch.mockResolvedValue(mockResponse(202)); // always 202, never confirmed
    const agent = createObicoAgent(
      { serverUrl: "http://obico.local", apiKey: "" },
      mockHttp,
      mockDispatcher
    );
    await expect(
      agent.waitForPairing("http://obico.local", "AB123", 200)
    ).rejects.toThrow(/timed out/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// sendFrame()
// ──────────────────────────────────────────────────────────────────────────────

describe("sendFrame()", () => {
  it("POSTs binary JPEG to /api/v1/octo/pic/ with Token auth", async () => {
    mockFetch.mockResolvedValue(mockResponse(200));
    const agent = createObicoAgent(
      { serverUrl: "http://obico.local", apiKey: "test-key" },
      mockHttp,
      mockDispatcher
    );
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await agent.sendFrame(jpeg);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://obico.local/api/v1/octo/pic/",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Token test-key" }),
      })
    );
    const callArgs = mockFetch.mock.calls[0][1];
    const body = callArgs.body as FormData;
    expect(body.get("pic")).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// fetchPrinterId()
// ──────────────────────────────────────────────────────────────────────────────

describe("fetchPrinterId()", () => {
  it("returns printer ID from /api/v1/octo/printer/", async () => {
    mockFetch.mockResolvedValue(
      mockResponse(200, { printer: { id: 42 }, user: { is_pro: true } })
    );
    const agent = createObicoAgent(
      { serverUrl: "http://obico.local", apiKey: "token" },
      mockHttp,
      mockDispatcher
    );
    const id = await agent.fetchPrinterId();
    expect(id).toBe(42);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://obico.local/api/v1/octo/printer/",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Token token" }),
      })
    );
  });

  it("returns null on non-200 response", async () => {
    mockFetch.mockResolvedValue(mockResponse(403));
    const agent = createObicoAgent(
      { serverUrl: "http://obico.local", apiKey: "token" },
      mockHttp,
      mockDispatcher
    );
    expect(await agent.fetchPrinterId()).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    const agent = createObicoAgent(
      { serverUrl: "http://obico.local", apiKey: "token" },
      mockHttp,
      mockDispatcher
    );
    expect(await agent.fetchPrinterId()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// updateAgentInfo()
// ──────────────────────────────────────────────────────────────────────────────

describe("updateAgentInfo()", () => {
  it("PATCHes agent_name and agent_version to /api/v1/octo/printer/", async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {}));
    const agent = createObicoAgent(
      { serverUrl: "http://obico.local", apiKey: "mykey" },
      mockHttp,
      mockDispatcher
    );
    await agent.updateAgentInfo();
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe("http://obico.local/api/v1/octo/printer/");
    const body = JSON.parse(call[1].body);
    expect(body.agent_name).toBe("moonraker_obico");
    expect(body.agent_version).toBe("2.1.0");
    expect(body.webcams).toBeUndefined();
  });

  it("does not throw when PATCH fails", async () => {
    mockFetch.mockResolvedValue(mockResponse(403, {}));
    const agent = createObicoAgent(
      { serverUrl: "http://obico.local", apiKey: "bad" },
      mockHttp,
      mockDispatcher
    );
    await expect(agent.updateAgentInfo()).resolves.toBeUndefined();
  });

  it("does not throw when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    const agent = createObicoAgent(
      { serverUrl: "http://obico.local", apiKey: "bad" },
      mockHttp,
      mockDispatcher
    );
    await expect(agent.updateAgentInfo()).resolves.toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Circuit Breaker registration
// ──────────────────────────────────────────────────────────────────────────────

import { circuitBreakerRegistry } from "../lib/health";
import { CircuitState } from "../lib/circuit-breaker";

describe("Obico agent circuit breaker registration", () => {
  beforeEach(() => {
    circuitBreakerRegistry.delete("obico_ws");
  });

  it("registers a circuit breaker under 'obico_ws' when the agent is created", () => {
    const http = { fetch: jest.fn() } as any;
    const dispatcher = {
      pause: jest.fn(),
      resume: jest.fn(),
      cancel: jest.fn(),
    } as any;
    createObicoAgent(
      {
        serverUrl: "http://localhost:9999",
        apiKey: "k",
        streamUrl: "http://x/stream",
      },
      http,
      dispatcher
    );
    const cb = circuitBreakerRegistry.get("obico_ws");
    expect(cb).toBeDefined();
    expect(cb!.state).toBe(CircuitState.CLOSED);
  });

  it("allows reset() on the registered breaker to leave state CLOSED", () => {
    const http = { fetch: jest.fn() } as any;
    const dispatcher = {
      pause: jest.fn(),
      resume: jest.fn(),
      cancel: jest.fn(),
    } as any;
    createObicoAgent(
      {
        serverUrl: "http://localhost:9999",
        apiKey: "k",
        streamUrl: "http://x/stream",
      },
      http,
      dispatcher
    );
    const cb = circuitBreakerRegistry.get("obico_ws")!;
    cb.reset();
    expect(cb.state).toBe(CircuitState.CLOSED);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// WebSocket: connect / sendStatus / control dispatch
// ──────────────────────────────────────────────────────────────────────────────

describe("WebSocket", () => {
  let wss: WebSocketServer;
  let port: number;
  let serverSocket: WebSocket | null = null;

  beforeEach((done) => {
    port = getPort();
    serverSocket = null;
    wss = new WebSocketServer({ port });
    wss.on("connection", (ws) => {
      serverSocket = ws;
    });
    wss.on("listening", done);
  });

  afterEach((done) => {
    wss.close(done);
  });

  it("connects with Authorization bearer header", (done) => {
    const config: ObicoAgentConfig = {
      serverUrl: `http://localhost:${port}`,
      apiKey: "my-api-key",
    };
    wss.on("connection", (_ws, req) => {
      const authHeader = req.headers["authorization"] ?? "";
      expect(authHeader).toBe("bearer my-api-key");
      done();
    });
    const agent = createObicoAgent(config, mockHttp, mockDispatcher);
    agent.connect();
    setTimeout(() => agent.disconnect(), 200);
  });

  it("sendStatus() sends correct JSON over WebSocket", (done) => {
    const config: ObicoAgentConfig = {
      serverUrl: `http://localhost:${port}`,
      apiKey: "key",
    };
    const agent = createObicoAgent(config, mockHttp, mockDispatcher);
    agent.connect();

    // Wait for connection then send status
    setTimeout(() => {
      agent.sendStatus(idleStatus, null);
    }, 50);

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        expect(msg.status).toBeDefined();
        expect(msg.status.state.text).toBe("Operational");
        agent.disconnect();
        done();
      });
    });
  });

  it("dispatches pause command to PrusaLink dispatcher", (done) => {
    const config: ObicoAgentConfig = {
      serverUrl: `http://localhost:${port}`,
      apiKey: "key",
    };
    const agent = createObicoAgent(config, mockHttp, mockDispatcher);
    agent.connect();

    wss.on("connection", (ws) => {
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            passthru: {
              ref: "ref-1",
              target: "Printer",
              func: "pause",
              args: [],
              kwargs: {},
            },
          })
        );
      }, 50);
    });

    setTimeout(() => {
      expect(mockDispatcher.pause).toHaveBeenCalled();
      agent.disconnect();
      done();
    }, 200);
  });

  it("dispatches resume command", (done) => {
    const config: ObicoAgentConfig = {
      serverUrl: `http://localhost:${port}`,
      apiKey: "key",
    };
    const agent = createObicoAgent(config, mockHttp, mockDispatcher);
    agent.connect();

    wss.on("connection", (ws) => {
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            passthru: {
              ref: "ref-2",
              target: "Printer",
              func: "resume",
              args: [],
              kwargs: {},
            },
          })
        );
      }, 50);
    });

    setTimeout(() => {
      expect(mockDispatcher.resume).toHaveBeenCalled();
      agent.disconnect();
      done();
    }, 200);
  });

  it("dispatches cancel command", (done) => {
    const config: ObicoAgentConfig = {
      serverUrl: `http://localhost:${port}`,
      apiKey: "key",
    };
    const agent = createObicoAgent(config, mockHttp, mockDispatcher);
    agent.connect();

    wss.on("connection", (ws) => {
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            passthru: {
              ref: "ref-3",
              target: "Printer",
              func: "cancel",
              args: [],
              kwargs: {},
            },
          })
        );
      }, 50);
    });

    setTimeout(() => {
      expect(mockDispatcher.cancel).toHaveBeenCalled();
      agent.disconnect();
      done();
    }, 200);
  });

  it("dispatches pause via commands[] format (real Obico protocol)", (done) => {
    const agent = createObicoAgent(
      { serverUrl: `http://localhost:${port}`, apiKey: "key" },
      mockHttp,
      mockDispatcher
    );
    agent.connect();

    wss.on("connection", (ws) => {
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            commands: [
              {
                cmd: "pause",
                args: { retract: 6.5, lift_z: 2.5, tools_off: true },
                initiator: "api",
              },
            ],
            type: "printer.message",
          })
        );
      }, 50);
    });

    setTimeout(() => {
      expect(mockDispatcher.pause).toHaveBeenCalled();
      agent.disconnect();
      done();
    }, 200);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Print passthru commands (PRINT-01..04)
// ──────────────────────────────────────────────────────────────────────────────

describe("Print passthru commands", () => {
  let wss: WebSocketServer;
  let port: number;
  let serverSocket: WebSocket | null = null;

  beforeEach((done) => {
    port = getPort();
    serverSocket = null;
    wss = new WebSocketServer({ port });
    wss.on("connection", (ws) => {
      serverSocket = ws;
    });
    wss.on("listening", done);
    jest.clearAllMocks();
  });

  afterEach((done) => {
    wss.close(done);
  });

  function makeAgent() {
    return createObicoAgent(
      { serverUrl: `http://localhost:${port}`, apiKey: "key" },
      mockHttp,
      mockDispatcher
    );
  }

  // Test 1 (PRINT-01 Lokal-ACK): start_printer_local_print → startPrint + ACK
  it("PRINT-01: start_printer_local_print calls startPrint and sends ACK", (done) => {
    const agent = makeAgent();
    agent.connect();

    const received: string[] = [];

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        received.push(data.toString());
      });
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            passthru: {
              target: "file_operations",
              func: "start_printer_local_print",
              ref: "R1",
              args: [
                {
                  url: "http://obico.local/files/foo.gcode",
                  agent_signature: "sig",
                },
              ],
            },
          })
        );
      }, 50);
    });

    setTimeout(() => {
      expect(mockDispatcher.startPrint).toHaveBeenCalledWith("foo.gcode");
      const ack = received.find((m) => m.includes('"ref":"R1"'));
      expect(ack).toBeDefined();
      const parsed = JSON.parse(ack!);
      expect(parsed.passthru.ref).toBe("R1");
      expect(parsed.passthru.ret).toBe("Success");
      agent.disconnect();
      done();
    }, 300);
  });

  // Test 2 (PRINT-01 Lokal-Error-ACK): startPrint rejects → error ACK
  it("PRINT-01: sends error ACK when startPrint rejects", (done) => {
    (mockDispatcher.startPrint as jest.Mock).mockRejectedValueOnce(
      new Error("printer busy")
    );

    const agent = makeAgent();
    agent.connect();

    const received: string[] = [];

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        received.push(data.toString());
      });
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            passthru: {
              target: "file_operations",
              func: "start_printer_local_print",
              ref: "R2",
              args: [{ url: "http://obico.local/files/test.gcode" }],
            },
          })
        );
      }, 50);
    });

    setTimeout(() => {
      const ack = received.find((m) => m.includes('"ref":"R2"'));
      expect(ack).toBeDefined();
      const parsed = JSON.parse(ack!);
      expect(parsed.passthru.ref).toBe("R2");
      expect(parsed.passthru.error).toMatch(/printer busy/);
      agent.disconnect();
      done();
    }, 300);
  });

  // Test 3 (PRINT-02 args/kwargs Tolerance): kwargs instead of args
  it("PRINT-02: handles kwargs envelope same as args", (done) => {
    const agent = makeAgent();
    agent.connect();

    wss.on("connection", (ws) => {
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            passthru: {
              target: "file_operations",
              func: "start_printer_local_print",
              ref: "R3",
              kwargs: { url: "http://obico.local/files/kwargs.gcode" },
            },
          })
        );
      }, 50);
    });

    setTimeout(() => {
      expect(mockDispatcher.startPrint).toHaveBeenCalledWith("kwargs.gcode");
      agent.disconnect();
      done();
    }, 300);
  });

  // Test 4 (PRINT-03 Download-Flow): file_downloader.download → upload + startPrint + ACK + fileId
  it("PRINT-03: file_downloader.download calls uploadFile + startPrint, sends ACK, sets fileId", (done) => {
    // Mock http.fetch for the download
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () =>
        Promise.resolve(Buffer.from("fake gcode content").buffer),
    } as unknown as Response);

    const agent = makeAgent();
    agent.connect();

    const received: string[] = [];

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        received.push(data.toString());
      });
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            passthru: {
              target: "file_downloader",
              func: "download",
              ref: "R4",
              args: [
                {
                  url: `http://localhost:${port}/files/benchy.gcode`,
                  safe_filename: "benchy.gcode",
                  id: 42,
                  filename: "benchy.gcode",
                },
              ],
            },
          })
        );
      }, 50);
    });

    setTimeout(() => {
      expect(mockDispatcher.uploadFile).toHaveBeenCalledWith(
        "benchy.gcode",
        expect.any(Buffer)
      );
      expect(mockDispatcher.startPrint).toHaveBeenCalledWith("benchy.gcode");
      const ack = received.find((m) => m.includes('"ref":"R4"'));
      expect(ack).toBeDefined();
      const parsed = JSON.parse(ack!);
      expect(parsed.passthru.ref).toBe("R4");
      expect(parsed.passthru.ret).toEqual({ target_path: "benchy.gcode" });
      agent.disconnect();
      done();
    }, 500);
  });

  // Test 5 (PRINT-03 Path-Traversal-Mitigation): basename applied to safe_filename
  it("PRINT-03: path traversal in safe_filename is mitigated via basename", (done) => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(Buffer.from("data").buffer),
    } as unknown as Response);

    const agent = makeAgent();
    agent.connect();

    wss.on("connection", (ws) => {
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            passthru: {
              target: "file_downloader",
              func: "download",
              ref: "R5",
              args: [
                {
                  url: `http://localhost:${port}/files/passwd`,
                  safe_filename: "../../etc/passwd",
                  id: 99,
                  filename: "passwd",
                },
              ],
            },
          })
        );
      }, 50);
    });

    setTimeout(() => {
      expect(mockDispatcher.uploadFile).toHaveBeenCalledWith(
        "passwd",
        expect.any(Buffer)
      );
      expect(mockDispatcher.startPrint).toHaveBeenCalledWith("passwd");
      agent.disconnect();
      done();
    }, 500);
  });

  // Test 6 (PRINT-03 SSRF-Mitigation): non-http/https URL → error ACK
  it("PRINT-03: SSRF mitigation rejects non-http/https URL (e.g. file://)", (done) => {
    const agent = makeAgent();
    agent.connect();

    const received: string[] = [];

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        received.push(data.toString());
      });
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            passthru: {
              target: "file_downloader",
              func: "download",
              ref: "R6",
              args: [
                {
                  url: "file:///etc/passwd",
                  safe_filename: "passwd.gcode",
                  id: 1,
                  filename: "passwd.gcode",
                },
              ],
            },
          })
        );
      }, 50);
    });

    setTimeout(() => {
      expect(mockDispatcher.uploadFile).not.toHaveBeenCalled();
      expect(mockDispatcher.startPrint).not.toHaveBeenCalled();
      const ack = received.find((m) => m.includes('"ref":"R6"'));
      expect(ack).toBeDefined();
      const parsed = JSON.parse(ack!);
      expect(parsed.passthru.error).toBeDefined();
      agent.disconnect();
      done();
    }, 300);
  });

  // Test 7 (PRINT-04 fileId in Status): after download-print, sendStatus includes obico_g_code_file_id
  it("PRINT-04: obico_g_code_file_id is set in status after download-print", (done) => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(Buffer.from("gcode").buffer),
    } as unknown as Response);

    const agent = makeAgent();
    agent.connect();

    const received: string[] = [];

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        received.push(data.toString());
      });
      setTimeout(() => {
        // trigger download
        ws.send(
          JSON.stringify({
            passthru: {
              target: "file_downloader",
              func: "download",
              ref: "R7",
              args: [
                {
                  url: `http://localhost:${port}/f.gcode`,
                  safe_filename: "f.gcode",
                  id: 42,
                  filename: "f.gcode",
                },
              ],
            },
          })
        );
      }, 50);
    });

    // After download completes, sendStatus should include fileId=42
    setTimeout(() => {
      agent.sendStatus(printingStatus, activeJob);
      setTimeout(() => {
        const statusMsg = received.find((m) => {
          try {
            const p = JSON.parse(m);
            return p.status !== undefined;
          } catch {
            return false;
          }
        });
        expect(statusMsg).toBeDefined();
        const parsed = JSON.parse(statusMsg!);
        expect(parsed.status.job.file.obico_g_code_file_id).toBe(42);
        agent.disconnect();
        done();
      }, 100);
    }, 400);
  });

  // Test 8 (PRINT-04 Reset bei IDLE): activePrintFileId reset to null on IDLE
  it("PRINT-04: activePrintFileId reset to null when printer becomes IDLE", (done) => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(Buffer.from("gcode").buffer),
    } as unknown as Response);

    const agent = makeAgent();
    agent.connect();

    const received: string[] = [];

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        received.push(data.toString());
      });
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            passthru: {
              target: "file_downloader",
              func: "download",
              ref: "R8",
              args: [
                {
                  url: `http://localhost:${port}/f.gcode`,
                  safe_filename: "f.gcode",
                  id: 42,
                  filename: "f.gcode",
                },
              ],
            },
          })
        );
      }, 50);
    });

    setTimeout(() => {
      // Send IDLE status — should reset fileId
      agent.sendStatus(idleStatus, null);
      setTimeout(() => {
        // Send a second status — should now have null fileId
        agent.sendStatus(printingStatus, activeJob);
        setTimeout(() => {
          const statusMsgs = received.filter((m) => {
            try {
              return JSON.parse(m).status !== undefined;
            } catch {
              return false;
            }
          });
          // The second status message should have null fileId (after IDLE reset)
          const secondStatus = JSON.parse(statusMsgs[statusMsgs.length - 1]);
          expect(secondStatus.status.job.file.obico_g_code_file_id).toBeNull();
          agent.disconnect();
          done();
        }, 100);
      }, 50);
    }, 400);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// http.tunnelv2 handler (INFRA-02)
// ──────────────────────────────────────────────────────────────────────────────

describe("http.tunnelv2 handler", () => {
  let tunnelServer: http.Server;
  let tunnelPort: number;

  let wss: WebSocketServer;
  let wsPort: number;

  // Track last recorded request for POST/DELETE tests
  const lastRequest: { method?: string; url?: string; body?: string } = {};

  beforeAll((done) => {
    // Start a real local HTTP server to proxy to
    tunnelServer = http.createServer((req, res) => {
      if (req.url === "/api/files") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ files: [] }));
        return;
      }
      if (req.url === "/api/big") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("X".repeat(2000));
        return;
      }
      if (req.url === "/api/small") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("tiny");
        return;
      }
      if (req.url === "/api/slow") {
        // Respond after 15s — will hit 10s timeout
        setTimeout(() => {
          try {
            res.end("late");
          } catch {
            /* closed */
          }
        }, 15000);
        return;
      }
      if (req.url === "/api/files/upload" && req.method === "POST") {
        let chunks = "";
        req.on("data", (c: Buffer) => (chunks += c.toString()));
        req.on("end", () => {
          lastRequest.method = req.method;
          lastRequest.url = req.url;
          lastRequest.body = chunks;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      if (req.url?.startsWith("/api/files/") && req.method === "DELETE") {
        lastRequest.method = req.method;
        lastRequest.url = req.url;
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    tunnelServer.listen(0, "127.0.0.1", () => {
      tunnelPort = (tunnelServer.address() as { port: number }).port;
      done();
    });
  });

  afterAll((done) => {
    tunnelServer.close(() => done());
  });

  beforeEach((done) => {
    wsPort = getPort();
    wss = new WebSocketServer({ port: wsPort });
    wss.on("listening", done);
    jest.clearAllMocks();
  });

  afterEach((done) => {
    wss.close(done);
  });

  function makeAgent() {
    return createObicoAgent(
      {
        serverUrl: `http://localhost:${wsPort}`,
        apiKey: "key",
        localPort: tunnelPort,
      },
      mockHttp,
      mockDispatcher
    );
  }

  function waitForTunnelResponse(
    serverSocket: WebSocket,
    ref: string,
    timeoutMs = 12000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Timeout waiting for tunnel response ref=${ref}`)),
        timeoutMs
      );
      serverSocket.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg["http.tunnelv2"]?.ref === ref) {
            clearTimeout(timer);
            resolve(msg["http.tunnelv2"]);
          }
        } catch {
          /* ignore */
        }
      });
    });
  }

  // Test 1: GET /api/files → proxied → response sent back
  it("INFRA-02 T1: proxies GET /api/files and sends http.tunnelv2 response", (done) => {
    let serverSocket: WebSocket;
    wss.on("connection", (ws) => {
      serverSocket = ws;
    });

    const agent = makeAgent();
    agent.connect();

    setTimeout(() => {
      serverSocket.send(
        JSON.stringify({
          "http.tunnelv2": {
            ref: "T1",
            method: "GET",
            path: "/api/files",
            headers: {},
            timeout: 10,
          },
        })
      );

      waitForTunnelResponse(serverSocket, "T1")
        .then((tunnel) => {
          expect(tunnel.ref).toBe("T1");
          expect(tunnel.response.status).toBe(200);
          expect(typeof tunnel.response.content).toBe("string");
          expect(typeof tunnel.response.compressed).toBe("boolean");
          expect(Array.isArray(tunnel.response.cookies)).toBe(true);
          agent.disconnect();
          done();
        })
        .catch((err) => {
          agent.disconnect();
          done(err);
        });
    }, 50);
  });

  // Test 2: Body >= 1000 bytes → compressed=true, content = base64(zlib.deflate)
  it("INFRA-02 T2: compresses body >= 1000 bytes (compressed=true)", (done) => {
    let serverSocket: WebSocket;
    wss.on("connection", (ws) => {
      serverSocket = ws;
    });

    const agent = makeAgent();
    agent.connect();

    setTimeout(() => {
      serverSocket.send(
        JSON.stringify({
          "http.tunnelv2": {
            ref: "T2",
            method: "GET",
            path: "/api/big",
            headers: {},
            timeout: 10,
          },
        })
      );

      waitForTunnelResponse(serverSocket, "T2")
        .then((tunnel) => {
          expect(tunnel.response.compressed).toBe(true);
          // Verify round-trip: base64-decode → zlib.inflateSync → "X".repeat(2000)
          const decoded = Buffer.from(tunnel.response.content, "base64");
          const inflated = zlib.inflateSync(decoded).toString();
          expect(inflated).toBe("X".repeat(2000));
          agent.disconnect();
          done();
        })
        .catch((err) => {
          agent.disconnect();
          done(err);
        });
    }, 50);
  });

  // Test 3: Body < 1000 bytes → compressed=false
  it("INFRA-02 T3: does not compress body < 1000 bytes (compressed=false)", (done) => {
    let serverSocket: WebSocket;
    wss.on("connection", (ws) => {
      serverSocket = ws;
    });

    const agent = makeAgent();
    agent.connect();

    setTimeout(() => {
      serverSocket.send(
        JSON.stringify({
          "http.tunnelv2": {
            ref: "T3",
            method: "GET",
            path: "/api/small",
            headers: {},
            timeout: 10,
          },
        })
      );

      waitForTunnelResponse(serverSocket, "T3")
        .then((tunnel) => {
          expect(tunnel.response.compressed).toBe(false);
          const decoded = Buffer.from(
            tunnel.response.content,
            "base64"
          ).toString();
          expect(decoded).toBe("tiny");
          agent.disconnect();
          done();
        })
        .catch((err) => {
          agent.disconnect();
          done(err);
        });
    }, 50);
  });

  // Test 4: method not in ALLOWED_METHODS → 405, no HTTP call made
  it("INFRA-02 T4: rejects PUT method with 405 (not in ALLOWED_METHODS)", (done) => {
    let serverSocket: WebSocket;
    wss.on("connection", (ws) => {
      serverSocket = ws;
    });

    const agent = makeAgent();
    agent.connect();

    setTimeout(() => {
      serverSocket.send(
        JSON.stringify({
          "http.tunnelv2": {
            ref: "T4",
            method: "PUT",
            path: "/api/files",
            headers: {},
            timeout: 10,
          },
        })
      );

      waitForTunnelResponse(serverSocket, "T4")
        .then((tunnel) => {
          expect(tunnel.response.status).toBe(405);
          agent.disconnect();
          done();
        })
        .catch((err) => {
          agent.disconnect();
          done(err);
        });
    }, 50);
  });

  // Test 5: path not starting with /api/ → 403, no HTTP call
  it("INFRA-02 T5: rejects path outside /api/ with 403", (done) => {
    let serverSocket: WebSocket;
    wss.on("connection", (ws) => {
      serverSocket = ws;
    });

    const agent = makeAgent();
    agent.connect();

    setTimeout(() => {
      serverSocket.send(
        JSON.stringify({
          "http.tunnelv2": {
            ref: "T5",
            method: "GET",
            path: "/etc/passwd",
            headers: {},
            timeout: 10,
          },
        })
      );

      waitForTunnelResponse(serverSocket, "T5")
        .then((tunnel) => {
          expect(tunnel.response.status).toBe(403);
          agent.disconnect();
          done();
        })
        .catch((err) => {
          agent.disconnect();
          done(err);
        });
    }, 50);
  });

  // Test 6: timeout — slow endpoint → 504 within ~10s
  it("INFRA-02 T6: returns 504 when local HTTP request times out", (done) => {
    let serverSocket: WebSocket;
    wss.on("connection", (ws) => {
      serverSocket = ws;
    });

    const agent = makeAgent();
    agent.connect();

    setTimeout(() => {
      serverSocket.send(
        JSON.stringify({
          "http.tunnelv2": {
            ref: "T6",
            method: "GET",
            path: "/api/slow",
            headers: {},
            timeout: 10,
          },
        })
      );

      waitForTunnelResponse(serverSocket, "T6", 12000)
        .then((tunnel) => {
          expect(tunnel.response.status).toBe(504);
          agent.disconnect();
          done();
        })
        .catch((err) => {
          agent.disconnect();
          done(err);
        });
    }, 50);
  }, 15000);

  // Test 7: unreachable port → 502
  it("INFRA-02 T7: returns 502 when local HTTP server is unreachable", (done) => {
    let serverSocket: WebSocket;
    wss.on("connection", (ws) => {
      serverSocket = ws;
    });

    // Create agent with a port nobody is listening on
    const badAgent = createObicoAgent(
      {
        serverUrl: `http://localhost:${wsPort}`,
        apiKey: "key",
        localPort: 19999, // nothing listening here
      },
      mockHttp,
      mockDispatcher
    );
    badAgent.connect();

    setTimeout(() => {
      serverSocket.send(
        JSON.stringify({
          "http.tunnelv2": {
            ref: "T7",
            method: "GET",
            path: "/api/files",
            headers: {},
            timeout: 5,
          },
        })
      );

      waitForTunnelResponse(serverSocket, "T7")
        .then((tunnel) => {
          expect(tunnel.response.status).toBe(502);
          badAgent.disconnect();
          done();
        })
        .catch((err) => {
          badAgent.disconnect();
          done(err);
        });
    }, 50);
  });

  // Test 8: POST via tunnel with base64 body → body forwarded (FILES-02 over Obico tunnel)
  it("INFRA-02 T8: forwards POST via tunnel with base64 body (FILES-02 over Obico tunnel)", (done) => {
    let serverSocket: WebSocket;
    wss.on("connection", (ws) => {
      serverSocket = ws;
    });

    const agent = makeAgent();
    agent.connect();

    lastRequest.method = undefined;
    lastRequest.body = undefined;

    setTimeout(() => {
      serverSocket.send(
        JSON.stringify({
          "http.tunnelv2": {
            ref: "T8",
            method: "POST",
            path: "/api/files/upload",
            headers: { "content-type": "application/octet-stream" },
            data: Buffer.from("hello").toString("base64"),
            timeout: 10,
          },
        })
      );

      waitForTunnelResponse(serverSocket, "T8")
        .then((tunnel) => {
          expect(tunnel.response.status).toBe(200);
          expect(lastRequest.method).toBe("POST");
          expect(lastRequest.body).toBe("hello");
          agent.disconnect();
          done();
        })
        .catch((err) => {
          agent.disconnect();
          done(err);
        });
    }, 50);
  });

  // Test 9: DELETE via tunnel → forwarded (FILES-04 over Obico tunnel)
  it("INFRA-02 T9: forwards DELETE via tunnel (FILES-04 over Obico tunnel)", (done) => {
    let serverSocket: WebSocket;
    wss.on("connection", (ws) => {
      serverSocket = ws;
    });

    const agent = makeAgent();
    agent.connect();

    lastRequest.method = undefined;
    lastRequest.url = undefined;

    setTimeout(() => {
      serverSocket.send(
        JSON.stringify({
          "http.tunnelv2": {
            ref: "T9",
            method: "DELETE",
            path: "/api/files/test.gcode",
            headers: {},
            timeout: 10,
          },
        })
      );

      waitForTunnelResponse(serverSocket, "T9")
        .then((tunnel) => {
          expect(tunnel.response.status).toBe(204);
          expect(lastRequest.method).toBe("DELETE");
          expect(lastRequest.url).toBe("/api/files/test.gcode");
          agent.disconnect();
          done();
        })
        .catch((err) => {
          agent.disconnect();
          done(err);
        });
    }, 50);
  });

  // Test 10: PUT via tunnel → 405 (PUT via tunnel is not in ALLOWED_METHODS)
  it("INFRA-02 T10: rejects PUT via tunnel with 405", (done) => {
    let serverSocket: WebSocket;
    wss.on("connection", (ws) => {
      serverSocket = ws;
    });

    const agent = makeAgent();
    agent.connect();

    setTimeout(() => {
      serverSocket.send(
        JSON.stringify({
          "http.tunnelv2": {
            ref: "T10",
            method: "PUT",
            path: "/api/files/test.gcode",
            headers: {},
            timeout: 10,
          },
        })
      );

      waitForTunnelResponse(serverSocket, "T10")
        .then((tunnel) => {
          expect(tunnel.response.status).toBe(405);
          agent.disconnect();
          done();
        })
        .catch((err) => {
          agent.disconnect();
          done(err);
        });
    }, 50);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// FINISHING state: Job-Context-Caching and print id persistence (Gap 1 fix)
// ──────────────────────────────────────────────────────────────────────────────

describe("FINISHING state handling", () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach((done) => {
    port = getPort();
    wss = new WebSocketServer({ port });
    wss.on("listening", done);
    jest.clearAllMocks();
  });

  afterEach((done) => {
    wss.close(done);
  });

  it("preserves the print id and job context across PRINTING → FINISHING → IDLE", (done) => {
    const agent = createObicoAgent(
      { serverUrl: `http://localhost:${port}`, apiKey: "key" },
      mockHttp,
      mockDispatcher
    );
    agent.connect();

    const received: string[] = [];

    const printingJob: JobInfo = {
      id: 1,
      state: "PRINTING",
      progress: 99.0,
      timePrinting: 3600,
      timeRemaining: 10,
      fileName: "test.gcode",
      displayName: "test_0.2mm.gcode",
      currentLayer: 80,
      totalLayers: 80,
      posZMm: 12.4,
    };

    const finishingStatus: PrinterStatus = {
      ...idleStatus,
      state: "FINISHING",
    };

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        received.push(data.toString());
      });
    });

    setTimeout(() => {
      // Step 1: PRINTING with job — caches job
      agent.sendStatus(printingStatus, printingJob);

      setTimeout(() => {
        // Step 2: FINISHING with job=null — must use cached job and its id
        agent.sendStatus(finishingStatus, null);

        setTimeout(() => {
          // Step 3: IDLE — resets cachedJob
          agent.sendStatus(idleStatus, null);

          setTimeout(() => {
            const statusMsgs = received
              .map((m) => {
                try {
                  const p = JSON.parse(m);
                  return p.status !== undefined ? p : null;
                } catch {
                  return null;
                }
              })
              .filter(Boolean);

            // We expect at least 3 status messages
            expect(statusMsgs.length).toBeGreaterThanOrEqual(3);

            // Second message (FINISHING) must have:
            const finishingMsg = statusMsgs[1];
            expect(finishingMsg.status.state.flags.finishing).toBe(true);
            expect(finishingMsg.current_print_ts).toBeGreaterThan(0);
            expect(finishingMsg.current_print_ts).toBe(
              statusMsgs[0].current_print_ts
            );
            expect(finishingMsg.status.job.file.name).toBe("test_0.2mm.gcode");

            // Third message (IDLE) must have current_print_ts === -1
            const idleMsg = statusMsgs[2];
            expect(idleMsg.current_print_ts).toBe(-1);

            agent.disconnect();
            done();
          }, 50);
        }, 50);
      }, 50);
    }, 50);
  });

  it("preserves job context on direct PRINTING → FINISHED → IDLE (Prusa Core One path)", (done) => {
    const agent = createObicoAgent(
      { serverUrl: `http://localhost:${port}`, apiKey: "key" },
      mockHttp,
      mockDispatcher
    );
    agent.connect();

    const received: string[] = [];

    const printingJob: JobInfo = {
      id: 2,
      state: "PRINTING",
      progress: 100.0,
      timePrinting: 7200,
      timeRemaining: 0,
      fileName: "test.gcode",
      displayName: "test_0.2mm.gcode",
      currentLayer: 100,
      totalLayers: 100,
      posZMm: 20.0,
    };

    const finishedStatus: PrinterStatus = {
      ...idleStatus,
      state: "FINISHED",
    };

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        received.push(data.toString());
      });
    });

    setTimeout(() => {
      // Step 1: PRINTING with job — caches job
      agent.sendStatus(printingStatus, printingJob);

      setTimeout(() => {
        // Step 2: FINISHED with job=null — Prusa Core One skips FINISHING entirely
        // Must use cachedJob as fallback and emit Print Done signal
        agent.sendStatus(finishedStatus, null);

        setTimeout(() => {
          // Step 3: IDLE — full reset
          agent.sendStatus(idleStatus, null);

          setTimeout(() => {
            const statusMsgs = received
              .map((m) => {
                try {
                  const p = JSON.parse(m);
                  return p.status !== undefined ? p : null;
                } catch {
                  return null;
                }
              })
              .filter(Boolean);

            // We expect at least 3 status messages
            expect(statusMsgs.length).toBeGreaterThanOrEqual(3);

            // Second message (FINISHED) must carry job context from cache
            const finishedMsg = statusMsgs[1];
            expect(finishedMsg.status.state.flags.finishing).toBe(true);
            expect(finishedMsg.current_print_ts).toBe(-1); // Print Done signal
            expect(finishedMsg.status.job.file.name).toBe("test_0.2mm.gcode"); // from cachedJob
            expect(finishedMsg.status.job.file.path).toBe("/usb/test.gcode");

            // Third message (IDLE) must have current_print_ts === -1 and no job name
            const idleMsg = statusMsgs[2];
            expect(idleMsg.current_print_ts).toBe(-1);
            expect(idleMsg.status.job.file.name).toBeNull();

            agent.disconnect();
            done();
          }, 50);
        }, 50);
      }, 50);
    }, 50);
  });

  it("preserves cachedJob across multiple FINISHED polls until IDLE (Core One long FINISHED)", (done) => {
    const agent = createObicoAgent(
      { serverUrl: `http://localhost:${port}`, apiKey: "key" },
      mockHttp,
      mockDispatcher
    );
    agent.connect();

    const received: string[] = [];

    const printingJob: JobInfo = {
      id: 3,
      state: "PRINTING",
      progress: 100.0,
      timePrinting: 7200,
      timeRemaining: 0,
      fileName: "multiconnect.gcode",
      displayName: "multiconnect_0.2mm.gcode",
      currentLayer: 100,
      totalLayers: 100,
      posZMm: 20.0,
    };

    const finishedStatus: PrinterStatus = {
      ...idleStatus,
      state: "FINISHED",
    };

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        received.push(data.toString());
      });
    });

    setTimeout(() => {
      // Step 1: PRINTING — cache the job
      agent.sendStatus(printingStatus, printingJob);

      setTimeout(() => {
        // Step 2: 5× FINISHED poll with job=null — printer waiting for user ack at panel
        agent.sendStatus(finishedStatus, null);
        agent.sendStatus(finishedStatus, null);
        agent.sendStatus(finishedStatus, null);
        agent.sendStatus(finishedStatus, null);
        agent.sendStatus(finishedStatus, null);

        setTimeout(() => {
          // Step 3: IDLE — user acknowledged at panel
          agent.sendStatus(idleStatus, null);

          setTimeout(() => {
            const statusMsgs = received
              .map((m) => {
                try {
                  const p = JSON.parse(m);
                  return p.status !== undefined ? p : null;
                } catch {
                  return null;
                }
              })
              .filter(Boolean);

            // 1 PRINTING + 5 FINISHED + 1 IDLE = 7 status messages
            expect(statusMsgs.length).toBeGreaterThanOrEqual(7);

            // All 5 FINISHED messages (indexes 1-5) must carry cachedJob filename
            for (let i = 1; i <= 5; i++) {
              const msg = statusMsgs[i];
              expect(msg.status.state.flags.finishing).toBe(true);
              expect(msg.current_print_ts).toBe(-1);
              expect(msg.status.job.file.name).toBe("multiconnect_0.2mm.gcode");
              expect(msg.status.job.file.path).toBe("/usb/multiconnect.gcode");
            }

            // IDLE message (index 6) triggers reset → no job filename
            const idleMsg = statusMsgs[6];
            expect(idleMsg.current_print_ts).toBe(-1);
            expect(idleMsg.status.job.file.name).toBeNull();

            agent.disconnect();
            done();
          }, 50);
        }, 50);
      }, 50);
    }, 50);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// current_print_ts: a start timestamp per PrusaLink job id, kept across restarts
// ──────────────────────────────────────────────────────────────────────────────

function memoryStore(initial: PrintStart | null = null): PrintStartStore & {
  saved: PrintStart[];
} {
  let current = initial;
  const saved: PrintStart[] = [];
  return {
    saved,
    load: () => current,
    save: (record) => {
      current = record;
      saved.push(record);
    },
  };
}

describe("current_print_ts", () => {
  let wss: WebSocketServer;
  let port: number;
  const sockets: WebSocket[] = [];

  beforeEach((done) => {
    port = getPort();
    sockets.length = 0;
    wss = new WebSocketServer({ port });
    wss.on("connection", (ws) => sockets.push(ws));
    wss.on("listening", done);
  });

  afterEach((done) => {
    jest.restoreAllMocks();
    wss.close(done);
  });

  type Received = { current_print_ts: number | null; file: string | null };

  // One agent (one run of the bridge): connect, send each status, and return
  // every status message Obico received.
  async function run(
    store: PrintStartStore,
    statuses: Array<[PrinterStatus, JobInfo | null]>
  ): Promise<Received[]> {
    const agent = createObicoAgent(
      { serverUrl: `http://localhost:${port}`, apiKey: "key" },
      mockHttp,
      mockDispatcher,
      store
    );
    const before = sockets.length;
    agent.connect();
    while (sockets.length === before)
      await new Promise((r) => setTimeout(r, 10));
    const received: Received[] = [];
    sockets[before].on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.status)
        received.push({
          current_print_ts: msg.current_print_ts,
          file: msg.status.job.file.name,
        });
    });
    await new Promise((r) => setTimeout(r, 20));
    for (const [status, job] of statuses) agent.sendStatus(status, job);
    await new Promise((r) => setTimeout(r, 50));
    agent.disconnect();
    return received;
  }

  async function tsOf(
    store: PrintStartStore,
    statuses: Array<[PrinterStatus, JobInfo | null]>
  ): Promise<Array<number | null>> {
    return (await run(store, statuses)).map((m) => m.current_print_ts);
  }

  function mockNow(unixSeconds: number): void {
    jest.spyOn(Date, "now").mockReturnValue(unixSeconds * 1000);
  }

  const attentionStatus: PrinterStatus = { ...idleStatus, state: "ATTENTION" };
  const pausedStatus: PrinterStatus = { ...idleStatus, state: "PAUSED" };
  const busyStatus: PrinterStatus = { ...idleStatus, state: "BUSY" };
  const finishedStatus: PrinterStatus = { ...idleStatus, state: "FINISHED" };
  const job41: JobInfo = { ...activeJob, id: 41 };
  const job42: JobInfo = { ...activeJob, id: 42 };

  it("sends the start time of the job, the same before and after a restart", async () => {
    const store = memoryStore();
    mockNow(1_700_000_000);
    expect(await tsOf(store, [[printingStatus, job41]])).toEqual([
      1_700_000_000,
    ]);
    expect(store.saved).toEqual([{ jobId: 41, ts: 1_700_000_000 }]);

    mockNow(1_700_003_600);
    expect(await tsOf(store, [[printingStatus, job41]])).toEqual([
      1_700_000_000,
    ]);
    expect(store.saved).toHaveLength(1);
  });

  it("gives a new job id a new start time", async () => {
    const store = memoryStore({ jobId: 41, ts: 1_700_000_000 });
    mockNow(1_700_007_200);
    expect(await tsOf(store, [[printingStatus, job42]])).toEqual([
      1_700_007_200,
    ]);
    expect(store.saved).toEqual([{ jobId: 42, ts: 1_700_007_200 }]);
  });

  it("sends null, not -1 or a new value, until a restarted bridge knows the job", async () => {
    const store = memoryStore({ jobId: 41, ts: 1_700_000_000 });
    expect(
      await tsOf(store, [
        [printingStatus, null],
        [printingStatus, job41],
      ])
    ).toEqual([null, 1_700_000_000]);
  });

  it("keeps the start time through ATTENTION and PAUSED", async () => {
    const store = memoryStore();
    mockNow(1_700_000_000);
    expect(
      await tsOf(store, [
        [printingStatus, job41],
        [attentionStatus, job41],
        [pausedStatus, job41],
        [printingStatus, job41],
      ])
    ).toEqual([1_700_000_000, 1_700_000_000, 1_700_000_000, 1_700_000_000]);
  });

  it("does not end the print in BUSY (e.g. crash recovery)", async () => {
    const store = memoryStore();
    mockNow(1_700_000_000);
    expect(
      await tsOf(store, [
        [printingStatus, job41],
        [busyStatus, null],
        [printingStatus, job41],
      ])
    ).toEqual([1_700_000_000, null, 1_700_000_000]);
  });

  it("ends the print with -1 and gives the next print its own start time", async () => {
    const store = memoryStore();
    mockNow(1_700_000_000);
    const first = await tsOf(store, [
      [printingStatus, job41],
      [finishedStatus, null],
    ]);
    mockNow(1_700_000_600);
    const second = await tsOf(store, [
      [printingStatus, null],
      [printingStatus, job42],
    ]);
    expect([...first, ...second]).toEqual([
      1_700_000_000,
      -1,
      null,
      1_700_000_600,
    ]);
  });

  it("gives the same job id a new start time once its print was ended with -1", async () => {
    const store = memoryStore();
    const errorStatus: PrinterStatus = { ...idleStatus, state: "ERROR" };
    mockNow(1_700_000_000);
    const first = await tsOf(store, [
      [printingStatus, job41],
      [errorStatus, null],
    ]);
    expect(store.saved[store.saved.length - 1]).toEqual({
      jobId: 41,
      ts: 1_700_000_000,
      ended: true,
    });
    // After a restart, the same job continues: Obico refuses the ended ts.
    mockNow(1_700_000_120);
    const second = await tsOf(store, [[printingStatus, job41]]);
    expect([...first, ...second]).toEqual([1_700_000_000, -1, 1_700_000_120]);
    expect(store.saved[store.saved.length - 1]).toEqual({
      jobId: 41,
      ts: 1_700_000_120,
    });
  });

  it("marks the print as ended only once across repeated -1 ticks", async () => {
    const store = memoryStore();
    mockNow(1_700_000_000);
    await tsOf(store, [
      [printingStatus, job41],
      [finishedStatus, null],
      [finishedStatus, null],
      [idleStatus, null],
    ]);
    expect(store.saved).toEqual([
      { jobId: 41, ts: 1_700_000_000 },
      { jobId: 41, ts: 1_700_000_000, ended: true },
    ]);
  });

  it("resets the cached job on PRINTING → ATTENTION → IDLE", async () => {
    const store = memoryStore();
    const msgs = await run(store, [
      [printingStatus, job41],
      [attentionStatus, null],
      [idleStatus, null],
      // A FINISHED tick without a fresh job only shows a file name if the
      // cached job survived the IDLE tick.
      [finishedStatus, null],
    ]);
    expect(msgs.map((m) => m.file)).toEqual([
      "benchy_0.2mm.gcode",
      null,
      null,
      null,
    ]);
  });
});
