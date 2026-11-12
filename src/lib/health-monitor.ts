import { EventEmitter } from "events";

export enum HealthState {
  HEALTHY = "healthy",
  DEGRADED = "degraded",
  RECOVERING = "recovering",
  DOWN = "down",
}

export enum ErrorSeverity {
  WARN = "warn",
  ERROR = "error",
  CRITICAL = "critical",
}

export type ComponentName =
  "prusalink" | "camera" | "obico_ws" | "janus" | "rtp_stream" | "janus_relay";

// Camera stream broken while printer is reachable warrants a restart.
// PrusaLink DOWN (printer off) and obico_ws DOWN (reconnect handles it) do not.
const CRITICAL_COMPONENTS: ComponentName[] = ["camera"];

const MAX_ERRORS = 3;

export interface ErrorEntry {
  ts: number;
  msg: string;
  severity: ErrorSeverity;
}

export interface ComponentStats {
  state: HealthState;
  stateSince: number;
  restartCount: number;
  lastErrors: ErrorEntry[];
}

type ComponentHealth = Record<ComponentName, HealthState>;

export interface HealthMonitor {
  setState(component: ComponentName, state: HealthState): void;
  pushError(
    component: ComponentName,
    msg: string,
    severity?: ErrorSeverity
  ): void;
  /** Removes errors of a component, optionally only those matching `match`. */
  clearErrors(
    component: ComponentName,
    match?: (entry: ErrorEntry) => boolean
  ): void;
  incrementRestarts(component: ComponentName): void;
  getHealth(): Readonly<ComponentHealth>;
  getComponentStats(component: ComponentName): ComponentStats;
  getOverallState(): HealthState;
  isCritical(): boolean;
  on(
    event: "change",
    listener: (e: { component: ComponentName; state: HealthState }) => void
  ): void;
  off(event: "change", listener: (...args: unknown[]) => void): void;
}

const reportedErrors = new WeakSet<Error>();

/** Marks an error as already pushed to the health monitor by its source. */
export function markReported<E extends Error>(err: E): E {
  reportedErrors.add(err);
  return err;
}

export function isReported(err: unknown): boolean {
  return err instanceof Error && reportedErrors.has(err);
}

export interface HealthMonitorOptions {
  criticalTimeoutMs: number;
}

export function createHealthMonitor(opts: HealthMonitorOptions): HealthMonitor {
  const emitter = new EventEmitter();

  const health: ComponentHealth = {
    prusalink: HealthState.HEALTHY,
    camera: HealthState.HEALTHY,
    obico_ws: HealthState.HEALTHY,
    janus: HealthState.HEALTHY,
    rtp_stream: HealthState.HEALTHY,
    janus_relay: HealthState.HEALTHY,
  };

  const stateSince: Record<ComponentName, number> = {
    prusalink: Date.now(),
    camera: Date.now(),
    obico_ws: Date.now(),
    janus: Date.now(),
    rtp_stream: Date.now(),
    janus_relay: Date.now(),
  };

  const restartCounts: Record<ComponentName, number> = {
    prusalink: 0,
    camera: 0,
    obico_ws: 0,
    janus: 0,
    rtp_stream: 0,
    janus_relay: 0,
  };

  const lastErrors: Record<ComponentName, ErrorEntry[]> = {
    prusalink: [],
    camera: [],
    obico_ws: [],
    janus: [],
    rtp_stream: [],
    janus_relay: [],
  };

  const downSince = new Map<ComponentName, number>();

  return {
    setState(component, state) {
      if (health[component] === state) return;
      health[component] = state;
      stateSince[component] = Date.now();
      if (state === HealthState.HEALTHY) {
        lastErrors[component] = [];
      }

      if (CRITICAL_COMPONENTS.includes(component)) {
        if (state === HealthState.DOWN) {
          if (!downSince.has(component)) {
            downSince.set(component, Date.now());
          }
        } else {
          downSince.delete(component);
        }
      }

      emitter.emit("change", { component, state });
    },

    pushError(component, msg, severity = ErrorSeverity.ERROR) {
      const entry: ErrorEntry = { ts: Date.now(), msg, severity };
      lastErrors[component].push(entry);
      if (lastErrors[component].length > MAX_ERRORS) {
        lastErrors[component].shift();
      }
    },

    clearErrors(component, match) {
      lastErrors[component] = match
        ? lastErrors[component].filter((e) => !match(e))
        : [];
    },

    incrementRestarts(component) {
      restartCounts[component]++;
    },

    getHealth() {
      return { ...health };
    },

    getComponentStats(component) {
      return {
        state: health[component],
        stateSince: stateSince[component],
        restartCount: restartCounts[component],
        lastErrors: [...lastErrors[component]],
      };
    },

    getOverallState() {
      const states = Object.values(health) as HealthState[];
      if (states.includes(HealthState.DOWN)) return HealthState.DOWN;
      if (states.includes(HealthState.RECOVERING))
        return HealthState.RECOVERING;
      if (states.includes(HealthState.DEGRADED)) return HealthState.DEGRADED;
      return HealthState.HEALTHY;
    },

    isCritical() {
      // Only critical if printer is reachable but camera stream is broken.
      // If PrusaLink is down (printer off), a restart won't help.
      if (health["prusalink"] !== HealthState.HEALTHY) return false;
      const now = Date.now();
      for (const [, since] of downSince) {
        if (now - since > opts.criticalTimeoutMs) return true;
      }
      return false;
    },

    on(event, listener) {
      emitter.on(event, listener);
    },

    off(event, listener) {
      emitter.off(event, listener as (...args: unknown[]) => void);
    },
  };
}
