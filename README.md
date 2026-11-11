# Private speed test

A self-hosted Internet speed test written in Rust. The page is static; every
measurement runs against short-lived **test worker** containers that the app
starts on demand through the Docker socket and removes again when they go idle.

```
browser  ──►  app (port 3000)  ──►  worker container (port 8080)
   │                 │                        ▲
   │                 └── docker socket ───────┘  create / start / remove
   └──── direct to the worker's published port (when reachable)
```

One binary, one image, two roles. `speedtest app` serves the page and manages
the pool; `speedtest worker` is the measurement endpoint those containers run.
Nothing is interpreted at runtime: the image contains a static executable and
the page assets, no Node and no npm.

## Repository layout

```
docker-compose.yml     Compose project (deploy root)
.env                   Committed defaults, read by Arcane and by compose
Cargo.toml             Single binary crate, pinned dependency set
Dockerfile             Multi-stage Rust build, Alpine runtime
src/main.rs            Role dispatch: app, worker, probe (healthcheck)
src/app.rs             Static site, /healthz, /__speed/* proxy
src/pool.rs            Worker pool: spawn, sticky sessions, idle reaping
src/docker.rs          Docker Engine API client over the unix socket
src/worker.rs          Measurement worker (download/upload/ping/meta)
assets/                Page, styles, script and brand mark
```

## Deploy from Arcane

1. Projects → **Create Project** → **From Git Repo**, direction **Pull**.
2. Repository `ssh://git@192.168.1.88:2222/decryptedchaos/speed-test.git` (the Git host listens on port 2222), branch `main`.
3. Compose file path: `docker-compose.yml` (repository root).
4. Sync. The repository's `.env` is the project env file; adjust values in
   Arcane's env editor (for example `WORKER_LOCATION`), save, and deploy.

The app needs the Docker socket to create its workers; the mount is already in
the Compose file. Workers are only created on first use, so `/healthz` reporting
`"workers": 0` right after deploy is normal.

## Deploy without Arcane

```bash
# .env already holds the defaults; edit it if you need different values
docker compose up -d --build
curl -s localhost:3390/healthz
```

### Rebuilding after a code change

`docker-compose.yml` names the image explicitly (`speedtest:rust3`) and workers
are created from that same tag, so a deploy tool that only runs `up -d` cannot
silently reuse the image a previous deploy left behind. Bump the tag in both
places when the code changes, or deploy with `--build`. `/healthz` answers
`"runtime":"rust"` (with a `version`) once the new binary is serving — if that
field is missing, the old image is still running.

## Run without Docker (development)

With no docker socket the app runs workers as local child processes of the same
binary, so the whole flow works on a machine without Docker:

```bash
cargo run --release -- app      # http://localhost:3000, provider=native
cargo build --release           # compile check for the worker role too
```

Workers can also be started by hand, which is handy when profiling:

```bash
WORKER_PORT=8080 WORKER_BIND=127.0.0.1 cargo run --release -- worker
```

## Endpoints

| Route | Served by | Purpose |
| --- | --- | --- |
| `/`, `/about` | app | static site from `assets/` |
| `/healthz` | app | provider, worker and session counts |
| `/__speed/meta` | app | protocol, client IP, worker label, direct worker origin |
| `/__speed/ping` | worker | small no-store probe |
| `/__speed/down?bytes=N` | worker | streams N bytes of incompressible data |
| `/__speed/up` | worker | accepts and discards the request body |

The app proxies `/__speed/*` to the worker assigned to the browser session
(cookie `st_sid`), which keeps the page same-origin. When a worker published a
host port, `/__speed/meta` also returns `workerOrigin` and the page measures
straight against that origin instead: one hop, no proxy in the data path. The
page probes that origin first and silently falls back to the proxy when it is
unreachable.

## Configuration

Set these in `.env` (the table below matches its contents). Every key is
optional: `docker-compose.yml` falls back to the same value inline.

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_PORT` / `APP_BIND` | `3390` / `0.0.0.0` | published port and bind address |
| `WORKER_PROVIDER` | `auto` | `auto`, `docker` or `native` |
| `WORKER_NETWORK` | `speedtest-workers` | docker network workers join |
| `WORKER_PORT` | `8080` | worker port inside that network |
| `WORKER_POOL_SIZE` | `3` | most workers kept alive at once |
| `WORKER_IDLE_SECONDS` | `120` | idle time before a worker is removed |
| `WORKER_MAX_BYTES` | `536870912` | largest single download a worker will serve |
| `WORKER_LOCATION` | `Local Docker Network` | label shown as the test server name |
| `WORKER_PUBLISH` | `auto` | publish an ephemeral host port per worker; `none` forces the proxy |
| `WORKER_PUBLISH_HOST` | `0.0.0.0` | interface those worker ports bind to |

## Security note

`.env` is committed and must never hold a secret — put those in Arcane's
environment secrets or a local `.env.local` instead. Mounting
`/var/run/docker.sock` gives the container root-equivalent control of the host
daemon, and the app has no authentication. Run it on a host you trust and keep
the published port private (set `APP_BIND=127.0.0.1` if the machine is not
dedicated to this tool).

Worker ports are published on `WORKER_PUBLISH_HOST` while a worker exists, so
they are reachable from anything that can reach the host; they answer only
`/health`, `/__speed/*`. Set `WORKER_PUBLISH=none` for a single-port deployment
and accept the extra proxy hop in the measurement path.

Worker containers are hardened: read-only root filesystem, all capabilities
dropped, `no-new-privileges`, 256 MB memory, one CPU, 64 PID limit, and the
label `speedtest.owned=true` so leftovers are reaped on the next app start.

## Troubleshooting

- `/healthz` shows `provider: "native"` — the app could not reach the docker
  socket, so workers run as local processes.
- `/healthz` shows a `warning` about a missing image — run
  `docker compose build`; workers are created from the same image tag.
- `/__speed/*` returns 503 `worker-unavailable` — a worker could not be started;
  the message carries the docker error, usually an image or network mismatch.
- Uploads or downloads look slow and the page logged
  `direct worker unreachable` — the browser cannot reach the published worker
  port (firewall or `WORKER_PUBLISH=none`), so traffic goes through the app.
- Workers disappear after a couple of minutes idle — that is intended; the next
  request starts a fresh one.
