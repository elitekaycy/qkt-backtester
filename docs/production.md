# Running qkt-backtester in production

One container holds the studio (web UI + API) and the qkt engine it runs. Everything it needs comes from two folders you
mount: your **workspace** (strategies, config, runs) and your **data store** (bars and ticks). This page covers
releasing a version, running it on a server, and operating it.

## 1. Releasing a version

Versions are published by CI (`.github/workflows/release.yml`) when a tag is pushed:

```sh
# bump the version in package.json and packages/*/package.json (all four must match), merge to main, then:
git tag v0.2.0
git push origin v0.2.0
```

The workflow refuses a tag that differs from the package versions. It then:

- builds the image exactly as the `check` workflow builds and tests it;
- starts it on an empty workspace and runs the smoke test (first run, cache, health);
- pushes it to `ghcr.io/elitekaycy/qkt-backtester` as `:v0.2.0`, `:v0.2`, `:latest` and `:sha-<commit>`;
- creates a GitHub release that names the image digest.

The qkt engine inside is pinned by digest in `docker/Dockerfile` (`QKT_IMAGE`). Each image carries its version, commit
and engine in its labels:

```sh
docker inspect -f '{{json .Config.Labels}}' ghcr.io/elitekaycy/qkt-backtester:v0.2.0
```

Pin servers to a version tag (`:v0.2.0`), never `:latest`: an upgrade is then a deliberate change you can roll back.

The image is `linux/amd64` only, because the qkt engine image is.

## 2. Running it on a server

```sh
# once: a workspace folder owned by the account that should own the files
mkdir -p /srv/qkt-studio/workspace

docker pull ghcr.io/elitekaycy/qkt-backtester:v0.2.0
docker run -d --name qkt-backtester --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v /srv/qkt-studio/workspace:/workspace \
  -v /path/to/data-store:/data:ro \
  -e QKT_DEMO=0 \
  -e STUDIO_TOKEN="$(openssl rand -hex 24)" \
  -e STUDIO_TERMINAL=restricted \
  -e MAX_PARALLEL=4 \
  ghcr.io/elitekaycy/qkt-backtester:v0.2.0
```

- **Port**: publish on `127.0.0.1` only. The studio runs strategies and has a terminal, so never expose it to the
  internet. Reach it through an SSH tunnel, or over a private network such as Tailscale (see *Access*).
- **Data store** (`/data`): the folder with `bars/` and `symbols/` (qkt's layout). Mount it `:ro` to guarantee the studio
  never changes it; *Build bars*, *Fill from ticks*, *Fetch* and *Accept as no data* then fail with a permission error, which is
  what you want for a shared archive. Mount it read-write only for a store the studio may build into. Days accepted as
  having no data are empty qkt day files plus a record in `.studio-no-data.json` at the store's root; each can be undone
  from the symbol's calendar.
- **Workspace** (`/workspace`): your strategies, `qkt.config.yaml`, `instruments.yaml`, `.env` and every run's output
  (`runs/`). An empty folder is seeded with a starter config and two sample strategies on a symbol your data has.
  Back this folder up; it is the only state the studio keeps.
- **Files belong to the folder's owner**: the container runs as the owner of `/workspace` (set `PUID`/`PGID` if Docker
  creates the folder for you).

### Access

- **SSH tunnel** (simplest, no token needed for loopback, but set one anyway on a server):
  `ssh -N -L 8080:127.0.0.1:8080 user@server`, then open <http://localhost:8080>.
- **Tailscale**: publish on the server's tailnet address instead (`-p 100.x.y.z:8080:8080`) and add
  `-e STUDIO_ALLOWED_HOSTS=server-name,server-name.tailnet-name.ts.net`. The token is then required; the browser asks for
  it once and remembers it (a `?token=` link works too and is taken out of the address bar). On a shared computer,
  *Forget the saved token* in the command palette removes it.

### Health, logs, upgrades

