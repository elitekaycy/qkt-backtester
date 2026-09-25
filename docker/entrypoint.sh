#!/bin/sh
# Checks the two mounts, seeds a sample project and (only into an EMPTY data store) synthetic demo data, then runs the studio.
set -e
mkdir -p "${HOME:-/tmp/home}"

say() { echo "qkt-backtester: $*" >&2; }

if [ ! -d /workspace ]; then mkdir -p /workspace; fi
if [ ! -w /workspace ]; then
  say "/workspace is not writable by uid $(id -u)."
  say "Run the container as the owner of the mounted folder:  docker run --user \$(id -u):\$(id -g) ..."
  exit 78
fi
if [ ! -d /data ]; then mkdir -p /data 2>/dev/null || true; fi
DATA_WRITABLE=1
[ -w /data ] || DATA_WRITABLE=0
[ "$DATA_WRITABLE" = 1 ] || say "note: /data is read-only or not writable; 'Build bars' and 'Fetch' will fail. Use it read-only only with a pre-built store."

if [ -z "$(ls -A /workspace 2>/dev/null)" ]; then
  cp -R /opt/sample-workspace/. /workspace/
  say "seeded /workspace with the sample project (qkt.config.yaml + two demo strategies)"
fi

if [ "${QKT_DEMO:-1}" = 1 ] && [ "$DATA_WRITABLE" = 1 ] && [ -z "$(ls -A /data 2>/dev/null)" ]; then
  say "empty data store: creating SYNTHETIC demo data (DEMOUSD, a seeded random walk, not market data)"
  node /app/tools/demo-data.mjs /data 90 2024-01-01 >&2
  for tf in 15m 1h; do "$QKT_BIN" data build-bars DEMOUSD --tf "$tf" --from 2024-01-01 --to 2024-03-30 --data-root /data >&2; done
fi

if [ -z "${STUDIO_TOKEN:-}" ] && [ "${HOST:-}" != "127.0.0.1" ] && [ "${HOST:-}" != "localhost" ]; then
  say "no STUDIO_TOKEN set and the server is bound to ${HOST}: the terminal is restricted to qkt commands. Set STUDIO_TOKEN to enable a full shell and require a login token."
fi
exec "$@"
