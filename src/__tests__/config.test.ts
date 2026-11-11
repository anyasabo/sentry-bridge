import * as fs from "fs";

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return { ...actual, chmodSync: jest.fn(actual.chmodSync) };
});
import * as path from "path";
import * as os from "os";
import {
  loadConfig,
  saveConfig,
  isConfigured,
  configEmitter,
  Config,
} from "../config/config";

const validConfig = {
  prusalink: {
    url: "http://192.168.x.x",
    username: "maker",
    password: "secret",
  },
  camera: { rtspUrl: "rtsp://192.168.x.x/live", frameIntervalSeconds: 2 },
  obico: { serverUrl: "http://192.168.1.100:3334", apiKey: "abc123" },
  polling: { statusIntervalMs: 2000 },
};

function withTempConfig(content: string, fn: (filePath: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obico-test-"));
  const filePath = path.join(dir, "config.json");
  fs.writeFileSync(filePath, content, "utf-8");
  try {
    fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

describe("loadConfig()", () => {
  it("parses a valid config file", () => {
    withTempConfig(JSON.stringify(validConfig), (filePath) => {
      process.env.CONFIG_PATH = filePath;
      const config = loadConfig();
      expect(config.prusalink.url).toBe("http://192.168.x.x");
      expect(config.camera.frameIntervalSeconds).toBe(2);
      expect(config.obico.serverUrl).toBe("http://192.168.1.100:3334");
      expect(config.polling.statusIntervalMs).toBe(2000);
    });
  });

  it("throws a clear error when file is missing", () => {
    process.env.CONFIG_PATH = "/nonexistent/config.json";
    expect(() => loadConfig()).toThrow("Config file not found");
  });

  it("throws a clear error when JSON is invalid", () => {
    withTempConfig("not valid json {{{", (filePath) => {
      process.env.CONFIG_PATH = filePath;
      expect(() => loadConfig()).toThrow("Config file contains invalid JSON");
    });
  });
});

describe("saveConfig()", () => {
  it("writes the correct JSON structure to the config path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obico-test-"));
    const filePath = path.join(dir, "config.json");
    process.env.CONFIG_PATH = filePath;
    try {
      saveConfig(validConfig);
      const written = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(written).toEqual(validConfig);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe("isConfigured()", () => {
  it("returns false when config file does not exist", () => {
    process.env.CONFIG_PATH = "/nonexistent/config.json";
    expect(isConfigured()).toBe(false);
  });

  it("returns false when required fields are missing", () => {
    const incomplete = {
      prusalink: { url: "", username: "", password: "" },
      camera: { rtspUrl: "", frameIntervalSeconds: 2 },
      obico: { serverUrl: "", apiKey: "" },
      polling: { statusIntervalMs: 2000 },
    };
    withTempConfig(JSON.stringify(incomplete), (filePath) => {
      process.env.CONFIG_PATH = filePath;
      expect(isConfigured()).toBe(false);
    });
  });

  it("returns true when all required fields are present", () => {
    withTempConfig(JSON.stringify(validConfig), (filePath) => {
      process.env.CONFIG_PATH = filePath;
      expect(isConfigured()).toBe(true);
    });
  });
});

describe("configEmitter", () => {
  it("emits 'config-changed' with the new config after saveConfig", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obico-test-"));
    const filePath = path.join(dir, "config.json");
    process.env.CONFIG_PATH = filePath;
    const received: Config[] = [];
    const handler = (cfg: Config) => received.push(cfg);
    configEmitter.on("config-changed", handler);
    try {
      saveConfig(validConfig);
      expect(received).toHaveLength(1);
      expect(received[0].prusalink.url).toBe("http://192.168.x.x");
    } finally {
      configEmitter.off("config-changed", handler);
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("does not emit when fs.writeFileSync throws", () => {
    process.env.CONFIG_PATH = "/nonexistent-dir/config.json";
    const received: Config[] = [];
    const handler = (cfg: Config) => received.push(cfg);
    configEmitter.on("config-changed", handler);
    try {
      expect(() => saveConfig(validConfig)).toThrow();
      expect(received).toHaveLength(0);
    } finally {
      configEmitter.off("config-changed", handler);
    }
  });
});

describe("saveConfig() file mode", () => {
  const modeOf = (f: string) => fs.statSync(f).mode & 0o777;

  it("creates the config file with mode 0600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obico-mode-"));
    const filePath = path.join(dir, "config.json");
    process.env.CONFIG_PATH = filePath;
    try {
      saveConfig(validConfig as Config);
      expect(modeOf(filePath)).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("tightens the mode of an existing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obico-mode-"));
    const filePath = path.join(dir, "config.json");
    fs.writeFileSync(filePath, "{}", { mode: 0o644 });
    fs.chmodSync(filePath, 0o644);
    process.env.CONFIG_PATH = filePath;
    try {
      saveConfig(validConfig as Config);
      expect(modeOf(filePath)).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("still saves and emits config-changed when chmod fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obico-mode-"));
    const filePath = path.join(dir, "config.json");
    process.env.CONFIG_PATH = filePath;
    const chmod = fs.chmodSync as jest.Mock;
    chmod.mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const received: Config[] = [];
    const handler = (cfg: Config) => received.push(cfg);
    configEmitter.on("config-changed", handler);
    try {
      expect(() => saveConfig(validConfig as Config)).not.toThrow();
      expect(received).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(filePath, "utf-8")).obico.apiKey).toBe(
        "abc123"
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("EPERM");
    } finally {
      configEmitter.off("config-changed", handler);
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true });
    }
  });
});
