# Architecture Decisions

This page explains four design decisions that shape how SentryBridge works. It is written for users who want to understand the system, not just operate it.

---

## 1. Why Docker — no native installer

SentryBridge ships as a single Docker image. There is no native installer, no system service to configure, and no package to install.

**The reason:** Docker gives you a completely isolated, self-contained environment. SentryBridge bundles everything it needs — the Node.js runtime, ffmpeg for the camera stream, and the Janus WebRTC gateway — inside the image. You do not need to install any of these tools on your host machine, and SentryBridge cannot interfere with other software you are running.

One container per printer also makes the operational model simple: to add a second printer, you run a second container on a different port. To remove it, you stop the container. To upgrade, you pull a new image. There is no configuration to merge, no system state to clean up.

The only thing that lives outside the container is `config.json` on the mounted volume — your printer credentials and pairing token. Everything else is ephemeral.

---

## 2. Why SentryBridge identifies as an OctoPrint agent

When SentryBridge connects to Obico, it presents itself as an OctoPrint agent. If you look at the Obico printer list, it shows your printer as an OctoPrint-connected device.

**The reason:** Obico was built primarily for OctoPrint users. Its connection protocol — the message format used over WebSocket — is the OctoPrint agent protocol. SentryBridge speaks this protocol exactly, which means Obico sees a fully compatible printer agent with no special casing required.

The alternative would have been to emulate a Moonraker agent (the protocol used for Klipper printers). Moonraker support in Obico is less mature and unlocks some WebRTC-related features — but it also introduces more protocol surface area and more moving parts. OctoPrint identity is the stable, well-documented path.

SentryBridge does not actually install or run OctoPrint. It only speaks the same language Obico expects.

---

## 3. Why the camera is mandatory

SentryBridge will not complete the Setup Wizard without a working camera stream, and the bridge will not start without one.

**The reason:** The camera is the reason to use Obico. Obico's core value is AI-based failure detection — it watches the live stream and can pause or cancel a print automatically if it detects a problem. Without a camera stream, Obico has nothing to analyse, and the service provides no benefit beyond what you already get from PrusaLink directly.

Making the camera mandatory at setup time prevents a silent half-working state where the bridge runs but Obico never receives any frames. You know immediately if the camera is not working, rather than discovering it after a failed print you thought was being monitored.

If you need to run without a camera temporarily, you can stop the bridge, remove the camera section from `config.json`, and restart — but Obico failure detection will not function.

---

## 4. Why RTSP and not WebRTC

Prusa printers with the Buddy3D camera board expose the camera over RTSP at `rtsp://[printer-ip]/live`. This endpoint is unauthenticated and designed for LAN consumers — it is the standard way external tools access the Prusa camera stream.

Starting from firmware released in April 2026, Prusa printers default to WebRTC as the camera protocol for their own app (Prusa Connect). WebRTC is a browser-to-server protocol — it is designed for Prusa's own cloud infrastructure, not for local consumers like SentryBridge.

**The reason SentryBridge uses RTSP:** ffmpeg, the industry-standard video tool included in the SentryBridge image, speaks RTSP natively. It captures the stream, extracts JPEG frames for Obico's AI detection, and re-encodes it for the WebRTC stream that the Obico control panel displays. This pipeline is straightforward and does not depend on Prusa's cloud.

When you switch the camera protocol to RTSP in PrusaLink settings (`Settings → Network → Camera`), you are not disabling anything — you are making the stream available on the standard local endpoint that SentryBridge (and tools like ffmpeg, VLC, and Home Assistant) use. Prusa Connect continues to work regardless of this setting.

---

*Back to [User Guide](../README.md)*
