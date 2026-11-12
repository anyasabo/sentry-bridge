import { Readable } from "node:stream";
import { createPrusaLinkClient, HttpFetcher } from "../prusalink/client";
import { PrusaLinkConfig } from "../prusalink/types";
import { resilienceConfig } from "../lib/env-config";
import { healthMonitor } from "../lib/health";
import { HealthState } from "../lib/health-monitor";

const config: PrusaLinkConfig = {
  baseUrl: "http://prusa.local",
  username: "maker",
  password: "secret",
};

const mockFetch = jest.fn();
const fetcher: HttpFetcher = { fetch: mockFetch };

beforeEach(() => {
  jest.clearAllMocks();
});

function mockResponse(status: number, body?: object): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body ?? {}),
    text: () => Promise.resolve(body ? JSON.stringify(body) : ""),
  } as unknown as Response;
}

const statusBody = {
  printer: {
    state: "IDLE",
    temp_bed: 25.2,
    target_bed: 0.0,
    temp_nozzle: 26.5,
    target_nozzle: 0.0,
    axis_z: 0.0,
    axis_x: 252.0,
    axis_y: -19.0,
    flow: 100,
    speed: 100,
    fan_hotend: 0,
    fan_print: 0,
  },
};

const jobBody = {
  id: 420,
  state: "PRINTING",
  progress: 42.5,
  time_printing: 1800,
  time_remaining: 2400,
  file: {
    name: "benchy.gcode",
    display_name: "benchy_0.2mm_PETG.gcode",
  },
};

