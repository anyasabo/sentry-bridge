# Troubleshooting

This guide covers errors with known solutions, drawn from v1.0 and v1.1.0 hardware testing on a Prusa Core One.

Start with the dashboard: at startup the bridge checks PrusaLink (reachable, credentials), the camera RTSP stream, the Obico server and the pairing. If any check fails, a panel at the top of the dashboard lists each check with a fix hint; use **Re-check** after fixing. The bridge keeps running and reconnecting either way.

---

## 1. PrusaLink auth fails — 401 Unauthorized

**Symptom:** Wizard step 1 fails with "401 Unauthorized" after entering credentials.

**Cause:** The printer URL has a trailing slash, or the credentials do not match what PrusaLink is configured with.

**Fix:**

1. Remove any trailing slash from the URL: use `http://192.168.1.x`, not `http://192.168.1.x/`
2. Verify the credentials on the printer: `Settings → Network → API Key / User Password`
3. Test from the Docker host before using the wizard:
   ```bash
   curl -u <username>:<password> --digest http://<printer-ip>/api/v1/status
   ```
   Expected: JSON response with printer status. If you see `{"code":401,...}`, the credentials are wrong.

---

## 2. Camera RTSP stream unreachable — Wizard step 2 blocks

**Symptom:** Wizard step 2 shows a spinner indefinitely — no camera frame appears.

**Cause:** The RTSP stream at `rtsp://[printer-ip]/live` is not reachable. Common causes: camera protocol is set to WebRTC instead of RTSP (new firmware default from April 2026), printer and Docker host are on different subnets, or the camera module is disabled.

**Fix:**

1. **Check the streaming mode:** In Prusa Connect, open the printer details → **Camera** → camera settings and set the field **Streaming** to **RTSP** (options: Disable / RTSP / WebRTC). Re-check this after every firmware update — newer firmware may switch it back to WebRTC.
2. **Test the RTSP stream directly** from the Docker host:
   ```bash
   ffmpeg -rtsp_transport tcp -i rtsp://<printer-ip>/live -frames:v 1 -f image2 /tmp/test.jpg
   ```
   Expected: ffmpeg exits cleanly and writes `test.jpg`. If it hangs or reports "Connection refused", the stream is not accessible.
3. **Check network isolation:** The printer and the Docker host must be on the same LAN subnet. VLANs or guest network isolation will block RTSP.
4. **Confirm the camera is present:** The RTSP endpoint requires the Buddy3D camera board. Printers without the camera add-on do not have this endpoint.

---

## 3. Obico pairing never confirms — Wizard step 3 waits indefinitely

**Symptom:** Wizard step 3 shows the 6-digit pairing code, you enter it in Obico, but the wizard never advances to step 4.

**Cause:** The container cannot reach the Obico server over WebSocket, or the server URL is incorrect.

**Fix:**

1. **Verify the server URL** — no trailing slash. Use `https://app.obico.io` or your self-hosted URL exactly.
2. **Check the firewall:** The container needs outbound TCP on port 443 (HTTPS/WSS) to the Obico server.
3. **Inspect container logs** for connection errors:
   ```bash
   docker logs <container-name> | grep obico
   ```
   Look for WebSocket connection errors or DNS resolution failures.
4. **Confirm the pairing code is still valid** — it expires after 120 seconds. If it has expired, restart the wizard by navigating back to step 3.

---

## 4. WebRTC live stream is black in Obico control panel

**Symptom:** Obico control panel loads and shows your printer, but the video area is black or continuously spinning.

**Cause:** `JANUS_HOST_IP` is not set, or is set to `127.0.0.1` or `0.0.0.0` instead of the Docker host's actual LAN IP. Janus cannot advertise the correct ICE candidate, so the browser cannot reach the WebRTC stream.

**Fix:**

1. **Check the current value:**
   ```bash
   docker exec <container-name> env | grep JANUS_HOST_IP
   ```
2. **Set `JANUS_HOST_IP` to your Docker host's LAN IP** (e.g. `192.168.1.42`) — not `127.0.0.1` and not `0.0.0.0`.
   - For `docker run`: add `-e JANUS_HOST_IP=192.168.1.42`
   - For Docker Compose: set `JANUS_HOST_IP=192.168.1.42` in a `.env` file next to `docker-compose.yml`
