import { PrinterStatus, JobInfo } from "../prusalink/types";

export interface ObicoAgentConfig {
  serverUrl: string;
  apiKey: string;
  streamUrl?: string;
  localPort?: number;
}

export interface HttpFetcher {
  fetch(url: string, options?: RequestInit): Promise<Response>;
}

export interface PrinterStatusMessage {
  current_print_ts: number | null;
  settings?: {
    webcams?: Array<{
      name: string;
      stream_id: number;
      stream_url: string;
      snapshot_url: string;
      is_primary_camera: boolean;
      stream_mode: string;
      flipV: boolean;
      flipH: boolean;
      rotation: number;
      streamRatio: string;
    }>;
  };
  status: {
    _ts: number;
    state: {
      text: string;
      flags: {
        operational: boolean;
        paused: boolean;
        printing: boolean;
        cancelling: boolean;
        pausing: boolean;
        resuming: boolean;
        finishing: boolean;
        closedOrError: boolean;
        error: boolean;
        ready: boolean;
        sdReady: boolean;
      };
      error: string | null;
    };
    job: {
      file: {
        name: string | null;
        path: string | null;
        obico_g_code_file_id: number | null;
      };
    };
    progress: {
      completion: number | null;
      filepos: number | null;
      printTime: number | null;
      printTimeLeft: number | null;
      filamentUsed: number | null;
      currentZ: number | null;
      currentLayer: number | null;
      totalLayers: number | null;
    };
    temperatures: {
      tool0: { actual: number; target: number };
      bed: { actual: number; target: number };
    };
    webcams?: Array<{
      name: string;
      stream_id: number;
      stream_url: string;
      snapshot_url: string;
      is_primary_camera: boolean;
      stream_mode: string;
      flipV: boolean;
      flipH: boolean;
      rotation: number;
      streamRatio: string;
    }>;
  };
  event?: { event_type: string };
}

export interface PrusaLinkCommandDispatcher {
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  startPrint(filename: string): Promise<void>;
  uploadFile(filename: string, data: Buffer): Promise<void>;
}

export interface ObicoAgent {
  connect(onOpen?: () => void): void;
  disconnect(code?: number): void;
  startPairing(serverUrl: string): Promise<string>;
  waitForPairing(
    serverUrl: string,
    code: string,
    timeoutMs?: number
  ): Promise<string>;
  sendStatus(status: PrinterStatus, job: JobInfo | null): void;
  sendFrame(jpeg: Buffer): Promise<void>;
  /** Fetch printer ID from Obico API. Returns null on failure. */
  fetchPrinterId(): Promise<number | null>;
  /** PATCH agent_name + agent_version so Obico frontend enables WebRTC. */
  updateAgentInfo(): Promise<void>;
  /**
   * Set the local Janus WS URL so the agent can forward Janus signaling messages
   * that Obico sends via the main agent WS ({@code /ws/dev/}).
   */
  setJanusUrl(url: string): void;
}

export function buildStatusMessage(
  status: PrinterStatus,
  job: JobInfo | null,
  streamUrl?: string,
  fileId?: number | null,
  printStartTs?: number | null
): PrinterStatusMessage {
  const now = Math.floor(Date.now() / 1000);
  const isPrinting = status.state === "PRINTING";
  const isPaused = status.state === "PAUSED" || status.state === "ATTENTION";
  const isFinishing = status.state === "FINISHING";
  const isError = status.state === "ERROR";
  const isReady = status.state === "IDLE";

  const webcamEntry = streamUrl
    ? {
        name: "camera",
        stream_id: 1,
        stream_url: streamUrl,
        snapshot_url: streamUrl.replace("/stream", "/api/camera/snapshot"),
        is_primary_camera: true,
        stream_mode: "h264_transcode",
        flipV: false,
        flipH: false,
        rotation: 0,
        streamRatio: "16:9",
      }
    : null;

  return {
    // Obico stores current_print_ts as Print.ext_id and starts a new print when it changes.
    // printStartTs is the time the bridge first saw PrusaLink's job id. The agent persists
    // the job id → start time mapping, so the value stays the same for one print, also
    // across a restart of the bridge. A timestamp (not the job id itself) stays unique
    // when the printer's 16-bit job counter wraps or is reset, and consecutive prints
    // differ by far more than Obico's ±20 skew window.
    // null means "unknown": Obico keeps its current print. -1 ends the current print.
    // BUSY can occur during a print (e.g. crash recovery), so it must not end the print.
    current_print_ts:
      isPrinting || isPaused || isFinishing
        ? (printStartTs ?? null)
        : status.state === "BUSY"
          ? null
          : -1,
    ...(webcamEntry ? { settings: { webcams: [webcamEntry] } } : {}),
    status: {
      _ts: now,
      state: {
        text: toStateText(status.state),
        flags: {
          operational: !isError,
          paused: isPaused,
          printing: isPrinting,
          cancelling: false,
          pausing: false,
          resuming: false,
          finishing: isFinishing || status.state === "FINISHED",
          closedOrError: isError,
          error: isError,
          ready: isReady,
          sdReady: true,
        },
        error: isError ? "Printer error" : null,
      },
      job: {
        file: {
          name: job?.displayName ?? job?.fileName ?? null,
          path: job?.fileName ? `/usb/${job.fileName}` : null,
          obico_g_code_file_id: fileId ?? null,
        },
      },
      progress: {
        completion: job?.progress ?? null,
        filepos: null,
        printTime: job?.timePrinting ?? null,
        printTimeLeft: job?.timeRemaining ?? null,
        filamentUsed: null,
        currentZ: job?.posZMm ?? status.axisZ ?? null,
        currentLayer: job?.currentLayer ?? null,
        totalLayers: job?.totalLayers ?? null,
      },
      temperatures: {
        tool0: { actual: status.tempNozzle, target: status.targetNozzle },
        bed: { actual: status.tempBed, target: status.targetBed },
      },
      ...(webcamEntry ? { webcams: [webcamEntry] } : {}),
    },
  };
}

function toStateText(state: PrinterStatus["state"]): string {
  const map: Record<PrinterStatus["state"], string> = {
    IDLE: "Operational",
    BUSY: "Busy",
    PRINTING: "Printing",
    PAUSED: "Paused",
    FINISHED: "Operational",
    FINISHING: "Finishing",
    STOPPED: "Operational",
    ERROR: "Error",
    ATTENTION: "Paused",
  };
  return map[state];
}
