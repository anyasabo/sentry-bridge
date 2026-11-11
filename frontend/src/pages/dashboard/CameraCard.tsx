import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Box,
  Card,
  Image,
  Skeleton,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { useTranslation } from "react-i18next";
import { createMjpegParser } from "./mjpeg";
import classes from "./CameraCard.module.css";

// Retry delay after the stream failed.
const ERROR_RETRY_MS = 15_000;
// Badge turns to "late" after this long without a frame.
const MIN_LATE_MS = 5_000;
// Reconnect when no frame arrived for this long.
const MIN_STALL_MS = 30_000;
// Window over which the frame rate is averaged.
const MIN_FPS_WINDOW_MS = 5_000;
// How often the badge and the stall check are re-evaluated.
const TICK_MS = 1_000;

/** Timing thresholds, stretched for slow cameras so a regular gap between
 *  two frames never counts as late or stalled. */
function streamThresholds(frameIntervalSeconds: number | null) {
  const intervalMs = (frameIntervalSeconds ?? 0) * 1000;
  return {
    lateMs: Math.max(MIN_LATE_MS, 2 * intervalMs),
    stallMs: Math.max(MIN_STALL_MS, 2 * intervalMs),
    fpsWindowMs: Math.max(MIN_FPS_WINDOW_MS, 3 * intervalMs),
  };
}

export function CameraCard() {
  const { t } = useTranslation();
  const [error, setError] = useState(false);
  // Changing it opens a new /stream request.
  const [attempt, setAttempt] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [frameIntervalSeconds, setFrameIntervalSeconds] = useState<
    number | null
  >(null);
  // Arrival times of recent frames, and the start of the current connection.
  const frameTimes = useRef<number[]>([]);
  const connectedAt = useRef(Date.now());
  // Object URL created for a frame but not yet displayed.
  const pendingUrl = useRef<string | null>(null);
  const { lateMs, stallMs, fpsWindowMs } =
    streamThresholds(frameIntervalSeconds);
  const fpsWindow = useRef(fpsWindowMs);
  fpsWindow.current = fpsWindowMs;

  const reconnect = useCallback(() => {
    setError(false);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        const seconds = cfg?.camera?.frameIntervalSeconds;
        if (typeof seconds === "number") setFrameIntervalSeconds(seconds);
      })
      .catch(() => {});
  }, []);

  // Read the MJPEG stream and show each frame as an object URL.
  useEffect(() => {
    if (error) return;
    const controller = new AbortController();
    connectedAt.current = Date.now();
    frameTimes.current = [];

    const push = createMjpegParser((jpeg) => {
      const next = URL.createObjectURL(
        new Blob([jpeg as BlobPart], { type: "image/jpeg" })
      );
      // A frame replaced before it was ever rendered is never displayed.
      if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
      pendingUrl.current = next;
      const ts = Date.now();
      frameTimes.current = [
        ...frameTimes.current.filter((x) => ts - x <= fpsWindow.current),
        ts,
      ];
      setSrc(next);
    });

    (async () => {
      const res = await fetch(`/stream?attempt=${attempt}`, {
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error("stream ended");
        push(value);
      }
    })().catch(() => {
      if (!controller.signal.aborted) setError(true);
    });

    // The displayed frame stays until the next connection replaces it.
    return () => controller.abort();
  }, [attempt, error]);

  // Revoke a frame's URL only once the next one is displayed, or on unmount.
  useLayoutEffect(() => {
    if (src === null) return;
    if (pendingUrl.current === src) pendingUrl.current = null;
    return () => URL.revokeObjectURL(src);
  }, [src]);

  useEffect(
    () => () => {
      if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
    },
    []
  );

  // Auto-retry when stream errors — camera may have recovered after a restart
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(reconnect, ERROR_RETRY_MS);
    return () => clearTimeout(timer);
  }, [error, reconnect]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const lastFrame = frameTimes.current[frameTimes.current.length - 1] ?? null;
  const sinceMs = now - (lastFrame ?? connectedAt.current);
  const stalled = sinceMs > stallMs;

  // Frame-stall reconnect: no frame on this connection for too long.
  useEffect(() => {
    if (!error && stalled) reconnect();
  }, [error, stalled, reconnect]);

  const recent = frameTimes.current.filter((x) => now - x <= fpsWindowMs);
  const fps = recent.length / (fpsWindowMs / 1000);
  const late = lastFrame === null || sinceMs > lateMs;
  const seconds = (sinceMs / 1000).toFixed(1);
  const label = late
    ? t("dashboard.camera.badge_stalled", {
        seconds: Math.round(sinceMs / 1000),
      })
    : t("dashboard.camera.badge_live", { fps: fps.toFixed(1), seconds });

  return (
    <Card withBorder radius="md" p="md">
      <Title order={5} mb="sm">
        {t("dashboard.camera.heading")}
      </Title>
      {!error && !src && <Skeleton height={200} radius="md" />}
      {!error && src && (
        <Box pos="relative">
          <Image src={src} radius="md" alt={t("dashboard.camera.heading")} />
          <Tooltip
            label={label}
            withArrow
            position="left"
            events={{ hover: true, focus: true, touch: true }}
          >
            <span
              className={classes.badge}
              tabIndex={0}
              role="img"
              aria-label={label}
            >
              <span
                key={late ? "late" : (lastFrame ?? 0)}
                className={late ? classes.dotLate : classes.dotLive}
              />
            </span>
          </Tooltip>
        </Box>
      )}
      {error && (
        <Text size="sm" c="dimmed">
          {t("dashboard.camera.no_frame")}
        </Text>
      )}
    </Card>
  );
}
