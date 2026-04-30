# How-To: Docker Compose Setup

Use Docker Compose for a persistent, auto-restarting SentryBridge instance. This is the recommended setup for anything beyond a quick test.

---

## Prerequisites

- Docker 20.10+ with Docker Compose v2 (`docker compose` — note: no hyphen)
- Completed the [Quickstart tutorial](../tutorial/quickstart.md) at least once, so you know your printer IP and credentials

---

## Step 1 — Get the compose file

Either clone the repository and use the included `docker-compose.yml`:

```bash
git clone https://github.com/reneleban/sentry-bridge.git
cd sentry-bridge
```

Or create a new directory and copy this block into a file named `docker-compose.yml`:

```yaml
services:
  bridge:
    image: rleban/sentry-bridge:latest
    container_name: sentry-bridge
    ports:
      - "${PORT:-3000}:3000"
      - "10100-10200:10100-10200/udp"
    volumes:
      - ./config:/config
    environment:
      - PORT=3000
      - CONFIG_PATH=/config/config.json
      - JANUS_MODE=bundled
      - JANUS_DEBUG_LEVEL=2
      - JANUS_HOST_IP=${JANUS_HOST_IP:-}
      - CIRCUIT_BREAKER_THRESHOLD=5
      - CIRCUIT_BREAKER_RESET_TIMEOUT_MS=60000
      - RETRY_BASE_DELAY_MS=1000
      - RETRY_MAX_DELAY_MS=30000
      - HEALTHCHECK_CRITICAL_TIMEOUT_MS=120000
    healthcheck:
      test:
        [
          "CMD-SHELL",
          'node -e "fetch(''http://localhost:3000/api/health/ready'').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"',
        ]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3
    restart: unless-stopped
    stop_grace_period: 30s
```

---

## Step 2 — Set the required variable

Create a `.env` file next to `docker-compose.yml` with your Docker host's LAN IP:

```bash
JANUS_HOST_IP=192.168.1.42
```

Replace `192.168.1.42` with the actual LAN IP of the machine running Docker. This tells the Janus WebRTC gateway which IP to advertise to browsers — without it, the live stream in Obico will not work.

To find your LAN IP:

```bash
# Linux / Mac
ip route get 1 | awk '{print $7; exit}'
# or
hostname -I | awk '{print $1}'
```

---

## Step 3 — Start the container

```bash
docker compose up -d
```

Expected result: Docker pulls the image (first run) and starts the container. Open `http://localhost:3000` to run the Setup Wizard.

---

## Step 4 — Follow the Setup Wizard

Open `http://localhost:3000` and complete the 4-step wizard. The wizard writes `/config/config.json` on the mounted `./config` volume. This file persists across container restarts.

---

## Day-2 operations

### View logs

```bash
docker compose logs -f
```

### Check health

```bash
curl http://localhost:3000/api/health/ready
# 200 = ready, 503 = a critical component is down
```

### Restart after config change

```bash
docker compose up -d --force-recreate
```

### Upgrade to a new image

```bash
docker compose pull
docker compose up -d
```

### Stop and remove

```bash
docker compose down
```

The `./config` volume directory persists — your `config.json` is not deleted.

---

## Port reference

| Port        | Protocol | Purpose                                  |
| ----------- | -------- | ---------------------------------------- |
| 3000        | TCP      | SentryBridge Web UI and REST API         |
| 10100–10200 | UDP      | Janus WebRTC ICE media (browser ↔ Janus) |

If port 3000 is in use on your host, change the left side of `"${PORT:-3000}:3000"` and set `PORT=<new-port>` in `.env`.

---

## Environment variable reference

See the full list of all supported variables → [Configuration reference](../reference/configuration.md#environment-variables).
