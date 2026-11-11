#!/bin/sh
# Runs the bridge as the unprivileged "node" user (#98).
#
# Started as root (the default), it first hands the config directory and the
# files the bridge writes to "node", so existing installs with a root-owned
# /config keep working without manual steps. Only these paths are changed, never
# recursively: /config can be a bind mount that holds unrelated files.
#
# If ownership cannot be changed (NFS root_squash, rootless Docker, read-only
# mount) and "node" cannot write /config, the bridge keeps running as root and
# logs a warning instead of failing.
set -e

RUN_USER=node
CONFIG_FILE="${CONFIG_PATH:-/config/config.json}"
CONFIG_DIR="$(dirname "$CONFIG_FILE")"

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

mkdir -p "$CONFIG_DIR" 2>/dev/null || true

for p in "$CONFIG_DIR" "$CONFIG_FILE" "$CONFIG_DIR/print-state.json" "$CONFIG_DIR/print-state.json.tmp"; do
  [ -e "$p" ] || continue
  if [ "$(stat -c %u "$p")" != "$(id -u "$RUN_USER")" ]; then
    chown "$RUN_USER:$RUN_USER" "$p" 2>/dev/null || true
  fi
done
[ -f "$CONFIG_FILE" ] && chmod 600 "$CONFIG_FILE" 2>/dev/null || true

if su-exec "$RUN_USER" test -w "$CONFIG_DIR" \
  && { [ ! -e "$CONFIG_FILE" ] || su-exec "$RUN_USER" test -w "$CONFIG_FILE"; }; then
  exec su-exec "$RUN_USER" "$@"
fi

echo "[entrypoint] WARNING: $CONFIG_DIR is not writable for user '$RUN_USER' and its ownership could not be changed — running as root. Make $CONFIG_DIR writable for uid $(id -u "$RUN_USER") to run unprivileged." >&2
exec "$@"
