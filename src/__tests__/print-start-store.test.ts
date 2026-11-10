import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createFilePrintStartStore,
  createMemoryPrintStartStore,
  printStartStorePath,
} from "../obico/print-start-store";

describe("createFilePrintStartStore()", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "print-start-"));
    file = path.join(dir, "print-state.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true });
  });

  it("returns null when the file is missing", () => {
    expect(createFilePrintStartStore(file).load()).toBeNull();
  });

  it("returns null when the file is corrupt", () => {
    fs.writeFileSync(file, "{not json", "utf-8");
    expect(createFilePrintStartStore(file).load()).toBeNull();
  });

  it("returns null when the file has the wrong shape", () => {
    fs.writeFileSync(file, JSON.stringify({ jobId: "41" }), "utf-8");
    expect(createFilePrintStartStore(file).load()).toBeNull();
  });

  it("loads what an earlier store saved", () => {
    createFilePrintStartStore(file).save({ jobId: 41, ts: 1_700_000_000 });
    expect(createFilePrintStartStore(file).load()).toEqual({
      jobId: 41,
      ts: 1_700_000_000,
    });
  });

  it("keeps the ended flag", () => {
    createFilePrintStartStore(file).save({
      jobId: 41,
      ts: 1_700_000_000,
      ended: true,
    });
    expect(createFilePrintStartStore(file).load()).toEqual({
      jobId: 41,
      ts: 1_700_000_000,
      ended: true,
    });
  });

  it("writes atomically and leaves no temp file behind", () => {
    createFilePrintStartStore(file).save({ jobId: 41, ts: 1_700_000_000 });
    expect(fs.readdirSync(dir)).toEqual(["print-state.json"]);
  });

  it("does not throw when the file cannot be written", () => {
    const store = createFilePrintStartStore(
      path.join(dir, "missing-dir", "print-state.json")
    );
    expect(() => store.save({ jobId: 41, ts: 1_700_000_000 })).not.toThrow();
  });
});

describe("createMemoryPrintStartStore()", () => {
  it("starts empty and returns what was saved", () => {
    const store = createMemoryPrintStartStore();
    expect(store.load()).toBeNull();
    store.save({ jobId: 41, ts: 1_700_000_000 });
    expect(store.load()).toEqual({ jobId: 41, ts: 1_700_000_000 });
  });
});

describe("printStartStorePath()", () => {
  const original = process.env.CONFIG_PATH;
  afterEach(() => {
    if (original === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = original;
  });

  it("puts the file next to the config file", () => {
    process.env.CONFIG_PATH = "/data/sentry/config.json";
    expect(printStartStorePath()).toBe("/data/sentry/print-state.json");
  });

  it("defaults to /config", () => {
    delete process.env.CONFIG_PATH;
    expect(printStartStorePath()).toBe("/config/print-state.json");
  });
});
