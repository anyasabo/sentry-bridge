import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filePrintSessionStore } from "../obico/print-session";

describe("filePrintSessionStore()", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "print-session-"));
    path = join(dir, "print-session.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves, loads and clears", () => {
    const store = filePrintSessionStore(path);
    expect(store.load()).toBeNull();
    store.save({ jobId: 3, startTs: 1_700_000_000 });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      jobId: 3,
      startTs: 1_700_000_000,
    });
    expect(filePrintSessionStore(path).load()).toEqual({
      jobId: 3,
      startTs: 1_700_000_000,
    });
    store.clear();
    expect(existsSync(path)).toBe(false);
    expect(store.load()).toBeNull();
  });

  it("treats a corrupt or wrongly shaped file as no session", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(path, "{not json");
    expect(filePrintSessionStore(path).load()).toBeNull();
    writeFileSync(path, JSON.stringify({ jobId: "3", startTs: 1 }));
    expect(filePrintSessionStore(path).load()).toBeNull();
    warn.mockRestore();
  });

  it("does not throw when the folder cannot be written", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const store = filePrintSessionStore(join(dir, "missing", "\0bad"));
    expect(() => store.save({ jobId: 1, startTs: 1 })).not.toThrow();
    expect(() => store.clear()).not.toThrow();
    warn.mockRestore();
  });
});
