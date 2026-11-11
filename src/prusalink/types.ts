export interface PrusaLinkConfig {
  baseUrl: string;
  username: string;
  password: string;
}

export interface PrinterStatus {
  state:
    | "IDLE"
    | "READY"
    | "BUSY"
    | "PRINTING"
    | "PAUSED"
    | "FINISHED"
    // Not reported by current Buddy firmware (it maps finishing to PRINTING);
    // kept for older/other firmware.
    | "FINISHING"
    | "STOPPED"
    | "ERROR"
    | "ATTENTION"
    | "UNKNOWN";
  tempBed: number;
  targetBed: number;
  tempNozzle: number;
  targetNozzle: number;
  axisZ: number;
  axisX: number;
  axisY: number;
  flow: number;
  speed: number;
  fanHotend: number;
  fanPrint: number;
}

export interface JobInfo {
  id: number;
  state: "PRINTING" | "PAUSED" | "FINISHED" | "STOPPED" | "ERROR";
  progress: number;
  timePrinting: number;
  timeRemaining: number;
  fileName: string | null; // null wenn serieller Druck (kein file-Feld in Response)
  displayName: string | null; // null wenn serieller Druck
  currentLayer: number | null;
  totalLayers: number | null;
  posZMm: number | null;
}

export interface PrinterInfo {
  hostname: string;
}

export interface FileEntry {
  name: string;
  displayName: string;
  path: string;
  size: number;
  date: string; // ISO-String
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Why the test failed: the printer rejected the credentials, or it could
   *  not be reached / answered with an error. Absent when ok. */
  reason?: "unauthorized" | "unreachable";
  error?: string;
}

export interface PrusaLinkClient {
  testConnection(): Promise<ConnectionTestResult>;
  getInfo(): Promise<PrinterInfo>;
  getStatus(): Promise<PrinterStatus>;
  getJob(): Promise<JobInfo | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  listFiles(): Promise<FileEntry[]>;
  uploadFile(filename: string, data: Buffer): Promise<void>;
  startPrint(filename: string): Promise<void>;
  deleteFile(filename: string): Promise<void>;
}
