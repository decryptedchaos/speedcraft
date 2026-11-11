import http from 'node:http';

const DEFAULT_SOCKET = process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';

/**
 * Minimal Docker Engine API client. Talks HTTP over the docker socket so the
 * app needs no SDK, no npm dependencies and no docker CLI inside the image.
 */
export class DockerEngine {
  constructor(options = {}) {
    this.socketPath = options.socketPath || process.env.DOCKER_SOCKET || DEFAULT_SOCKET;
  }

  request(method, apiPath, options = {}) {
    const { body, timeoutMs = 15000, headers = {} } = options;
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const requestHeaders = { ...headers };
      if (payload) {
        requestHeaders['Content-Type'] = 'application/json';
        requestHeaders['Content-Length'] = String(payload.length);
      }

      const req = http.request(
        { socketPath: this.socketPath, method, path: apiPath, headers: requestHeaders, timeout: timeoutMs },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { json = null; }
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: res.statusCode, body: json, text });
              return;
            }
            const detail = (json && json.message) || text.slice(0, 300) || 'unknown error';
            const err = new Error(`docker ${method} ${apiPath} failed with ${res.statusCode}: ${detail}`);
            err.statusCode = res.statusCode;
            reject(err);
          });
        },
      );

      req.on('timeout', () => req.destroy(new Error(`docker ${method} ${apiPath} timed out after ${timeoutMs}ms`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  ping() {
    return this.request('GET', '/_ping', { timeoutMs: 3000 });
  }

  async imageExists(image) {
    try {
      await this.request('GET', `/images/${encodeURIComponent(image)}/json`, { timeoutMs: 5000 });
      return true;
    } catch (err) {
      if (err.statusCode === 404) return false;
      throw err;
    }
  }

  async createContainer(spec) {
    const res = await this.request('POST', '/containers/create', { body: spec, timeoutMs: 20000 });
    return res.body && res.body.Id;
  }

  startContainer(id) {
    return this.request('POST', `/containers/${encodeURIComponent(id)}/start`, { timeoutMs: 20000 });
  }

  async inspectContainer(id) {
    const res = await this.request('GET', `/containers/${encodeURIComponent(id)}/json`);
    return res.body;
  }

  async removeContainer(id) {
    try {
      await this.request('DELETE', `/containers/${encodeURIComponent(id)}?force=1&v=1`, { timeoutMs: 20000 });
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  }

  async listContainersByLabel(label) {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    const res = await this.request('GET', `/containers/json?all=1&filters=${filters}`, { timeoutMs: 10000 });
    return Array.isArray(res.body) ? res.body : [];
  }
}
