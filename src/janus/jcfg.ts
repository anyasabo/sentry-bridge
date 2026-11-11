const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** Returns the normalized `MIN-MAX` range, or null if the value is invalid. */
export function parseRtpPortRange(value: string): string | null {
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (min < MIN_PORT || max > MAX_PORT || min > max) return null;
  return `${min}-${max}`;
}

export interface JanusConfigEnv {
  JANUS_HOST_IP?: string;
  JANUS_RTP_PORT_RANGE?: string;
}

/**
 * Applies env overrides to the contents of janus.jcfg.
 * - JANUS_HOST_IP → nat_1_1_mapping, so Janus advertises a reachable ICE candidate
 *   (otherwise it defaults to 127.0.0.1, unreachable outside the container).
 * - JANUS_RTP_PORT_RANGE → rtp_port_range, so several containers on one host
 *   can use distinct UDP ranges (host port must equal container port).
 */
export function patchJanusConfig(
  text: string,
  env: JanusConfigEnv
): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  let out = text;

  const hostIp = env.JANUS_HOST_IP?.trim();
  if (hostIp) {
    out = out.replace(
      /nat_1_1_mapping\s*=\s*"[^"]*"/,
      `nat_1_1_mapping = "${hostIp}"`
    );
  }

  const rawRange = env.JANUS_RTP_PORT_RANGE;
  if (rawRange !== undefined && rawRange.trim() !== "") {
    const range = parseRtpPortRange(rawRange);
    if (range) {
      out = out.replace(
        /rtp_port_range\s*=\s*"[^"]*"/,
        `rtp_port_range = "${range}"`
      );
    } else {
      warnings.push(
        `invalid JANUS_RTP_PORT_RANGE "${rawRange}" (expected MIN-MAX within ${MIN_PORT}-${MAX_PORT}), keeping default`
      );
    }
  }

  return { text: out, warnings };
}