describe("PrusaLinkClient", () => {
  describe("testConnection()", () => {
    it("returns ok:true on 200", async () => {
      mockFetch.mockResolvedValue(mockResponse(200, { hostname: "prusa" }));
      const client = createPrusaLinkClient(config, fetcher);
      const result = await client.testConnection();
      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://prusa.local/api/v1/info",
        expect.anything()
      );
    });

    it("returns ok:false on 401", async () => {
      mockFetch.mockResolvedValue(mockResponse(401));
      const client = createPrusaLinkClient(config, fetcher);
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/auth/i);
      expect(result.reason).toBe("unauthorized");
    });

    it("returns ok:false on network error", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      const client = createPrusaLinkClient(config, fetcher);
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("ECONNREFUSED");
      expect(result.reason).toBe("unreachable");
    });
  });

  describe("getStatus()", () => {
    it("maps PrusaLink response to internal model", async () => {
      mockFetch.mockResolvedValue(mockResponse(200, statusBody));
      const client = createPrusaLinkClient(config, fetcher);
      const status = await client.getStatus();
      expect(status.state).toBe("IDLE");
      expect(status.tempBed).toBe(25.2);
      expect(status.tempNozzle).toBe(26.5);
      expect(status.axisX).toBe(252.0);
      expect(status.flow).toBe(100);
      expect(status.fanPrint).toBe(0);
    });

    it("throws on non-200 response", async () => {
      mockFetch.mockResolvedValue(mockResponse(500));
      const client = createPrusaLinkClient(config, fetcher);
      await expect(client.getStatus()).rejects.toThrow();
    });
  });

  describe("getJob() logging", () => {
    it("does not log job body details", async () => {
      const consoleSpy = jest
        .spyOn(console, "log")
        .mockImplementation(() => {});
      try {
        mockFetch.mockResolvedValue(mockResponse(200, jobBody));
        const client = createPrusaLinkClient(config, fetcher);
        await client.getJob();
        expect(consoleSpy).not.toHaveBeenCalled();
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe("getJob()", () => {
    it("returns null when printer is idle (204)", async () => {
      mockFetch.mockResolvedValue(mockResponse(204));
      const client = createPrusaLinkClient(config, fetcher);
      const job = await client.getJob();
      expect(job).toBeNull();
    });

    it("returns job info when printing", async () => {
      mockFetch.mockResolvedValue(mockResponse(200, jobBody));
      const client = createPrusaLinkClient(config, fetcher);
      const job = await client.getJob();
      expect(job).not.toBeNull();
      expect(job!.id).toBe(420);
      expect(job!.progress).toBe(42.5);
      expect(job!.fileName).toBe("benchy.gcode");
      expect(job!.displayName).toBe("benchy_0.2mm_PETG.gcode");
      expect(job!.timePrinting).toBe(1800);
      expect(job!.timeRemaining).toBe(2400);
    });

    it("returns job info with null fileName when file is absent (serial print)", async () => {
      const serialJobBody = {
        id: 7,
        state: "PRINTING",
        progress: 12.0,
        time_printing: 300,
        time_remaining: 1800,
      }; // kein file-Feld
      mockFetch.mockResolvedValue(mockResponse(200, serialJobBody));
      const client = createPrusaLinkClient(config, fetcher);
      const job = await client.getJob();
      expect(job).not.toBeNull();
      expect(job!.fileName).toBeNull();
      expect(job!.displayName).toBeNull();
    });

    it("extracts currentLayer/totalLayers/posZMm from response", async () => {
      const layerJobBody = {
        ...jobBody,
        current_layer: 12,
        total_layers: 80,
        pos_z_mm: 4.6,
      };
      mockFetch.mockResolvedValue(mockResponse(200, layerJobBody));
      const client = createPrusaLinkClient(config, fetcher);
      const job = await client.getJob();
      expect(job).not.toBeNull();
      expect(job!.currentLayer).toBe(12);
      expect(job!.totalLayers).toBe(80);
      expect(job!.posZMm).toBe(4.6);
    });

    it("returns null for layer/z fields when missing from response", async () => {
      mockFetch.mockResolvedValue(mockResponse(200, jobBody));
      const client = createPrusaLinkClient(config, fetcher);
      const job = await client.getJob();
      expect(job).not.toBeNull();
      expect(job!.currentLayer).toBeNull();
      expect(job!.totalLayers).toBeNull();
      expect(job!.posZMm).toBeNull();
    });
  });

  describe("pause()", () => {
    it("fetches job ID then sends PUT pause", async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(200, jobBody))
        .mockResolvedValueOnce(mockResponse(204));
      const client = createPrusaLinkClient(config, fetcher);
      await client.pause();
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "http://prusa.local/api/v1/job",
        expect.anything()
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "http://prusa.local/api/v1/job/420/pause",
        expect.objectContaining({ method: "PUT" })
      );
    });

    it("throws when no active job", async () => {
      mockFetch.mockResolvedValue(mockResponse(204));
      const client = createPrusaLinkClient(config, fetcher);
      await expect(client.pause()).rejects.toThrow(/no active job/i);
    });

    it("throws on 409 conflict", async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(200, jobBody))
        .mockResolvedValueOnce(mockResponse(409));
      const client = createPrusaLinkClient(config, fetcher);
      await expect(client.pause()).rejects.toThrow(/conflict/i);
    });
  });

  describe("resume()", () => {
    it("fetches job ID then sends PUT resume", async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(200, jobBody))
        .mockResolvedValueOnce(mockResponse(204));
      const client = createPrusaLinkClient(config, fetcher);
      await client.resume();
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "http://prusa.local/api/v1/job/420/resume",
        expect.objectContaining({ method: "PUT" })
      );
    });

    it("throws on 409 conflict", async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(200, jobBody))
        .mockResolvedValueOnce(mockResponse(409));
      const client = createPrusaLinkClient(config, fetcher);
      await expect(client.resume()).rejects.toThrow(/conflict/i);
    });
  });

  describe("cancel()", () => {
    it("fetches job ID then sends DELETE", async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(200, jobBody))
        .mockResolvedValueOnce(mockResponse(204));
      const client = createPrusaLinkClient(config, fetcher);
      await client.cancel();
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "http://prusa.local/api/v1/job/420",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("throws on 409 conflict", async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(200, jobBody))
        .mockResolvedValueOnce(mockResponse(409));
      const client = createPrusaLinkClient(config, fetcher);
      await expect(client.cancel()).rejects.toThrow(/conflict/i);
    });
  });

  describe("CB coverage for mutations", () => {
    async function openCircuitBreaker(
      client: ReturnType<typeof createPrusaLinkClient>
    ) {
      const threshold = resilienceConfig.circuitBreaker.threshold;
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      for (let i = 0; i < threshold; i++) {
        try {
          await client.getStatus();
        } catch {}
      }
      mockFetch.mockClear();
    }

    it("pause() wirft 'Circuit breaker is OPEN' wenn CB offen ist", async () => {
      const client = createPrusaLinkClient(config, fetcher);
      await openCircuitBreaker(client);
      await expect(client.pause()).rejects.toThrow("Circuit breaker is OPEN");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("resume() wirft 'Circuit breaker is OPEN' wenn CB offen ist", async () => {
      const client = createPrusaLinkClient(config, fetcher);
      await openCircuitBreaker(client);
      await expect(client.resume()).rejects.toThrow("Circuit breaker is OPEN");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("cancel() wirft 'Circuit breaker is OPEN' wenn CB offen ist", async () => {
      const client = createPrusaLinkClient(config, fetcher);
      await openCircuitBreaker(client);
      await expect(client.cancel()).rejects.toThrow("Circuit breaker is OPEN");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("listFiles()", () => {
    const filesBody = {
      children: [
        {
          name: "benchy.gcode",
          type: "PRINT_FILE",
          size: 123456,
          m_timestamp: 1712476800,
        },
        { name: "calibration", type: "FOLDER", m_timestamp: 1712476800 },
        {
          name: "firmware.bbf",
          type: "FIRMWARE",
          size: 5000,
          m_timestamp: 1712476800,
        },
      ],
    };

    it("gibt nur PRINT_FILE Einträge zurück", async () => {
      mockFetch.mockResolvedValue(mockResponse(200, filesBody));
      const client = createPrusaLinkClient(config, fetcher);
      const files = await client.listFiles();
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe("benchy.gcode");
    });

    it("mappt m_timestamp zu ISO-String", async () => {
      mockFetch.mockResolvedValue(mockResponse(200, filesBody));
      const client = createPrusaLinkClient(config, fetcher);
      const files = await client.listFiles();
      expect(files[0].date).toBe(new Date(1712476800 * 1000).toISOString());
    });

    it("setzt size auf 0 wenn size fehlt", async () => {
      const body = {
        children: [
          { name: "nosize.gcode", type: "PRINT_FILE", m_timestamp: 0 },
        ],
      };
      mockFetch.mockResolvedValue(mockResponse(200, body));
      const client = createPrusaLinkClient(config, fetcher);
      const files = await client.listFiles();
      expect(files[0].size).toBe(0);
    });

    it("setzt path auf /usb/{name}", async () => {
      mockFetch.mockResolvedValue(mockResponse(200, filesBody));
      const client = createPrusaLinkClient(config, fetcher);
      const files = await client.listFiles();
      expect(files[0].path).toBe("/usb/benchy.gcode");
    });

    it("wirft bei non-2xx", async () => {
      mockFetch.mockResolvedValue(mockResponse(500));
      const client = createPrusaLinkClient(config, fetcher);
      await expect(client.listFiles()).rejects.toThrow(/listFiles failed/);
    });

    it("ruft GET /api/v1/files/usb/ auf", async () => {
      mockFetch.mockResolvedValue(mockResponse(200, { children: [] }));
      const client = createPrusaLinkClient(config, fetcher);
      await client.listFiles();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://prusa.local/api/v1/files/usb/",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("extracts display_name from response", async () => {
      const body = {
        children: [
          {
            name: "BENCHY~1.GCO",
            display_name: "benchy_0.2mm_PETG.gcode",
            type: "PRINT_FILE",
            size: 123456,
            m_timestamp: 1712476800,
          },
        ],
      };
      mockFetch.mockResolvedValue(mockResponse(200, body));
      const client = createPrusaLinkClient(config, fetcher);
      const files = await client.listFiles();
      expect(files[0].name).toBe("BENCHY~1.GCO");
      expect(files[0].displayName).toBe("benchy_0.2mm_PETG.gcode");
    });

    it("falls back to name when display_name missing", async () => {
      const body = {
        children: [
          {
            name: "benchy.gcode",
            type: "PRINT_FILE",
            size: 123456,
            m_timestamp: 1712476800,
          },
        ],
      };
      mockFetch.mockResolvedValue(mockResponse(200, body));
      const client = createPrusaLinkClient(config, fetcher);
      const files = await client.listFiles();
      expect(files[0].displayName).toBe("benchy.gcode");
    });
  });

  describe("uploadFile()", () => {
    it("sendet PUT auf /api/v1/files/usb/{filename}", async () => {
      mockFetch.mockResolvedValue(mockResponse(201));
      const client = createPrusaLinkClient(config, fetcher);
      const data = Buffer.from("fake gcode");
      await client.uploadFile("benchy.gcode", data);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://prusa.local/api/v1/files/usb/benchy.gcode",
        expect.objectContaining({ method: "PUT" })
      );
    });

    it("setzt Content-Length Header auf Buffer-Größe", async () => {
      mockFetch.mockResolvedValue(mockResponse(201));
      const client = createPrusaLinkClient(config, fetcher);
      const data = Buffer.from("fake gcode");
      await client.uploadFile("benchy.gcode", data);
      const call = mockFetch.mock.calls[0][1];
      expect(call.headers["Content-Length"]).toBe(String(data.byteLength));
    });

    it("setzt Content-Type: application/octet-stream", async () => {
      mockFetch.mockResolvedValue(mockResponse(201));
      const client = createPrusaLinkClient(config, fetcher);
      const data = Buffer.from("fake gcode");
      await client.uploadFile("benchy.gcode", data);
      const call = mockFetch.mock.calls[0][1];
      expect(call.headers["Content-Type"]).toBe("application/octet-stream");
    });

    it("übergibt Buffer als body", async () => {
      mockFetch.mockResolvedValue(mockResponse(201));
      const client = createPrusaLinkClient(config, fetcher);
      const data = Buffer.from("fake gcode");
      await client.uploadFile("benchy.gcode", data);
      const call = mockFetch.mock.calls[0][1];
      expect(call.body).toBe(data);
    });

    it("wirft bei non-2xx", async () => {
      mockFetch.mockResolvedValue(mockResponse(500));
      const client = createPrusaLinkClient(config, fetcher);
      await expect(
        client.uploadFile("benchy.gcode", Buffer.from("fake gcode"))
      ).rejects.toThrow(/uploadFile failed/);
    });
  });

  describe("deleteFile()", () => {
    it("sendet DELETE auf /api/v1/files/usb/{filename}", async () => {
      mockFetch.mockResolvedValue(mockResponse(204));
      const client = createPrusaLinkClient(config, fetcher);
      await client.deleteFile("benchy.gcode");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://prusa.local/api/v1/files/usb/benchy.gcode",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("wirft bei non-2xx", async () => {
      mockFetch.mockResolvedValue(mockResponse(500));
      const client = createPrusaLinkClient(config, fetcher);
      await expect(client.deleteFile("benchy.gcode")).rejects.toThrow(
        /deleteFile failed/
      );
    });

    it("gibt erfolgreich zurück bei 204", async () => {
      mockFetch.mockResolvedValue(mockResponse(204));
      const client = createPrusaLinkClient(config, fetcher);
      await expect(client.deleteFile("benchy.gcode")).resolves.toBeUndefined();
    });
  });

  describe("startPrint()", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("sendet HEAD bis 200 dann POST", async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(404)) // HEAD 1
        .mockResolvedValueOnce(mockResponse(404)) // HEAD 2
        .mockResolvedValueOnce(mockResponse(200)) // HEAD 3 -> ok
        .mockResolvedValueOnce(mockResponse(204)); // POST
      const client = createPrusaLinkClient(config, fetcher);
      const promise = client.startPrint("benchy.gcode");
      await jest.runAllTimersAsync();
      await promise;
      const headCalls = mockFetch.mock.calls.filter(
        (c) => c[1]?.method === "HEAD"
      );
      const postCalls = mockFetch.mock.calls.filter(
        (c) => c[1]?.method === "POST"
      );
      expect(headCalls).toHaveLength(3);
      expect(postCalls).toHaveLength(1);
    });

    it("sendet POST direkt wenn HEAD sofort 200", async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(200)) // HEAD sofort ok
        .mockResolvedValueOnce(mockResponse(204)); // POST
      const client = createPrusaLinkClient(config, fetcher);
      const promise = client.startPrint("benchy.gcode");
      await jest.runAllTimersAsync();
      await promise;
      const headCalls = mockFetch.mock.calls.filter(
        (c) => c[1]?.method === "HEAD"
      );
      const postCalls = mockFetch.mock.calls.filter(
        (c) => c[1]?.method === "POST"
      );
      expect(headCalls).toHaveLength(1);
      expect(postCalls).toHaveLength(1);
    });

    it("wirft nach 10 fehlgeschlagenen HEAD-Versuchen", async () => {
      mockFetch.mockResolvedValue(mockResponse(404));
      const client = createPrusaLinkClient(config, fetcher);
      const rejectAssertion = expect(
        client.startPrint("benchy.gcode")
      ).rejects.toThrow();
      await jest.runAllTimersAsync();
      await rejectAssertion;
      const headCalls = mockFetch.mock.calls.filter(
        (c) => c[1]?.method === "HEAD"
      );
      expect(headCalls).toHaveLength(10);
      const postCalls = mockFetch.mock.calls.filter(
        (c) => c[1]?.method === "POST"
      );
      expect(postCalls).toHaveLength(0);
    });

    it("wirft wenn POST fehlschlägt", async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(200)) // HEAD ok
        .mockResolvedValueOnce(mockResponse(500)); // POST fails
      const client = createPrusaLinkClient(config, fetcher);
      const rejectAssertion = expect(
        client.startPrint("benchy.gcode")
      ).rejects.toThrow(/startPrint failed/);
      await jest.runAllTimersAsync();
      await rejectAssertion;
    });
  });

  describe("request timeout (#112)", () => {
    function hangingFetch(url: string, opts?: RequestInit): Promise<Response> {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      });
    }

    it("aborts a hanging request after the timeout and passes an AbortSignal", async () => {
      mockFetch.mockImplementation(hangingFetch);
      const client = createPrusaLinkClient(config, fetcher, { timeoutMs: 20 });
      await expect(client.getStatus()).rejects.toThrow(/timed out/i);
      const opts = mockFetch.mock.calls[0][1] as RequestInit;
      expect(opts.signal?.aborted).toBe(true);
    });

    it("rejects even if the fetcher ignores the abort signal", async () => {
      mockFetch.mockImplementation(() => new Promise(() => {}));
      const client = createPrusaLinkClient(config, fetcher, { timeoutMs: 20 });
      await expect(client.getJob()).rejects.toThrow(/timed out/i);
    });

    it("aborts when headers arrive but the body stalls", async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        ok: true,
        json: () => new Promise(() => {}),
      });
      const client = createPrusaLinkClient(config, fetcher, { timeoutMs: 20 });
      await expect(client.getStatus()).rejects.toThrow(/timed out/i);
    });

    it("counts timeouts toward the circuit breaker", async () => {
      mockFetch.mockImplementation(hangingFetch);
      const client = createPrusaLinkClient(config, fetcher, { timeoutMs: 5 });
      for (let i = 0; i < resilienceConfig.circuitBreaker.threshold; i++) {
        await expect(client.getStatus()).rejects.toThrow(/timed out/i);
      }
      mockFetch.mockClear();
      await expect(client.getStatus()).rejects.toThrow(
        "Circuit breaker is OPEN"
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("HTTP status and the circuit breaker (#114)", () => {
    const threshold = () => resilienceConfig.circuitBreaker.threshold;

    it("opens the breaker after repeated 5xx responses", async () => {
      mockFetch.mockResolvedValue(mockResponse(503));
      const client = createPrusaLinkClient(config, fetcher);
      for (let i = 0; i < threshold(); i++) {
        await expect(client.getStatus()).rejects.toThrow("503");
      }
      mockFetch.mockClear();
      await expect(client.getStatus()).rejects.toThrow(
        "Circuit breaker is OPEN"
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([401, 404, 409])(
      "does not open the breaker on repeated %i responses",
      async (status) => {
        mockFetch.mockResolvedValue(mockResponse(status));
        const client = createPrusaLinkClient(config, fetcher);
        for (let i = 0; i < threshold() + 1; i++) {
          await client.testConnection();
        }
        mockFetch.mockResolvedValue(mockResponse(200, statusBody));
        await expect(client.getStatus()).resolves.toMatchObject({
          state: "IDLE",
        });
      }
    );

    it("cancels the 5xx response body and marks PrusaLink DEGRADED", async () => {
      const cancel = jest.fn().mockResolvedValue(undefined);
      mockFetch.mockResolvedValue({
        ...mockResponse(503),
        body: { cancel },
      });
      const client = createPrusaLinkClient(config, fetcher);
      await expect(client.getStatus()).rejects.toThrow("503");
      expect(cancel).toHaveBeenCalled();
      expect(healthMonitor.getHealth().prusalink).toBe(HealthState.DEGRADED);
    });

    it("testConnection() still reports a 500 as unreachable", async () => {
      mockFetch.mockResolvedValue(mockResponse(500));
      const client = createPrusaLinkClient(config, fetcher);
      const result = await client.testConnection();
      expect(result).toMatchObject({ ok: false, reason: "unreachable" });
      expect(result.error).toMatch(/500/);
    });
  });
});
