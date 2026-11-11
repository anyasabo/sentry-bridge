import request from "supertest";

const mockLatestFrame = jest.fn();
let mockRunningCamera: { latestFrame: jest.Mock } | null = null;
jest.mock("../camera/registry", () => ({
  getCameraInstance: () => mockRunningCamera,
  setCameraInstance: jest.fn(),
}));

const mockTestStream = jest.fn();
jest.mock("../camera/camera", () => ({
  ...jest.requireActual("../camera/camera"),
  createCamera: jest.fn(() => ({ testStream: mockTestStream })),
}));

jest.mock("../config/config", () => ({
  ...jest.requireActual("../config/config"),
  loadConfig: () => ({
    camera: { rtspUrl: "rtsp://cam/live", frameIntervalSeconds: 10 },
  }),
}));

import { app } from "../server";
import { createCamera } from "../camera/camera";

const liveFrame = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
const oneOffFrame = Buffer.from([0xff, 0xd8, 0x02, 0xff, 0xd9]);

describe("GET /api/camera/snapshot", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunningCamera = { latestFrame: mockLatestFrame };
    mockTestStream.mockResolvedValue(oneOffFrame);
  });

  it("serves the running stream's latest frame without opening the camera", async () => {
    mockLatestFrame.mockReturnValue(liveFrame);
    const res = await request(app).get("/api/camera/snapshot");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(Buffer.from(res.body)).toEqual(liveFrame);
    expect(createCamera).not.toHaveBeenCalled();
  });

  it("captures a one-off frame when the stream has no recent frame", async () => {
    mockLatestFrame.mockReturnValue(null);
    const res = await request(app).get("/api/camera/snapshot");
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body)).toEqual(oneOffFrame);
  });

  it("captures a one-off frame when no stream runs", async () => {
    mockRunningCamera = null;
    const res = await request(app).get("/api/camera/snapshot");
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body)).toEqual(oneOffFrame);
  });
});
