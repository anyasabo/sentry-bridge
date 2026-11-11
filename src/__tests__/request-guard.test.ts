import request from "supertest";
import express from "express";
import {
  checkRequest,
  parseAllowedHosts,
  requestGuard,
} from "../lib/request-guard";

describe("checkRequest — Host check", () => {
  const allowed = (host: string | undefined, allowedHosts: string[] = []) =>
    checkRequest({ method: "GET", host }, allowedHosts).allowed;

  it.each([
    "192.168.1.50:3000",
    "127.0.0.1",
    "[::1]:3000",
    "[fe80::1]",
    "localhost:3000",
    "LOCALHOST",
    "sentry-bridge:3000",
    "printer-bridge",
    "bridge.local:3000",
    "Bridge.LOCAL",
  ])("allows %s", (host) => {
    expect(allowed(host)).toBe(true);
  });

  it.each([
    "evil.example.com",
    "evil.example.com:3000",
    "192.168.1.50.nip.io",
    "local",
    "",
    "::1",
    "[::1",
    "bad host",
    "a..b",
    ".local",
  ])("blocks %s", (host) => {
    expect(allowed(host)).toBe(false);
  });

  it("blocks a missing Host", () => {
    expect(allowed(undefined)).toBe(false);
  });

  it("allows hosts listed in ALLOWED_HOSTS, case-insensitive, port ignored", () => {
    const list = parseAllowedHosts(
      " Bridge.Example.com, printer.tail1234.ts.net ,"
    );
    expect(list).toEqual(["bridge.example.com", "printer.tail1234.ts.net"]);
    expect(allowed("bridge.example.com:443", list)).toBe(true);
    expect(allowed("PRINTER.tail1234.ts.net", list)).toBe(true);
    expect(allowed("other.example.com", list)).toBe(false);
  });

  it("parses an unset ALLOWED_HOSTS as empty", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
  });

  it("names ALLOWED_HOSTS in the rejection reason", () => {
    const d = checkRequest({ method: "GET", host: "evil.example.com" }, []);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("ALLOWED_HOSTS");
  });
});

describe("checkRequest — cross-site write check", () => {
  const host = "192.168.1.50:3000";
  const post = (headers: { origin?: string; secFetchSite?: string }) =>
    checkRequest({ method: "POST", host, ...headers }, []).allowed;

  it("allows a write without Origin and Sec-Fetch-Site", () => {
    expect(post({})).toBe(true);
  });

  it("allows a same-origin write", () => {
    expect(post({ origin: "http://192.168.1.50:3000" })).toBe(true);
  });

  it.each([
    "http://evil.example.com",
    "http://192.168.1.50",
    "http://192.168.1.50:8080",
    "http://192.168.1.51:3000",
    "null",
    "garbage",
  ])("blocks a write with Origin %s", (origin) => {
    expect(post({ origin })).toBe(false);
  });

  it("compares the Origin host case-insensitively", () => {
    expect(
      checkRequest(
        {
          method: "POST",
          host: "Bridge.local:3000",
          origin: "http://bridge.LOCAL:3000",
        },
        []
      ).allowed
    ).toBe(true);
  });

  it("allows a same-origin write over IPv6", () => {
    expect(
      checkRequest(
        { method: "DELETE", host: "[::1]:3000", origin: "http://[::1]:3000" },
        []
      ).allowed
    ).toBe(true);
  });

  it.each(["same-origin", "none"])("allows Sec-Fetch-Site %s", (s) => {
    expect(post({ secFetchSite: s })).toBe(true);
  });

  it.each(["cross-site", "same-site"])("blocks Sec-Fetch-Site %s", (s) => {
    expect(post({ secFetchSite: s, origin: "http://192.168.1.50:3000" })).toBe(
      false
    );
  });

  it("rejects writes behind a proxy that rewrites Host; allows them when Host is passed through", () => {
    const origin = "https://bridge.example.com";
    const allowedHosts = ["bridge.example.com"];
    expect(
      checkRequest(
        { method: "POST", host: "192.168.1.5:3000", origin },
        allowedHosts
      ).allowed
    ).toBe(false);
    expect(
      checkRequest(
        { method: "POST", host: "bridge.example.com", origin },
        allowedHosts
      ).allowed
    ).toBe(true);
  });

  it.each(["GET", "HEAD", "OPTIONS"])("does not check Origin on %s", (m) => {
    expect(
      checkRequest(
        {
          method: m,
          host,
          origin: "http://evil.example.com",
          secFetchSite: "cross-site",
        },
        []
      ).allowed
    ).toBe(true);
  });

  it.each(["PUT", "PATCH", "DELETE"])("checks Origin on %s", (m) => {
    expect(
      checkRequest({ method: m, host, origin: "http://evil.example.com" }, [])
        .allowed
    ).toBe(false);
  });
});

describe("requestGuard middleware", () => {
  const mockStartPrint = jest.fn();

  function createApp(allowedHosts: string[] = []) {
    const app = express();
    app.use(requestGuard(allowedHosts));
    app.post("/api/files/:name/print", (_req, res) => {
      mockStartPrint();
      res.json({ ok: true });
    });
    app.get("/api/status", (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  beforeEach(() => mockStartPrint.mockReset());

  it("rejects a cross-site print start with 403 and does not reach the route", async () => {
    const res = await request(createApp())
      .post("/api/files/x.gcode/print")
      .set("Host", "192.168.1.50:3000")
      .set("Origin", "http://evil.example.com");
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
    expect(mockStartPrint).not.toHaveBeenCalled();
  });

  it("allows a same-origin print start", async () => {
    const res = await request(createApp())
      .post("/api/files/x.gcode/print")
      .set("Host", "192.168.1.50:3000")
      .set("Origin", "http://192.168.1.50:3000");
    expect(res.status).toBe(200);
    expect(mockStartPrint).toHaveBeenCalledTimes(1);
  });

  it("allows a header-less print start (curl)", async () => {
    const res = await request(createApp())
      .post("/api/files/x.gcode/print")
      .set("Host", "192.168.1.50:3000");
    expect(res.status).toBe(200);
  });

  it("rejects an unknown Host with a JSON message naming ALLOWED_HOSTS", async () => {
    const res = await request(createApp())
      .get("/api/status")
      .set("Host", "rebind.evil.example.com:3000");
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("ALLOWED_HOSTS");
  });

  it("accepts a host from ALLOWED_HOSTS", async () => {
    const res = await request(createApp(["bridge.example.com"]))
      .get("/api/status")
      .set("Host", "bridge.example.com");
    expect(res.status).toBe(200);
  });
});