3. **Confirm UDP ports are published and reachable.** The container needs ports `10100–10200/udp` published. Verify in Docker Compose:
   ```yaml
   ports:
     - "10100-10200:10100-10200/udp"
   ```
4. **Recreate the container after changing the variable:**
   ```bash
   docker compose up -d --force-recreate
   ```

---

## 5. Obico live view stays black after a bridge restart

**Symptom:** After the bridge container restarts (the bundled Janus restarts with it), an Obico live view that was already open stays black.

**Cause:** Obico's web client does not re-establish the WebRTC session after the Janus server behind it restarts. This is how [Obico's web client](https://github.com/TheSpaghettiDetective/obico-server/blob/release/frontend/src/lib/webrtc.js) works with the official agents too; it is not a bridge fault.

**Fix:** Reload the Obico page. The bridge dashboard's MJPEG view is not affected.

---

## 6. Obico's "OctoPrint" button shows an error

**Symptom:** Clicking the "OctoPrint" button on Obico's printer control page shows an error (status 484, "Failed to create a new tunnel") instead of a page.

**Cause:** The button opens the agent's web page through an Obico tunnel. The Obico server has no tunnel configured: a self-hosted server needs a port range in `OCTOPRINT_TUNNEL_PORT_RANGE` or subdomain tunnels with wildcard DNS. A range of `'0-0'` disables tunnels.

**Fix:** Configure tunnels on the Obico server as described in [Obico's tunnel guide](https://www.obico.io/docs/server-guides/tunnel/). With tunnels working, the button shows a SentryBridge page with a link to the bridge on your LAN. The bridge UI itself is not served through the tunnel (ADR-0010), because it has no login.

---

## 7. "403 Host not allowed" when opening the bridge via a DNS name

**Symptom:** The UI or API answers `403` with `Host not allowed ... ALLOWED_HOSTS` when you open the bridge as e.g. `https://bridge.example.com` or `http://printer.tail1234.ts.net:3000`.

**Cause:** The bridge has no login, so it only answers to hostnames that cannot be pointed at it by a foreign website (DNS rebinding): IP addresses, `localhost`, single-label names (e.g. `sentry-bridge`) and `*.local` names. A DNS name with dots is not on that list.

**Fix:** Add the hostname to `ALLOWED_HOSTS` (comma-separated, without port) and restart the container, e.g. `ALLOWED_HOSTS=bridge.example.com`. See [Configuration](../reference/configuration.md).

---

## 8. Behind a reverse proxy: page loads, but saving / pause / upload answers 403 "Cross-origin request rejected"

**Symptom:** Through a reverse proxy the UI loads and shows live data, but every action that changes something (saving the config, pause/resume/cancel, uploading or deleting a file) fails with `403` and `Cross-origin request rejected`.

**Cause:** For write requests the bridge compares the browser's `Origin` (the public name, e.g. `https://bridge.example.com`) with the `Host` header it receives. Some proxies replace `Host` with the upstream address — nginx `proxy_pass` does this by default (`Host` becomes `$proxy_host`, e.g. `192.168.1.5:3000`). The two no longer match, so writes are rejected while reads keep working.

**Fix:**

1. Make the proxy pass the original `Host` header through. nginx:

   ```nginx
   location / {
       proxy_pass http://192.168.1.5:3000;
       proxy_set_header Host $host;
   }
   ```

   Caddy (`reverse_proxy`) and Traefik (`passHostHeader`, default `true`) keep the original `Host` by default.

2. Add the public name to `ALLOWED_HOSTS`, e.g. `ALLOWED_HOSTS=bridge.example.com` (see [section 7](#7-403-host-not-allowed-when-opening-the-bridge-via-a-dns-name)).

---

## Not listed here?

If your issue is not covered above, check the [container logs](#3-obico-pairing-never-confirms--wizard-step-3-waits-indefinitely) first, then open an issue at [github.com/reneleban/sentry-bridge](https://github.com/reneleban/sentry-bridge).

## Log shows "running as root" at startup

**Symptom:** `[entrypoint] WARNING: /config is not writable for user 'node' ... running as root`.

**Cause:** The container could not hand the config directory to the unprivileged `node` user (uid 1000), e.g. on NFS with `root_squash` or with rootless Docker. The bridge still works, but runs as root.

**Fix:** Make the config directory writable for uid 1000 on the host, e.g. `sudo chown 1000:1000 ./config ./config/config.json`, then restart the container.
