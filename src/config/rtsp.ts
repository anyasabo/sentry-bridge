/** Invalid camera URL; maps to HTTP 400. */
export class RtspUrlError extends Error {}

/** Marker that replaces the userinfo (user:password) of a redacted RTSP URL. */
export const REDACTED_USERINFO = "***";

const RTSP_SCHEME = /^rtsps?:\/\//i;

/**
 * ffmpeg also opens http:, file:, concat: and plain paths, so the camera URL
 * must be rtsp:// or rtsps:// before it reaches ffmpeg.
 */
export function assertRtspUrl(url: string): void {
  if (!RTSP_SCHEME.test(url.trim())) {
    throw new RtspUrlError(
      "The camera URL must start with rtsp:// or rtsps://"
    );
  }
}

/** Splits `scheme://[userinfo@]rest` without re-serializing the URL. */
function splitUserinfo(
  url: string
): { prefix: string; userinfo: string | null; rest: string } | null {
  const m = /^(rtsps?:\/\/)([^/?#]*)(.*)$/is.exec(url);
  if (!m) return null;
  const at = m[2].lastIndexOf("@");
  return {
    prefix: m[1],
    userinfo: at >= 0 ? m[2].slice(0, at) : null,
    rest: (at >= 0 ? m[2].slice(at + 1) : m[2]) + m[3],
  };
}

/** Replaces the userinfo of an RTSP URL with `***`; other values pass through. */
export function redactRtspUrl(url: string): string {
  const parts = splitUserinfo(url);
  if (!parts || parts.userinfo === null) return url;
  return `${parts.prefix}${REDACTED_USERINFO}@${parts.rest}`;
}

/** True when the URL carries the redaction marker instead of real credentials. */
export function isRedactedRtspUrl(url: string): boolean {
  return splitUserinfo(url)?.userinfo === REDACTED_USERINFO;
}

/** True when both URLs point to the same host and path (userinfo ignored). */
export function sameRtspTarget(a: string, b: string): boolean {
  const pa = splitUserinfo(a);
  const pb = splitUserinfo(b);
  return (
    !!pa &&
    !!pb &&
    pa.prefix.toLowerCase() === pb.prefix.toLowerCase() &&
    pa.rest === pb.rest
  );
}
