import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWorkerPool } from './orchestrator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, 'dist');
const PORT = parseInt(process.env.PORT || '3000', 10);
const SESSION_COOKIE = 'st_sid';
const SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const pool = createWorkerPool();

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  send(
    res,
    status,
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length),
      ...extraHeaders,
    },
    body,
  );
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function sessionOf(req) {
  const existing = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (existing && SESSION_PATTERN.test(existing)) return { sid: existing, isNew: false };
  return { sid: crypto.randomUUID(), isNew: true };
}

function sessionCookie(sid) {
  return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax`;
}

function normalizeAddress(address) {
  if (!address) return null;
  const trimmed = address.trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.slice(7);
  return trimmed;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return normalizeAddress(forwarded.split(',')[0]);
  }
  return normalizeAddress(req.socket.remoteAddress);
}

function unbracket(hostname) {
  return hostname.replace(/^\[|\]$/g, '');
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
  if (pathname.endsWith('/')) filePath = path.join(DIST, pathname, 'index.html');

  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(DIST))) {
    send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden');
    return;
  }

  let stat = null;
  try { stat = fs.statSync(resolved); } catch { stat = null; }

  if (stat && stat.isDirectory()) {
    const index = path.join(resolved, 'index.html');
    if (fs.existsSync(index)) filePath = index;
    else {
      send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
      return;
    }
  } else {
    filePath = resolved;
  }

  if (!fs.existsSync(filePath)) {
    send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
    return;
  }

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  send(
    res,
    200,
    { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': String(data.length) },
    req.method === 'HEAD' ? undefined : data,
  );
}

/**
 * Streams one request to a worker without buffering, so a download measures the
 * wire and not this process. Resolves true once the response has been relayed.
 */
function forward(req, res, worker, url, sid, isNewSession) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let target;
    try {
      target = new URL(url.pathname + url.search, worker.url);
    } catch {
      settle(false);
      return;
    }

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === 'cookie' || lower === 'host') continue;
      headers[key] = value;
    }
    const ip = clientIp(req);
    if (ip) {
      headers['x-client-ip'] = ip;
      headers['x-forwarded-for'] = ip;
    }
    headers.host = target.host;

    const upstream = http.request(
      {
        hostname: unbracket(target.hostname),
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers,
        timeout: 0,
      },
      (upstreamRes) => {
        const outHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (HOP_BY_HOP.has(key.toLowerCase())) continue;
          outHeaders[key] = value;
        }
        if (isNewSession) outHeaders['set-cookie'] = [sessionCookie(sid)];
        res.writeHead(upstreamRes.statusCode || 502, outHeaders);
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
        upstreamRes.on('end', () => settle(true));
      },
    );

    upstream.on('error', () => settle(false));
    res.on('finish', () => settle(true));
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.on('close', () => {
      if (!req.readableEnded) upstream.destroy();
    });

    req.pipe(upstream);
  });
}

async function handleProxy(req, res, url) {
  const { sid, isNew } = sessionOf(req);
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let worker;
    try {
      worker = await pool.acquire(sid);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 503, { error: 'worker-unavailable', message: err.message });
      }
      return;
    }

    try {
      const relayed = await forward(req, res, worker, url, sid, isNew);
      if (relayed) return;
      lastError = new Error(`worker ${worker.id.slice(0, 12)} closed the connection`);
    } catch (err) {
      lastError = err;
    }

    await pool.invalidate(worker.id).catch(() => {});
    if (res.headersSent) return;
  }

  if (!res.headersSent) {
    sendJson(res, 502, {
      error: 'worker-unreachable',
      message: lastError ? lastError.message : 'the test worker could not be reached',
    });
  }
}

async function handleMeta(req, res) {
  const { sid, isNew } = sessionOf(req);
  let worker;
  try {
    worker = await pool.acquire(sid);
  } catch (err) {
    sendJson(res, 503, { error: 'worker-unavailable', message: err.message });
    return;
  }

  try {
    const response = await new Promise((resolve, reject) => {
      const target = new URL('/__speed/meta', worker.url);
      const request = http.get(
        {
          hostname: unbracket(target.hostname),
          port: target.port || 80,
          path: target.pathname,
          timeout: 4000,
        },
        (upstreamRes) => {
          const chunks = [];
          upstreamRes.on('data', (chunk) => chunks.push(chunk));
          upstreamRes.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { resolve({}); }
          });
        },
      );
      request.on('timeout', () => request.destroy(new Error('meta request timed out')));
      request.on('error', reject);
    });

    const ip = clientIp(req);
    sendJson(
      res,
      200,
      {
        protocol: ip && ip.includes(':') ? 'IPv6' : 'IPv4',
        clientIp: ip,
        serverLabel: response.label || worker.label,
        workerId: worker.id.slice(0, 12),
        workerMode: worker.mode,
        location: worker.label,
        time: new Date().toISOString(),
      },
      isNew ? { 'Set-Cookie': sessionCookie(sid) } : {},
    );
  } catch (err) {
    await pool.invalidate(worker.id).catch(() => {});
    sendJson(res, 502, { error: 'worker-unreachable', message: err.message });
  }
}

async function handleHealth(res) {
  const stats = await pool.stats().catch((err) => ({ provider: 'unknown', error: err.message }));
  sendJson(res, 200, { ok: true, uptimeSeconds: Math.round(process.uptime()), ...stats });
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request');
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request');
    return;
  }

  const pathname = url.pathname;

  if (pathname === '/healthz') {
    handleHealth(res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { ok: false });
    });
    return;
  }

  if (pathname === '/__speed/meta') {
    handleMeta(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'meta-failed' });
    });
    return;
  }

  if (pathname === '/__speed/ping' || pathname === '/__speed/down' || pathname === '/__speed/up') {
    handleProxy(req, res, url).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'proxy-failed' });
    });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, pathname);
    return;
  }

  send(res, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`speed test app listening on http://0.0.0.0:${PORT}`);
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log(`[app] ${signal} received, stopping test workers`);
    server.close();
    pool
      .shutdown()
      .catch((err) => console.warn(`[app] worker shutdown failed: ${err.message}`))
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
