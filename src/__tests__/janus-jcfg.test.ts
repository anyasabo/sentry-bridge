import { patchJanusConfig, parseRtpPortRange } from "../janus/jcfg";

const JCFG = `general: {
\trtp_port_range = "10100-10200"
}
nat: {
\tnat_1_1_mapping = ""
}
`;

describe("parseRtpPortRange", () => {
  it("accepts a valid MIN-MAX range", () => {
    expect(parseRtpPortRange("10300-10400")).toBe("10300-10400");
  });
  it("trims whitespace", () => {
    expect(parseRtpPortRange(" 10300-10400 ")).toBe("10300-10400");
  });
  it.each([
    "",
    "abc",
    "10300",
    "10400-10300",
    "1000-2000",
    "60000-70000",
    "10300-10400-10500",
  ])("rejects %p", (value) => {
    expect(parseRtpPortRange(value)).toBeNull();
  });
});

describe("patchJanusConfig", () => {
  it("leaves the config untouched when no env vars are set", () => {
    const { text, warnings } = patchJanusConfig(JCFG, {});
    expect(text).toBe(JCFG);
    expect(warnings).toEqual([]);
  });

  it("sets nat_1_1_mapping from JANUS_HOST_IP", () => {
    const { text } = patchJanusConfig(JCFG, { JANUS_HOST_IP: "192.168.1.42" });
    expect(text).toContain('nat_1_1_mapping = "192.168.1.42"');
  });

  it("sets rtp_port_range from JANUS_RTP_PORT_RANGE", () => {
    const { text } = patchJanusConfig(JCFG, {
      JANUS_RTP_PORT_RANGE: "10300-10400",
    });
    expect(text).toContain('rtp_port_range = "10300-10400"');
  });

  it("keeps the default range and warns on an invalid value", () => {
    const { text, warnings } = patchJanusConfig(JCFG, {
      JANUS_RTP_PORT_RANGE: "10400-10300",
    });
    expect(text).toContain('rtp_port_range = "10100-10200"');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("10400-10300");
  });
});
