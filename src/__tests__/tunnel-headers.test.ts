import * as http from "node:http";
import { handleTunnelRequest } from "../obico/tunnel";

describe("tunnel header forwarding", () => {
  let server: http.Server;
  let port: number;
  let received: http.IncomingHttpHeaders = {};

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      received = req.headers;
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => done());
  });

  it("drops Host, Origin and Sec-Fetch-* supplied by Obico", async () => {
    const res = await handleTunnelRequest(
      {
        ref: "r1",
        method: "GET",
        path: "/api/files",
        headers: {
          Host: "app.obico.io",
          Origin: "https://app.obico.io",
          "Sec-Fetch-Site": "cross-site",
          "sec-fetch-mode": "cors",
          "X-Custom": "kept",
        },
      },
      { localPort: port }
    );
    expect(res.status).toBe(200);
    expect(received.host).toBe(`127.0.0.1:${port}`);
    expect(received.origin).toBeUndefined();
    expect(received["sec-fetch-site"]).toBeUndefined();
    expect(received["sec-fetch-mode"]).toBeUndefined();
    expect(received["x-custom"]).toBe("kept");
  });
});
