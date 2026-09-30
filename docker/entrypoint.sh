#!/bin/sh
# Checks the two mounts, creates synthetic demo data in an EMPTY data store, then runs the studio (the server seeds an empty workspace).
set -e
mkdir -p "${HOME:-/tmp/home}"

say() { echo "qkt-backtester: $*" >&2; }

# Started as root (the default): run as the owner of the mounted /workspace, so files you edit on the host stay yours
# without needing --user. If the folder is owned by root (docker created it), stay root and say so.
if [ "$(id -u)" = 0 ] && [ -d /workspace ] && [ -z "${STUDIO_KEEP_ROOT:-}" ]; then
  mkdir -p /workspace /data /home/studio/.claude
  for d in /workspace /data; do
    if [ "$(stat -c %u "$d")" = 0 ] && [ -z "$(ls -A "$d" 2>/dev/null)" ] && [ -w "$d" ]; then
      chown "${PUID:-1000}:${PGID:-1000}" "$d" && say "note: $d was an empty root-owned folder; gave it to ${PUID:-1000}:${PGID:-1000} (set PUID/PGID to change)"
    fi
  done
  ws_uid=$(stat -c %u /workspace 2>/dev/null || echo 0)
  ws_gid=$(stat -c %g /workspace 2>/dev/null || echo 0)
  if [ "$ws_uid" != 0 ]; then
    # Claude Code's sign-in folder (a volume): the studio runs the CLI as the workspace owner, so that owner must own it
    c=/home/studio/.claude
    if [ "$(stat -c %u "$c")" != "$ws_uid" ] && [ -z "$(ls -A "$c" 2>/dev/null)" ]; then chown "$ws_uid:$ws_gid" "$c" /home/studio; fi
    getent passwd "$ws_uid" >/dev/null 2>&1 || echo "studio:x:$ws_uid:$ws_gid:studio:/home/studio:/bin/sh" >> /etc/passwd
    exec setpriv --reuid="$ws_uid" --regid="$ws_gid" --clear-groups /usr/local/bin/studio-entrypoint "$@"
  fi
  say "note: /workspace is owned by root, so files created there will be root-owned. Create the folder yourself (mkdir workspace) before the first run."
fi

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

if [ "${QKT_DEMO:-1}" = 1 ] && [ "$DATA_WRITABLE" = 1 ] && [ -z "$(ls -A /data 2>/dev/null)" ]; then
  say "empty data store: creating SYNTHETIC demo data (DEMOUSD, a seeded random walk, not market data)"
  node /app/tools/demo-data.mjs /data 90 2024-01-01 >&2
  for tf in 15m 1h; do "$QKT_BIN" data build-bars DEMOUSD --tf "$tf" --from 2024-01-01 --to 2024-03-31 --data-root /data >&2; done
fi

if [ -z "${STUDIO_TOKEN:-}" ] && [ "${HOST:-}" != "127.0.0.1" ] && [ "${HOST:-}" != "localhost" ]; then
  say "no STUDIO_TOKEN set and the server is bound to ${HOST}: the terminal is restricted to qkt commands. Set STUDIO_TOKEN to enable a full shell and require a login token."
fi
exec "$@"