```sh
docker ps --filter name=qkt-backtester          # STATUS shows (healthy) once the API answers
docker logs --tail 100 qkt-backtester
# upgrade (runs are kept: they live in the workspace)
docker pull ghcr.io/elitekaycy/qkt-backtester:v0.2.1
docker stop qkt-backtester && docker rm qkt-backtester
docker run ... ghcr.io/elitekaycy/qkt-backtester:v0.2.1      # same flags as before
# roll back: the same, with the previous tag
```

Runs made by an older version are re-derived automatically on first view when the studio's derived data changed; the
engine output they came from is never rewritten.

## 3. Settings

| Variable | Default | Meaning |
|---|---|---|
| `STUDIO_TOKEN` | unset | Login token. Required for any address other than localhost. |
| `STUDIO_TERMINAL` | `auto` | `restricted` allows only `qkt` commands in the in-app terminal. `auto` gives a full shell when a token is set or the server is bound to localhost. **Set `restricted` on servers.** |
| `STUDIO_ALLOWED_HOSTS` | none | Extra host names the studio answers to (comma-separated), e.g. a Tailscale name. |
| `STUDIO_ALLOWED_ORIGINS` | none | Extra browser origins allowed to call the API (a reverse proxy's public origin). |
| `MAX_PARALLEL` | cores − 1, capped by memory | Backtests at once. A backtest's engine peaks at about 0.3 GB on bars and 1.2 GB on ticks; the default leaves a quarter of memory (or the container's limit) free. Set it lower on a shared server. |
| `MAX_RUN_MS` | `1800000` | A run is stopped after this long (30 minutes). |
| `QKT_DEMO` | `1` | `1` creates synthetic DEMOUSD data in an **empty, writable** `/data`. Set `0` in production. |
| `PUID` / `PGID` | `1000` | Owner given to an empty, root-owned mount Docker created. |
| `STUDIO_KEEP_ROOT` | unset | Set to keep running as root instead of the workspace owner. |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Listen address inside the container. Control exposure with `-p`. |
| `STUDIO_CDS_DIR` | `/tmp/home/cds` | Where backtest JVMs keep a class-data archive for faster start-up. Unset to disable. |
| `QKT_DATA_HOME`, `WORKSPACE`, `QKT_BIN`, `WEB_ROOT` | set by the image | Paths inside the container; leave them. |

Backtest settings (balance, risk halts, execution model, portfolio book risk) are in the workspace's
`qkt.config.yaml`, which lists every qkt option. In the editor, *Show every option* expands a short file into the full
reference around your own values.

## 4. What is checked before a release

Every push runs the `check` workflow: unit tests, then the image itself on an empty workspace with synthetic data:
accuracy against an independent reimplementation, byte-for-byte determinism, what the UI displays, a whole-session
walkthrough (create, run, edit with auto-run, ticks, a parameter grid), and keyboard and extension compatibility. The
release workflow only publishes a commit whose image starts and passes the smoke test.

## 5. The studio's tools (MCP)

The studio serves its abilities as MCP tools at `/api/mcp` (same token as the rest of the API): read what you are
looking at, the DSL reference, diagnose a run's exits, try a change on a copy and see it on the chart, propose edits to
strategies, `qkt.config.yaml` and `instruments.yaml`, set the split, run backtests, sweeps and walk-forwards.

From Claude Code on your laptop (Tailscale):

```sh
claude mcp add --transport http qkt-studio http://bot2:8080/api/mcp --header "Authorization: Bearer <STUDIO_TOKEN>"
```

Then ask, in plain English, with the studio open in the browser: "make the stop-loss 2 % and let's see". The change runs
on a copy and appears on the chart with Adopt / Discard / Back; edits to your files appear under **Proposals** until you
apply them. Nothing a tool does changes an existing file without your click.

Each open studio tab keeps one event stream to the server (for what the tools do), plus one more while a run is
going. Over plain HTTP (for example `http://bot2:8080`) browsers allow 6 connections per host, so with about five tabs
of the studio open, requests in every tab start to wait. Close tabs you do not use, or serve the studio over HTTPS
(HTTP/2) behind a proxy, where this limit does not apply.
