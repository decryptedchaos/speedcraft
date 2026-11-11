import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerEngine } from './docker-engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OWNER_LABEL = 'speedtest.owned=true';
const MEMORY_BYTES = 256 * 1024 * 1024;

function intFromEnv(value, fallback) {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readSettings() {
  return {
    provider: (process.env.WORKER_PROVIDER || 'auto').toLowerCase(),
    image: process.env.WORKER_IMAGE || 'speedtest:local',
    command: (process.env.WORKER_COMMAND || 'node worker/server.mjs').trim().split(/\s+/),
    workdir: process.env.WORKER_WORKDIR || '/app',
    network: process.env.WORKER_NETWORK || 'speedtest-workers',
    port: intFromEnv(process.env.WORKER_PORT, 8080),
    poolSize: Math.max(1, intFromEnv(process.env.WORKER_POOL_SIZE, 3)),
    idleMs: Math.max(10000, intFromEnv(process.env.WORKER_IDLE_SECONDS, 120) * 1000),
    maxBytes: process.env.WORKER_MAX_BYTES || String(512 * 1024 * 1024),
    location: process.env.WORKER_LOCATION || 'Local Docker Network',
    healthTimeoutMs: Math.max(1000, intFromEnv(process.env.WORKER_HEALTH_TIMEOUT_MS, 15000)),
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function unbracket(hostname) {
  return hostname.replace(/^\[|\]$/g, '');
}

function httpJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (err) { reject(err); return; }

    const req = http.get(
      {
        hostname: unbracket(target.hostname),
        port: target.port || 80,
        path: target.pathname + target.search,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`request to ${url} timed out`)));
    req.on('error', reject);
  });
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
  if (typeof timer.unref === 'function') timer.unref();
}

class WorkerPool {
  constructor() {
    this.settings = readSettings();
    this.engine = new DockerEngine();
    this.workers = new Map();
    this.assignments = new Map();
    this.provider = 'pending';
    this.warning = null;
    this.spawning = null;
    this.sweeper = null;
    this.stopped = false;
    this.initialized = this.init();
    // Keep an unhandled rejection from escaping when nothing has awaited yet.
    this.initialized.catch(() => {});
  }

  async init() {
    const settings = this.settings;

    if (settings.provider === 'native') {
      this.provider = 'native';
    } else {
      try {
        await this.engine.ping();
        this.provider = 'docker';
      } catch (err) {
        if (settings.provider === 'docker') {
          this.provider = 'docker';
          this.warning = `docker engine unreachable at ${this.engine.socketPath}: ${err.message}`;
          throw new Error(this.warning);
        }
        this.provider = 'native';
        this.warning = `docker engine unreachable (${err.message}); running test workers as local processes`;
        console.warn(`[workers] ${this.warning}`);
      }
    }

    if (this.provider === 'docker') {
      const hasImage = await this.engine.imageExists(settings.image).catch(() => false);
      if (!hasImage) {
        this.warning = `worker image "${settings.image}" is not built yet; run "docker compose build"`;
        console.warn(`[workers] ${this.warning}`);
      }
      await this.reapOrphans();
    }

    this.sweeper = setInterval(() => { this.sweep().catch(() => {}); }, 5000);
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref();
    console.log(
      `[workers] provider=${this.provider} pool=${settings.poolSize} idle=${Math.round(settings.idleMs / 1000)}s` +
        (this.provider === 'docker' ? ` image=${settings.image} network=${settings.network}` : ''),
    );
  }

  async reapOrphans() {
    try {
      const containers = await this.engine.listContainersByLabel(OWNER_LABEL);
      for (const container of containers) {
        const id = String(container.Id || '');
        if (!id) continue;
        console.log(`[workers] removing orphaned worker ${id.slice(0, 12)}`);
        await this.engine.removeContainer(id).catch(() => {});
      }
    } catch (err) {
      console.warn(`[workers] orphan cleanup skipped: ${err.message}`);
    }
  }

  async spawn() {
    if (this.spawning) return this.spawning;
    this.spawning = (this.provider === 'docker' ? this.spawnDocker() : this.spawnNative()).finally(() => {
      this.spawning = null;
    });
    return this.spawning;
  }

  async spawnDocker() {
    const settings = this.settings;
    const id = await this.engine.createContainer({
      Image: settings.image,
      // Same image as the app, different command: that is what makes a worker.
      Cmd: settings.command,
      WorkingDir: settings.workdir,
      Env: [
        `WORKER_PORT=${settings.port}`,
        `WORKER_LOCATION=${settings.location}`,
        `WORKER_MAX_BYTES=${settings.maxBytes}`,
        'NODE_ENV=production',
      ],
      Labels: { 'speedtest.owned': 'true', 'speedtest.role': 'worker' },
      ExposedPorts: { [`${settings.port}/tcp`]: {} },
      // The image healthcheck targets the app port, so workers need their own.
      Healthcheck: {
        Test: ['CMD', 'wget', '-q', '-O', '/dev/null', `http://127.0.0.1:${settings.port}/health`],
        Interval: 15000000000,
        Timeout: 3000000000,
        StartPeriod: 2000000000,
        Retries: 3,
      },
      HostConfig: {
        NetworkMode: settings.network,
        ReadonlyRootfs: true,
        Memory: MEMORY_BYTES,
        MemorySwap: MEMORY_BYTES,
        NanoCpus: 1e9,
        PidsLimit: 64,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
      },
    });

    if (!id) throw new Error('docker did not return a container id for the test worker');

    let url;
    try {
      await this.engine.startContainer(id);
      const address = await this.waitForAddress(id);
      url = `http://${address}:${settings.port}`;
      await this.waitForHealth(url);
    } catch (err) {
      await this.engine.removeContainer(id).catch(() => {});
      throw new Error(`could not start a test worker container: ${err.message}`);
    }

    const worker = {
      id,
      mode: 'docker',
      url,
      label: settings.location,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      healthy: true,
    };
    this.workers.set(worker.id, worker);
    console.log(`[workers] started container worker ${worker.id.slice(0, 12)} at ${worker.url}`);
    return worker;
  }

