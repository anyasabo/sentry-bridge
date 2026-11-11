import { runBootChecks, BootCheckDeps, BootCheckResult } from "../boot/checks";
import { Config } from "../config/config";

const config: Config = {
  prusalink: {
    url: "http://printer",
    username: "maker",
    password: "s3cret-pw",
  },
  camera: { rtspUrl: "rtsp://printer/live", frameIntervalSeconds: 10 },
  obico: { serverUrl: "http://obico", apiKey: "secret-key" },
} as Config;

function deps(over: Partial<BootCheckDeps> = {}): BootCheckDeps {
  return {
    testPrusaLink: async () => ({ ok: true }),
    testCamera: async () => Buffer.from("jpeg"),
    reachObico: async () => undefined,
    ...over,
  };
}

const byId = (r: BootCheckResult[], id: string) => r.find((c) => c.id === id)!;

describe("runBootChecks", () => {
  it("passes every check for a healthy setup", async () => {
    const r = await runBootChecks(config, deps());
    expect(r.map((c) => c.id)).toEqual([
      "prusalink_reachable",
      "prusalink_auth",
      "camera_rtsp",
      "obico_reachable",
      "obico_paired",
    ]);
    expect(r.every((c) => c.ok && c.hint === null)).toBe(true);
  });

  it("flags only the credentials on a 401", async () => {
    const r = await runBootChecks(
      config,
      deps({
        testPrusaLink: async () => ({
          ok: false,
          reason: "unauthorized",
          error: "Auth failed",
        }),
      })
    );
    expect(byId(r, "prusalink_reachable").ok).toBe(true);
    expect(byId(r, "prusalink_auth")).toMatchObject({
      ok: false,
      hint: "prusalinkCredentials",
    });
  });

  it("flags reachability and skips auth when PrusaLink is down", async () => {
    const r = await runBootChecks(
      config,
      deps({
        testPrusaLink: async () => ({
          ok: false,
          reason: "unreachable",
          error: "401 ECONNREFUSED",
        }),
      })
    );
    expect(byId(r, "prusalink_reachable")).toMatchObject({
      ok: false,
      hint: "prusalinkUnreachable",
    });
    expect(byId(r, "prusalink_auth")).toMatchObject({
      ok: false,
      hint: "prusalinkUnreachable",
    });
  });

  it("flags an unreachable RTSP stream and Obico server", async () => {
    const r = await runBootChecks(
      config,
      deps({
        testCamera: async () => {
          throw new Error("ffmpeg failed");
        },
        reachObico: async () => {
          throw new Error("timeout");
        },
      })
    );
    expect(byId(r, "camera_rtsp")).toMatchObject({
      ok: false,
      hint: "cameraUnreachable",
    });
    expect(byId(r, "obico_reachable")).toMatchObject({
      ok: false,
      hint: "obicoUnreachable",
    });
  });

  it("flags a missing pairing token", async () => {
    const r = await runBootChecks(
      { ...config, obico: { serverUrl: "http://obico", apiKey: "" } },
      deps()
    );
    expect(byId(r, "obico_paired")).toMatchObject({
      ok: false,
      hint: "obicoNotPaired",
    });
  });

  it("never includes secrets in results", async () => {
    const r = await runBootChecks(
      config,
      deps({
        testPrusaLink: async () => ({
          ok: false,
          reason: "unreachable",
          error: "bad s3cret-pw",
        }),
      })
    );
    const json = JSON.stringify(r);
    expect(json).not.toContain("s3cret-pw");
    expect(json).not.toContain("secret-key");
  });
});
