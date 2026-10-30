import request from "supertest";
import { app } from "../server";
import { healthMonitor } from "../lib/health";
import { HealthState } from "../lib/health-monitor";
import { recordCameraFrame, recordFrameUpload } from "../lib/metrics";

async function scrape(): Promise<string> {
  const res = await request(app).get("/metrics");
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("text/plain");
  return res.text;
}

function value(text: string, series: string): number {
  const line = text.split("\n").find((l) => l.startsWith(`${series} `));
  if (!line) throw new Error(`${series} not in output`);
  return Number(line.slice(series.length + 1));
}

describe("GET /metrics", () => {
  it("reports when the camera last produced a frame", async () => {
    const before = Date.now() / 1000;
    recordCameraFrame();
    const ts = value(
      await scrape(),
      "sentry_bridge_camera_last_frame_timestamp_seconds"
    );
    expect(ts).toBeGreaterThanOrEqual(Math.floor(before));
  });

  it("counts frame uploads by result", async () => {
    const series = 'sentry_bridge_frame_uploads_total{result="failure"}';
    const before = value(await scrape(), series);
    recordFrameUpload(false);
    expect(value(await scrape(), series)).toBe(before + 1);
  });

  it("only moves the last-success time on a successful upload", async () => {
    const series = "sentry_bridge_frame_upload_last_success_timestamp_seconds";
    recordFrameUpload(true);
    const first = value(await scrape(), series);
    expect(first).toBeGreaterThan(0);
    recordFrameUpload(false);
    expect(value(await scrape(), series)).toBe(first);
  });

  it("exposes each component's state as a 1 on the current state", async () => {
    healthMonitor.setState("camera", HealthState.RECOVERING);
    const text = await scrape();
    healthMonitor.setState("camera", HealthState.HEALTHY);
    expect(
      value(
        text,
        'sentry_bridge_component_state{component="camera",state="recovering"}'
      )
    ).toBe(1);
    expect(
      value(
        text,
        'sentry_bridge_component_state{component="camera",state="healthy"}'
      )
    ).toBe(0);
  });

  it("exposes component restart counts", async () => {
    const series = 'sentry_bridge_component_restarts_total{component="janus"}';
    const before = value(await scrape(), series);
    healthMonitor.incrementRestarts("janus");
    expect(value(await scrape(), series)).toBe(before + 1);
  });

  it("is not swallowed by the frontend's catch-all route", async () => {
    const res = await request(app).get("/metrics");
    expect(res.text).not.toContain("<html");
  });
});