  async waitForAddress(id) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const info = await this.engine.inspectContainer(id).catch(() => null);
      const networks = info && info.NetworkSettings && info.NetworkSettings.Networks;
      const address = networks && networks[this.settings.network] && networks[this.settings.network].IPAddress;
      if (address) return address;
      await delay(150);
    }
    throw new Error(`worker container never joined network ${this.settings.network}`);
  }

  async spawnNative() {
    const settings = this.settings;
    const child = spawn(process.execPath, [path.join(here, 'worker', 'server.mjs')], {
      cwd: here,
      env: {
        ...process.env,
        WORKER_PORT: '0',
        WORKER_BIND: '127.0.0.1',
        WORKER_LOCATION: settings.location,
        WORKER_MAX_BYTES: settings.maxBytes,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('local worker did not report a port in time'));
      }, settings.healthTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      const onData = (chunk) => {
        output += chunk.toString('utf8');
        const match = output.match(/LISTENING (\d+)/);
        if (match) {
          cleanup();
          resolve(parseInt(match[1], 10));
        }
      };
      const onExit = (code) => { cleanup(); reject(new Error(`local worker exited with code ${code}`)); };
      const onError = (err) => { cleanup(); reject(err); };

      child.stdout.on('data', onData);
      child.on('exit', onExit);
      child.on('error', onError);
    });

    child.stdout.resume();
    child.stderr.on('data', (chunk) => process.stderr.write(`[worker] ${chunk}`));

    const url = `http://127.0.0.1:${port}`;
    try {
      await this.waitForHealth(url);
    } catch (err) {
      stopChild(child);
      throw err;
    }

    const worker = {
      id: `local-${port}`,
      mode: 'native',
      url,
      label: settings.location,
      child,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      healthy: true,
    };
    this.workers.set(worker.id, worker);
    console.log(`[workers] started local worker on ${url}`);
    return worker;
  }

  async waitForHealth(url) {
    const deadline = Date.now() + this.settings.healthTimeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const res = await httpJson(`${url}/health`, 2000);
        if (res.status === 200) return;
        lastError = new Error(`health returned ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      await delay(150);
    }
    throw new Error(`test worker did not become healthy: ${lastError ? lastError.message : 'timeout'}`);
  }

  async acquire(sessionId) {
    if (this.stopped) throw new Error('the worker pool is shutting down');
    await this.initialized;

    const assignedId = sessionId ? this.assignments.get(sessionId) : null;
    const assigned = assignedId ? this.workers.get(assignedId) : null;
    if (assigned && assigned.healthy) {
      assigned.lastUsedAt = Date.now();
      return assigned;
    }

    const alive = Array.from(this.workers.values()).filter((worker) => worker.healthy);
    alive.sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    let worker = alive[0];
    if (!worker) {
      if (this.workers.size >= this.settings.poolSize) {
        const oldest = Array.from(this.workers.values())[0];
        if (oldest) {
          await this.destroy(oldest);
        }
      }
      worker = await this.spawn();
    }
    if (!worker) throw new Error('no test worker is available');

    if (sessionId) {
      // Cookie-less clients would otherwise grow this map forever.
      if (this.assignments.size > 5000) this.assignments.clear();
      this.assignments.set(sessionId, worker.id);
    }
    worker.lastUsedAt = Date.now();
    return worker;
  }

  async invalidate(id) {
    const worker = this.workers.get(id);
    if (!worker) {
      for (const [session, workerId] of this.assignments) {
        if (workerId === id) this.assignments.delete(session);
      }
      return;
    }
    await this.destroy(worker);
  }

  async destroy(worker) {
    this.workers.delete(worker.id);
    for (const [session, workerId] of this.assignments) {
      if (workerId === worker.id) this.assignments.delete(session);
    }
    try {
      if (worker.mode === 'docker') {
        await this.engine.removeContainer(worker.id);
      } else {
        stopChild(worker.child);
      }
    } catch (err) {
      console.warn(`[workers] failed to stop worker ${worker.id}: ${err.message}`);
    }
  }

  async sweep() {
    if (this.stopped) return;
    const now = Date.now();
    for (const worker of Array.from(this.workers.values())) {
      if (!worker.healthy || now - worker.lastUsedAt > this.settings.idleMs) {
        await this.destroy(worker);
      }
    }
  }

  async stats() {
    try {
      await this.initialized;
    } catch {
      /* provider failure is reported through provider/warning below */
    }
    const docker = this.provider === 'docker';
    return {
      provider: this.provider,
      socket: docker ? this.engine.socketPath : null,
      image: docker ? this.settings.image : null,
      network: docker ? this.settings.network : null,
      location: this.settings.location,
      poolSize: this.settings.poolSize,
      idleSeconds: Math.round(this.settings.idleMs / 1000),
      workers: this.workers.size,
      sessions: this.assignments.size,
      warning: this.warning,
    };
  }

  async shutdown() {
    this.stopped = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    const all = Array.from(this.workers.values());
    this.assignments.clear();
    await Promise.all(all.map((worker) => this.destroy(worker)));
  }
}

export function createWorkerPool() {
  return new WorkerPool();
}
