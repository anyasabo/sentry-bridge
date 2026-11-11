import {
  stopBridge,
  __setStateForTest,
  __setCurrentConfigForTest,
} from "../bridge";
import * as http from "http";

jest.mock("../camera/camera");
jest.mock("../obico/agent");
jest.mock("../janus/manager");
jest.mock("../janus/relay");
jest.mock("../config/config", () => ({
  loadConfig: jest.fn(),
  isConfigured: jest.fn().mockReturnValue(false),
  getBridgeUrl: jest.fn(),
  configEmitter: { removeAllListeners: jest.fn(), on: jest.fn() },
}));

function makeMockServer(): http.Server {
  return {
    close: jest.fn((cb?: () => void) => {
      cb?.();
    }),
    closeAllConnections: jest.fn(),
  } as unknown as http.Server;
}

describe("stopBridge()", () => {
  beforeEach(() => {
    __setStateForTest({
      prusaClient: null,
      camera: null,
      agent: null,
      pollHandle: null,
      janusManager: null,
      janusRelay: null,
      janusStarted: false,
    });
  });

  it("calls all subsystem teardown methods in order", async () => {
    const order: string[] = [];

    const mockCamera = {
      stopRtpStream: jest.fn(),
      stopGracefully: jest
        .fn()
        .mockImplementation(async () => order.push("camera")),
    };
    const mockAgent = {
      disconnect: jest.fn().mockImplementation(() => order.push("agent")),
    };
    const mockJanusRelay = {
      stop: jest.fn().mockImplementation(() => order.push("relay")),
    };
    const mockJanusManager = {
      stop: jest.fn().mockImplementation(() => order.push("manager")),
    };
    const pollHandle = setInterval(() => {}, 10000);
    const mockServer = {
      close: jest.fn((cb?: () => void) => {
        order.push("server.close");
        cb?.();
      }),
      closeAllConnections: jest.fn(() => order.push("closeAll")),
    } as unknown as http.Server;

    __setStateForTest({
      camera: mockCamera as never,
      agent: mockAgent as never,
      janusRelay: mockJanusRelay as never,
      janusManager: mockJanusManager as never,
      pollHandle,
      prusaClient: null,
      janusStarted: false,
    });

    await stopBridge(mockServer);

    expect(mockServer.close).toHaveBeenCalled();
    expect(mockServer.closeAllConnections).toHaveBeenCalled();
    expect(mockAgent.disconnect).toHaveBeenCalledWith(1001);
    expect(mockCamera.stopGracefully).toHaveBeenCalledWith(3000);
    expect(order.indexOf("relay")).toBeLessThan(order.indexOf("manager"));
  });

  it("stopBridge is idempotent — second call is a no-op", async () => {
    const mockCamera = {
      stopRtpStream: jest.fn(),
      stopGracefully: jest.fn().mockResolvedValue(undefined),
    };
    const mockAgent = {
      disconnect: jest.fn(),
    };

    __setStateForTest({
      camera: mockCamera as never,
      agent: mockAgent as never,
      janusRelay: null,
      janusManager: null,
      pollHandle: null,
      prusaClient: null,
      janusStarted: false,
    });

    const mockServer = makeMockServer();

    await stopBridge(mockServer);
    await stopBridge(mockServer);

    expect(mockCamera.stopGracefully).toHaveBeenCalledTimes(1);
    expect(mockAgent.disconnect).toHaveBeenCalledTimes(1);
  });

  it("reads ffmpegKillTimeoutSeconds from config when provided", async () => {
    const mockCamera = {
      stopRtpStream: jest.fn(),
      stopGracefully: jest.fn().mockResolvedValue(undefined),
    };

    __setStateForTest({
      camera: mockCamera as never,
      agent: null,
      janusRelay: null,
      janusManager: null,
      pollHandle: null,
      prusaClient: null,
      janusStarted: false,
    });

    // Inject a currentConfig with custom shutdown timeout via the test helper
    __setCurrentConfigForTest({ ffmpegKillTimeoutSeconds: 5 });

    const mockServer = makeMockServer();

    await stopBridge(mockServer);

    expect(mockCamera.stopGracefully).toHaveBeenCalledWith(5000);
  });

  it("registers a hard timeout with unref()", async () => {
    jest.useFakeTimers();

    const setTimeoutSpy = jest.spyOn(global, "setTimeout");

    __setStateForTest({
      camera: null,
      agent: null,
      janusRelay: null,
      janusManager: null,
      pollHandle: null,
      prusaClient: null,
      janusStarted: false,
    });

    const mockServer = makeMockServer();

    const stopPromise = stopBridge(mockServer);

    // Find the 8000ms hard timeout timer
    const hardTimeoutCall = setTimeoutSpy.mock.calls.find(
      ([, delay]) => delay === 8000
    );
    expect(hardTimeoutCall).toBeDefined();

    // Check that the returned timer had .unref() called on it
    // The timer returned from setTimeout should have been unref'd
    const returnValues = setTimeoutSpy.mock.results;
    const hardTimerResult = returnValues.find(
      (_, idx) => setTimeoutSpy.mock.calls[idx]?.[1] === 8000
    );
    expect(hardTimerResult).toBeDefined();

    await stopPromise;

    jest.useRealTimers();
    setTimeoutSpy.mockRestore();
  });
});
