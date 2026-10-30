import { registerFrameForwarding } from "../bridge";
import { metricsRegistry } from "../lib/metrics";

async function uploads(result: string): Promise<number> {
  const metric = await metricsRegistry
    .getSingleMetric("sentry_bridge_frame_uploads_total")!
    .get();
  return metric.values.find((v) => v.labels.result === result)!.value;
}

async function lastSuccess(): Promise<number> {
  const metric = await metricsRegistry
    .getSingleMetric(
      "sentry_bridge_frame_upload_last_success_timestamp_seconds"
    )!
    .get();
  return metric.values[0].value;
}

const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function setup(sendFrame: jest.Mock) {
  let emit: (frame: Buffer) => Promise<void> = async () => {};
  const camera = {
    onFrame: (cb: (frame: Buffer) => Promise<void>) => {
      emit = cb;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerFrameForwarding(camera as any, { sendFrame } as any, 0);
  return { emit: () => emit(frame) };
}

describe("registerFrameForwarding()", () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    log = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  it("warns once while uploads keep failing, not on every frame", async () => {
    const sendFrame = jest.fn().mockRejectedValue(new Error("HTTP 400"));
    const { emit } = setup(sendFrame);
    await emit();
    await emit();
    await emit();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 400"));
  });

  it("records each upload's result in the metrics", async () => {
    const success = await uploads("success");
    const failure = await uploads("failure");
    const sendFrame = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("HTTP 400"));
    const { emit } = setup(sendFrame);
    const before = Date.now() / 1000;
    await emit();
    await emit();
    expect(await uploads("success")).toBe(success + 1);
    expect(await uploads("failure")).toBe(failure + 1);
    expect(await lastSuccess()).toBeGreaterThanOrEqual(Math.floor(before));
  });

  it("warns again after uploads recover and then fail", async () => {
    const sendFrame = jest
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second"));
    const { emit } = setup(sendFrame);
    await emit();
    await emit();
    await emit();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("recovered"));
  });
});
