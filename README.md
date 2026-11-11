# Private speed test

A self-hosted Internet speed test. The page is static; every measurement runs
against short-lived **test worker** containers that the app starts on demand
through the Docker socket and removes again when they go idle.

```
browser  ──►  app (port 3000)  ──►  worker container (port 8080, not published)
                    │
                    └── docker socket ──► create / start / remove workers
```

The app and its workers are the **same image**, started with different
commands. Nothing needs to be built twice: `docker compose up --build` produces
one image, and worker containers are created from it on demand.

## Repository layout

```
docker-compose.yml     Compose project (deploy root)
.env.git               Committed defaults, merged into the project .env
app/                   Application source, Dockerfile and site templates
app/server.mjs         Static site, /healthz and the /__speed proxy
app/orchestrator.mjs   Worker pool: spawn, sticky sessions, idle reaping
app/docker-engine.mjs  Minimal Docker Engine API client (no dependencies)
app/worker/server.mjs  Measurement worker (download/upload/ping/meta)
app/templates/         Page source; build.mjs generates app/dist/
```

## Deploy from Arcane

1. Projects → **Create Project** → **From Git Repo**, direction **Pull**.
2. Repository `ssh://git@192.168.1.88:2222/decryptedchaos/speed-test.git` (the Git host listens on port 2222), branch `main`.
3. Compose file path: `docker-compose.yml` (repository root).
4. Sync. Arcane merges `.env.git` into the project `.env`; adjust values there
   (for example `WORKER_LOCATION`), save, and deploy.

The app needs the Docker socket to create its workers; the mount is already in
the Compose file. Give the host a moment to start — workers are only created on
first use, so `/healthz` reporting `"workers": 0` right after deploy is normal.

## Deploy without Arcane

```bash
cp .env.git .env          # optional: override defaults
docker compose up -d --build
curl -s localhost:3000/healthz
```

## Run without Docker (development)

The app falls back to running workers as local child processes when no docker
socket is reachable, so the whole flow works on a machine without Docker:

```bash
cd app
node build.mjs
node server.mjs          # http://localhost:3000, provider=native
```

## Endpoints

| Route | Served by | Purpose |
| --- | --- | --- |
| `/`, `/about`, `/static/*` | app | static site from `app/dist` |
| `/healthz` | app | provider, worker and session counts |
| `/__speed/meta` | app → worker | protocol, client IP, worker label |
| `/__speed/ping` | app → worker | small no-store probe |
| `/__speed/down?bytes=N` | app → worker | streams N bytes of incompressible data |
| `/__speed/up` | app → worker | accepts and discards the request body |

The app proxies `/__speed/*` to the worker assigned to the browser session
(cookie `st_sid`), so the page stays same-origin and only one port is exposed.

## Configuration

Set these in `.env` (or the project env in Arcane). Defaults are inline in
`docker-compose.yml`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_PORT` / `APP_BIND` | `3000` / `0.0.0.0` | published port and bind address |
| `SPEEDTEST_IMAGE` | `speedtest:local` | image tag built and reused for workers |
| `WORKER_PROVIDER` | `auto` | `auto`, `docker` or `native` |
| `WORKER_COMMAND` | `node worker/server.mjs` | command workers run inside the image |
| `WORKER_NETWORK` | `speedtest-workers` | docker network workers join |
| `WORKER_PORT` | `8080` | worker port inside that network |
| `WORKER_POOL_SIZE` | `3` | most workers kept alive at once |
| `WORKER_IDLE_SECONDS` | `120` | idle time before a worker is removed |
| `WORKER_MAX_BYTES` | `536870912` | largest single download a worker will serve |
| `WORKER_LOCATION` | `Local Docker Network` | label shown as the test server name |

## Security note

Mounting `/var/run/docker.sock` gives the container root-equivalent control of
the host daemon, and the app has no authentication. Run it on a host you trust
and keep the published port private (set `APP_BIND=127.0.0.1` if the machine is
not dedicated to this tool).

Worker containers are hardened: read-only root filesystem, all capabilities
dropped, `no-new-privileges`, 256 MB memory, one CPU, 64 PID limit, and the
label `speedtest.owned=true` so leftovers are reaped on the next app start.

## Troubleshooting

- `/healthz` shows `provider: "native"` — the app could not reach the docker
  socket, so workers run as local processes.
- `/__speed/*` returns 503 `worker-unavailable` — a worker could not be started;
  the message carries the docker error, usually an image or network mismatch.
- Workers disappear after a couple of minutes idle — that is intended; the next
  request starts a fresh one.
