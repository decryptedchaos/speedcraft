import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';

const PORT = parseInt(process.env.WORKER_PORT || '8080', 10);
const BIND = process.env.WORKER_BIND || '0.0.0.0';
const MAX_BYTES = positiveInt(process.env.WORKER_MAX_BYTES, 512 * 1024 * 1024);
const LOCATION = process.env.WORKER_LOCATION || 'Local Docker Network';
const CHUNK = 64 * 1024;
const WORKER_ID = (os.hostname() || crypto.randomBytes(4).toString('hex')).slice(0, 12);

// One incompressible block reused for every response: no per-chunk allocation
// on the hot path, and no way for a gateway to shrink the payload.
const FILLER = crypto.randomBytes(1024 * 1024);

function positiveInt(value, fallback) {
  const n = parseInt(value || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length),
  });
  res.end(body);
}

function streamDownload(url, res) {
  const asked = parseInt(url.searchParams.get('bytes') || '0', 10);
  const bytes = Math.max(0, Math.min(Number.isFinite(asked) ? asked : 0, MAX_BYTES));

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'identity',
    'Cache-Control': 'no-store, no-transform',
    'Content-Length': String(bytes),
  });

  if (bytes === 0) {
    res.end();
    return;
  }

  let sent = 0;
  let closed = false;
  res.on('close', () => { closed = true; });

  const pump = () => {
    while (!closed && sent < bytes) {
      const size = Math.min(CHUNK, bytes - sent);
      sent += size;
      const slice = FILLER.subarray(0, size);
      if (sent >= bytes) {
        res.end(slice);
        return;
      }
      if (!res.write(slice)) {
        res.once('drain', pump);
        return;
      }
    }
  };

  pump();
}

function readUpload(req, res) {
  let received = 0;
  const started = process.hrtime.bigint();

  req.on('data', (chunk) => { received += chunk.length; });
  req.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  req.on('end', () => {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    json(res, 200, { ok: true, received, serverMs: Math.round(elapsedMs) });
  });
}

const server = http.createServer((req, res) => {
  req.socket.setNoDelay(true);
  res.setHeader('Cache-Control', 'no-store');

  let url;
  try {
    url = new URL(req.url || '/', 'http://worker.invalid');
  } catch {
    json(res, 400, { ok: false, error: 'bad-request' });
    return;
  }

  const pathname = url.pathname;

  if (pathname === '/health' || pathname === '/healthz') {
    json(res, 200, { ok: true, worker: WORKER_ID, time: Date.now() });
    return;
  }

  if (pathname === '/__speed/ping' && (req.method === 'GET' || req.method === 'HEAD')) {
    json(res, 200, { t: Date.now(), worker: WORKER_ID });
    return;
  }

  if (pathname === '/__speed/meta') {
    json(res, 200, {
      label: LOCATION,
      worker: WORKER_ID,
      hostname: os.hostname(),
      platform: process.platform,
      maxBytes: MAX_BYTES,
      time: new Date().toISOString(),
    });
    return;
  }

  if (pathname === '/__speed/down' && (req.method === 'GET' || req.method === 'HEAD')) {
    streamDownload(url, res);
    return;
  }

  if (pathname === '/__speed/up' && req.method === 'POST') {
    readUpload(req, res);
    return;
  }

  if (pathname === '/__speed/down' || pathname === '/__speed/up') {
    json(res, 405, { ok: false, error: 'method-not-allowed' });
    return;
  }

  json(res, 404, { ok: false, error: 'not-found' });
});

server.on('connection', (socket) => socket.setNoDelay(true));
server.keepAliveTimeout = 65000;
server.headersTimeout = 30000;
server.requestTimeout = 0;

server.listen(PORT, BIND, () => {
  const actualPort = server.address().port;
  // The parent process watches stdout for this exact line when the worker runs
  // as a local child process instead of a container.
  console.log(`LISTENING ${actualPort}`);
  console.log(`worker ${WORKER_ID} on ${BIND}:${actualPort} label="${LOCATION}" maxBytes=${MAX_BYTES}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
