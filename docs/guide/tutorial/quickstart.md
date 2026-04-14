# Quickstart: 0 → Running Container

Get SentryBridge running and your Prusa printer connected to Obico in under 10 minutes.

**What you will have at the end:** Container running, Setup Wizard completed, Dashboard visible with live printer status and camera stream forwarded to Obico.

---

## Prerequisites

Before you start, confirm you have:

- Docker 20.10+ with Docker Compose v2 installed
- A Prusa Core One (or MK4S) with PrusaLink enabled and reachable on your LAN
- PrusaLink credentials — username and password from the printer's network settings (`Settings → Network`)
- An Obico account — [app.obico.io](https://app.obico.io) or a self-hosted instance
- The LAN IP of the machine running Docker (you will need this for the WebRTC live stream)

### Check your printer's camera protocol (new printers — April 2026+)

Prusa introduced WebRTC as the default camera streaming protocol in firmware released from April 2026 onward. SentryBridge uses RTSP — you must switch the protocol before continuing or the camera step in the wizard will fail.

**Step:** On the printer's touchscreen, go to `Settings → Network → Camera` and confirm the streaming protocol is set to **RTSP**. If it shows **WebRTC**, switch it to **RTSP** and save.

Expected result: The camera settings screen shows `RTSP` as the active protocol.

If you skip this step: Wizard step 2 (Camera) will block indefinitely with no frame preview.

---

## Step 1 — Pull and start the container

Run this command, replacing `192.168.1.x` with the LAN IP of your Docker host:

```bash
docker run -d \
  -p 3000:3000 \
  -p 10100-10200:10100-10200/udp \
  -v ./config:/config \
  -e JANUS_HOST_IP=192.168.1.x \
  reneleban/obico-prusalink-bridge:latest
```

Expected result: Docker pulls the image and prints a container ID. The command returns immediately.

If you see `port is already allocated`: Another service is using port 3000. Change the left side of `-p 3000:3000` to a free port, e.g. `-p 3001:3000`, and open `http://localhost:3001` in step 2.

---

## Step 2 — Open the Setup Wizard

Open `http://localhost:3000` in your browser.

Expected result: The SentryBridge Setup Wizard opens at step 1 of 4.

If you see "connection refused": The container is still starting. Wait 5 seconds and refresh.

---

## Step 3 — Connect to PrusaLink (Wizard step 1)

Enter your printer's PrusaLink details:

- **URL**: `http://192.168.1.x` — the IP of your printer, no trailing slash
- **Username**: `maker` (default) or the username you set
- **Password**: the password shown in `Settings → Network → API Key / User Password`

Click **Test Connection**.

Expected result: Green checkmark — "Connection successful". Click **Next**.

If you see 401 Unauthorized: The URL has a trailing slash, or the credentials are wrong. Re-check `Settings → Network` on the printer.

---

## Step 4 — Verify the camera (Wizard step 2)

The wizard probes `rtsp://[printer-ip]/live` and shows a preview frame.

Expected result: A still frame from the printer camera appears. Click **Next**.

If the spinner runs for more than 15 seconds: The RTSP stream is not reachable. Check that the printer's camera protocol is set to RTSP (see Prerequisites) and that the printer and Docker host are on the same LAN subnet.

---

## Step 5 — Pair with Obico (Wizard step 3)

Enter your Obico server URL — `https://app.obico.io` for the cloud, or your self-hosted URL.

The wizard displays a **6-digit pairing code**.

In Obico, go to `Settings → Printers → Link a Printer` and enter the pairing code.

Expected result: The wizard advances to step 4 automatically when Obico confirms the pairing.

If the code expires without confirmation: Check the firewall — the container needs outbound HTTPS (port 443) access to the Obico server.

---

## Step 6 — Done

Expected result: The wizard redirects to the **Dashboard**. You see:

- Connection status: PrusaLink ✓, Camera ✓, Obico ✓
- Printer state (idle or current print progress)
- In Obico's printer list: your printer is now online

SentryBridge is running. It will restart automatically (`restart: unless-stopped`) if Docker restarts.

---

## Next steps

- **Persistent setup**: Switch to Docker Compose for easier restarts and upgrades → [Docker Compose setup](../how-to/docker-compose.md)
- **All config options**: Environment variables and config.json parameters → [Configuration reference](../reference/configuration.md)
- **Something not working?** → [Troubleshooting](../how-to/troubleshooting.md)
- **Why is RTSP mandatory / why Docker?** → [Architecture decisions](../explanation/architecture-decisions.md)
