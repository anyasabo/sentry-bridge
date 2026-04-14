# Troubleshooting

This guide covers errors with known solutions, drawn from v1.0 and v1.1.0 hardware testing on a Prusa Core One.

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

1. **Check the camera protocol:** On the printer touchscreen, go to `Settings → Network → Camera` and confirm it shows **RTSP**. If it shows WebRTC, switch to RTSP and save.
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

## Not listed here?

If your issue is not covered above, check the [container logs](#3-obico-pairing-never-confirms--wizard-step-3-waits-indefinitely) first, then open an issue at [github.com/reneleban/sentry-bridge](https://github.com/reneleban/sentry-bridge).
