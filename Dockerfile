# Stage 1: Build frontend
FROM node:26-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build backend
FROM node:26-alpine AS backend-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build:backend

# Stage 3: Runtime
# node:26-alpine (Node.js 26 LTS) — janus available via Alpine community repo
FROM node:26-alpine AS runtime

RUN apk add --no-cache ffmpeg janus-gateway su-exec

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /app/frontend/dist ./public
COPY config/janus ./config/janus
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Config is mounted as a volume — never baked into the image
VOLUME ["/config"]

EXPOSE 3000
EXPOSE 10100-10200/udp
ENV PORT=3000
ENV CONFIG_PATH=/config/config.json
ENV CIRCUIT_BREAKER_THRESHOLD=5
ENV CIRCUIT_BREAKER_RESET_TIMEOUT_MS=60000
ENV RETRY_BASE_DELAY_MS=1000
ENV RETRY_MAX_DELAY_MS=30000
ENV HEALTHCHECK_CRITICAL_TIMEOUT_MS=120000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Starts as root only to fix /config ownership, then drops to the node user
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
