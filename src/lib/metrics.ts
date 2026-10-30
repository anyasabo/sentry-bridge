import { collectDefaultMetrics, Counter, Gauge, Registry } from "prom-client";
import { healthMonitor } from "./health";
import { HealthState, type ComponentName } from "./health-monitor";

const COMPONENTS: ComponentName[] = [
  "prusalink",
  "camera",
  "obico_ws",
  "janus",
  "rtp_stream",
  "janus_relay",
];

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

const lastFrame = new Gauge({
  name: "sentry_bridge_camera_last_frame_timestamp_seconds",
  help: "When the camera last produced a frame. 0 if it has not yet.",
  registers: [metricsRegistry],
});

const uploads = new Counter({
  name: "sentry_bridge_frame_uploads_total",
  help: "Frames sent to Obico for failure detection, by result.",
  labelNames: ["result"],
  registers: [metricsRegistry],
});

const lastUpload = new Gauge({
  name: "sentry_bridge_frame_upload_last_success_timestamp_seconds",
  help: "When Obico last accepted a frame. 0 if it has not yet.",
  registers: [metricsRegistry],
});

new Gauge({
  name: "sentry_bridge_component_state",
  help: "1 on the state each component is in, 0 on the others.",
  labelNames: ["component", "state"],
  registers: [metricsRegistry],
  collect() {
    const health = healthMonitor.getHealth();
    for (const component of COMPONENTS) {
      for (const state of Object.values(HealthState)) {
        this.set({ component, state }, health[component] === state ? 1 : 0);
      }
    }
  },
});

new Counter({
  name: "sentry_bridge_component_restarts_total",
  help: "Times each component has been restarted.",
  labelNames: ["component"],
  registers: [metricsRegistry],
  collect() {
    this.reset();
    for (const component of COMPONENTS) {
      const { restartCount } = healthMonitor.getComponentStats(component);
      this.inc({ component }, restartCount);
    }
  },
});

uploads.inc({ result: "success" }, 0);
uploads.inc({ result: "failure" }, 0);

export function recordCameraFrame(): void {
  lastFrame.setToCurrentTime();
}

export function recordFrameUpload(succeeded: boolean): void {
  uploads.inc({ result: succeeded ? "success" : "failure" });
  if (succeeded) lastUpload.setToCurrentTime();
}
