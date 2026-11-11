(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $all = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /* ------------------------------------------------------------- menus */

  const langBtn = $('[data-menu-btn="lang"]');
  const themeBtn = $('[data-menu-btn="theme"]');
  const langMenu = $('[data-menu="lang"]');
  const themeMenu = $('[data-menu="theme"]');

  function closeMenus(except) {
    [[langBtn, langMenu], [themeBtn, themeMenu]].forEach(([button, menu]) => {
      if (menu && menu !== except) {
        menu.classList.remove('open');
        if (button) button.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function toggleMenu(button, menu) {
    if (!menu) return;
    const open = menu.classList.contains('open');
    closeMenus();
    menu.classList.toggle('open', !open);
    if (button) button.setAttribute('aria-expanded', String(!open));
  }

  if (langBtn) langBtn.addEventListener('click', (event) => { event.stopPropagation(); toggleMenu(langBtn, langMenu); });
  if (themeBtn) themeBtn.addEventListener('click', (event) => { event.stopPropagation(); toggleMenu(themeBtn, themeMenu); });
  document.addEventListener('click', () => closeMenus());

  $all('.menu .opt').forEach((option) => {
    option.addEventListener('click', (event) => {
      const menu = event.target.closest('.menu');
      if (menu) {
        $all('.opt', menu).forEach((button) => button.classList.remove('active'));
        event.target.classList.add('active');
      }
      closeMenus();
    });
  });

  const attrToggle = $('#map-attr-toggle');
  const attrSection = $('#map-attrib');
  if (attrToggle && attrSection) {
    attrToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = !attrSection.hasAttribute('hidden');
      if (open) {
        attrSection.setAttribute('hidden', '');
        attrToggle.setAttribute('aria-expanded', 'false');
      } else {
        attrSection.removeAttribute('hidden');
        attrToggle.setAttribute('aria-expanded', 'true');
      }
    });
  }

  /* ---------------------------------------------------------- elements */

  const el = {
    gate: $('#start-gate'),
    start: $('#start-test'),
    play: $('#btn-play'),
    restart: $('#btn-restart'),
    status: $('#test-status'),
    progress: $('#progress'),
    bars: $all('#progress span'),
    down: $('#val-download'),
    up: $('#val-upload'),
    lat: $('#val-latency'),
    jit: $('#val-jitter'),
    loss: $('#val-loss'),
    proto: $('#meta-proto'),
    server: $('#meta-server'),
    ip: $('#meta-ip'),
    nqs: $all('.nqs-item'),
    scale: $('#scale-grid'),
    stageDown: $('#stage-download-body'),
    stageUp: $('#stage-upload-body'),
  };

  const CFG = {
    latencyProbes: 20,
    latencyGapMs: 30,
    // Four transfer sizes, smallest first: the small stages are dominated by
    // connection setup and latency, the large ones by sustained throughput.
    stages: [10 * 1024, 1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024],
    streams: 4,
    uploadBuffer: 8 * 1024 * 1024,
    uploadChunk: 256 * 1024,
    loadedProbeMs: 150,
    // Skip a stage when the previous one projects to longer than this.
    maxStageMs: 30000,
  };

  const PHASE = {
    connect: [0, 2],
    latency: [2, 14],
    download: [14, 56],
    upload: [56, 100],
  };

  const SCALE_ROWS = [
    { key: 'down', label: 'Download', unit: 'Mbps', digits: 1, grades: [500, 200, 50, 10] },
    { key: 'up', label: 'Upload', unit: 'Mbps', digits: 1, grades: [200, 50, 15, 5] },
    { key: 'lat', label: 'Latency', unit: 'ms', digits: 1, grades: [10, 25, 50, 100], lowerBetter: true },
    { key: 'jit', label: 'Jitter', unit: 'ms', digits: 1, grades: [2, 5, 12, 30], lowerBetter: true },
    { key: 'loss', label: 'Packet loss', unit: '%', digits: 2, grades: [0, 0.5, 1.5, 4], lowerBetter: true },
  ];

  const DOWNLOAD_SCALE = SCALE_ROWS[0];

  const state = { running: false, controller: null, base: '' };

  /* --------------------------------------------------------- utilities */

  function abortError() { return new DOMException('Aborted', 'AbortError'); }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(abortError()); return; }
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      function cleanup() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      function onAbort() { cleanup(); reject(abortError()); }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function percentile(values, p) {
    if (!values || !values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
  }

  function median(values) { return percentile(values, 50); }

  function cacheBuster() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

  // Workers publish their own host port when they can, which takes this app out
  // of the data path; an empty base means "go through the same-origin proxy".
  function speedUrl(path) { return `${state.base}${path}`; }

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  function gradeFor(value, row) {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    const grades = row.grades;
    for (let index = 0; index < grades.length; index += 1) {
      const passed = row.lowerBetter ? value <= grades[index] : value >= grades[index];
      if (passed) return 5 - index;
    }
    return 1;
  }

  /* ---------------------------------------------------------- progress */

  function setProgress(percent) {
    const clamped = Math.max(0, Math.min(100, percent));
    const filled = Math.round((clamped / 100) * el.bars.length);
    el.bars.forEach((bar, index) => bar.classList.toggle('active', index < filled));
    if (el.progress) el.progress.setAttribute('aria-valuenow', String(Math.round(clamped)));
  }

  function phaseProgress(phase, fraction) {
    const [start, end] = PHASE[phase] || [0, 100];
    setProgress(start + (end - start) * Math.max(0, Math.min(1, fraction)));
  }

  /* ----------------------------------------------------------- display */

  function setMetric(node, value, unit, digits = 1) {
    if (!node) return;
    if (value === null || value === undefined || !Number.isFinite(value)) {
      node.textContent = '-';
      return;
    }
    node.innerHTML = `${value.toFixed(digits)}<span class="unit">${unit}</span>`;
  }

  function setStatus(text) { if (el.status) el.status.textContent = text; }

  function renderMeta(meta) {
    if (el.proto) el.proto.textContent = `Connected via ${meta.protocol || 'IPv4'}`;
    if (el.server) el.server.textContent = meta.serverLabel || 'local test worker';
    if (el.ip) el.ip.textContent = meta.clientIp || 'unavailable';
    const row = el.ip && el.ip.parentElement;
    if (row) row.title = `worker ${meta.workerId || 'unknown'} (${meta.workerMode || 'unknown'})`;
  }

  function renderScale(metrics) {
    if (!el.scale) return;
    el.scale.innerHTML = SCALE_ROWS.map((row) => {
      const value = metrics[row.key];
      const grade = gradeFor(value, row);
      const cells = [5, 4, 3, 2, 1]
        .map((step) => `<span class="cell grade-${step}${grade === step ? ' on' : ''}"></span>`)
        .join('');
      const text = value === null || value === undefined || !Number.isFinite(value)
        ? '-'
        : `${value.toFixed(row.digits)} ${row.unit}`;
      return `<div class="scale-row"><span class="scale-name">${row.label}</span>`
        + `<span class="scale-value">${text}</span>`
        + `<span class="scale-cells" role="img" aria-label="${row.label} grade ${grade === null ? 'pending' : grade} of 5">${cells}</span></div>`;
    }).join('');
  }

  function renderStages(body, stages, emptyText) {
    if (!body) return;
    if (!stages.length) {
      body.innerHTML = `<tr class="stage-empty"><td colspan="4">${emptyText}</td></tr>`;
      return;
    }
    body.innerHTML = stages.map((stage) => {
      if (stage.skipped) {
        return `<tr><td class="grade"><span class="stage-dot grade-1" style="opacity:.3"></span></td>`
          + `<td>${formatBytes(stage.size)}</td><td>skipped</td><td>-</td></tr>`;
      }
      const grade = gradeFor(stage.mbps, DOWNLOAD_SCALE) || 1;
      const loaded = stage.loaded === null || stage.loaded === undefined ? '-' : `${stage.loaded.toFixed(1)} ms`;
      return `<tr><td class="grade"><span class="stage-dot grade-${grade}"></span></td>`
        + `<td>${formatBytes(stage.size)}</td><td>${stage.mbps.toFixed(1)} Mbps</td><td>${loaded}</td></tr>`;
    }).join('');
  }

  const SCORE_LABELS = { 1: 'Poor', 2: 'Okay', 3: 'Good', 4: 'Great', 5: 'Excellent' };

  function stars(count) { return '★★★★★'.slice(0, count) + '☆☆☆☆☆'.slice(0, 5 - count); }

  function scoreStreaming(m) {
    if (m.down === null) return null;
    const loaded = m.loadedDown === null ? Infinity : m.loadedDown;
    const loss = m.loss === null ? 0 : m.loss;
    if (m.down >= 50 && loaded <= 80 && loss < 1) return 5;
    if (m.down >= 25 && loaded <= 150 && loss < 2) return 4;
    if (m.down >= 10 && loaded <= 300 && loss < 5) return 3;
    if (m.down >= 5) return 2;
    return 1;
  }

  function scoreGaming(m) {
    if (m.lat === null) return null;
    const jitter = m.jitter === null ? Infinity : m.jitter;
    const loss = m.loss === null ? 0 : m.loss;
    if (m.lat <= 30 && jitter <= 5 && loss < 0.5) return 5;
    if (m.lat <= 60 && jitter <= 10 && loss < 1) return 4;
    if (m.lat <= 100 && jitter <= 25 && loss < 2) return 3;
    if (m.lat <= 200) return 2;
    return 1;
  }

  function scoreVideo(m) {
    if (m.up === null) return null;
    const loaded = m.loadedUp === null ? Infinity : m.loadedUp;
    const jitter = m.jitter === null ? Infinity : m.jitter;
    const loss = m.loss === null ? 0 : m.loss;
    if (m.up >= 10 && loaded <= 100 && jitter <= 10 && loss < 1) return 5;
    if (m.up >= 5 && loaded <= 180 && jitter <= 20 && loss < 2) return 4;
    if (m.up >= 2 && loaded <= 350 && jitter <= 40 && loss < 5) return 3;
    if (m.up >= 1) return 2;
    return 1;
  }

  function renderScores(metrics) {
    if (!el.nqs.length) return;
    const names = ['Streaming', 'Gaming', 'Video Calls'];
    const scores = [scoreStreaming(metrics), scoreGaming(metrics), scoreVideo(metrics)];
    el.nqs.forEach((item, index) => {
      const name = item.querySelector('.nqs-name');
      const pending = item.querySelector('.nqs-pending');
      const starNode = item.querySelector('.stars');
      const score = scores[index];
      if (name) name.textContent = names[index];
      if (pending) pending.textContent = score === null ? `${names[index]} score pending` : SCORE_LABELS[score];
      if (starNode) starNode.textContent = score === null ? '★★★★★' : stars(score);
    });
  }

  /* ------------------------------------------------------ measurements */

  async function fetchMeta(signal) {
    const res = await fetch(`/__speed/meta?r=${cacheBuster()}`, { cache: 'no-store', signal });
    if (!res.ok) {
      let message = '';
      try { message = (await res.json()).message || ''; } catch { /* not json */ }
      throw new Error(message || `worker info request failed with ${res.status}`);
    }
    return res.json();
  }

  async function probe(signal) {
    const started = performance.now();
    const res = await fetch(speedUrl(`/__speed/ping?r=${cacheBuster()}`), { cache: 'no-store', signal });
    if (!res.ok) throw new Error(`ping failed with ${res.status}`);
    await res.arrayBuffer();
    return performance.now() - started;
  }

  async function measureLatency(signal, probes, onTick) {
    const samples = [];
    let failures = 0;

    for (let i = 0; i < probes; i += 1) {
      if (signal.aborted) throw abortError();
      try {
        samples.push(await probe(signal));
      } catch (err) {
        if (signal.aborted) throw err;
        failures += 1;
      }
      if (onTick) onTick((i + 1) / probes);
      await sleep(CFG.latencyGapMs, signal);
    }

    const deltas = [];
    for (let i = 1; i < samples.length; i += 1) deltas.push(Math.abs(samples[i] - samples[i - 1]));

    return {
      median: median(samples),
      min: samples.length ? Math.min.apply(null, samples) : null,
      jitter: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
      loss: (failures / probes) * 100,
      samples: samples.length,
    };
  }

  /** Small probes fired while a stage runs, for that stage's loaded latency. */
  function watchLoadedLatency(signal, bucket) {
    const stop = new AbortController();
    (async () => {
      while (!stop.signal.aborted && !signal.aborted) {
        try {
          bucket.push(await probe(stop.signal));
        } catch (err) {
          if (err && err.name === 'AbortError') break;
        }
        try {
          await sleep(CFG.loadedProbeMs, stop.signal);
        } catch {
          break;
        }
      }
    })();
    return () => stop.abort();
  }

  async function downloadAmount(signal, amount, onBytes) {
    let sent = 0;
    while (sent < amount) {
      const want = Math.min(amount - sent, 100 * 1024 * 1024);
      const res = await fetch(speedUrl(`/__speed/down?bytes=${want}&r=${cacheBuster()}`), { cache: 'no-store', signal });
      if (!res.ok) throw new Error(`download failed with ${res.status}`);
      if (!res.body) {
        const buffer = await res.arrayBuffer();
        sent += buffer.byteLength;
        onBytes(buffer.byteLength);
        continue;
      }
      const reader = res.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value) {
            sent += chunk.value.byteLength;
            onBytes(chunk.value.byteLength);
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    }
  }

  function randomBuffer(bytes) {
    const buffer = new Uint8Array(bytes);
    const chunk = 65536;
    for (let offset = 0; offset < bytes; offset += chunk) {
      const end = Math.min(offset + chunk, bytes);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(buffer.subarray(offset, end));
      else for (let i = offset; i < end; i += 1) buffer[i] = (i * 31) & 0xff;
    }
    return buffer;
  }

  function streamBody(source, totalBytes, chunkBytes, onSent) {
    let sent = 0;
    let offset = 0;
    return new ReadableStream({
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(chunkBytes, totalBytes - sent);
        const end = offset + size;
        const piece = end <= source.length ? source.subarray(offset, end) : source.subarray(offset);
        offset = end >= source.length ? 0 : end;
        sent += size;
        onSent(size);
        controller.enqueue(piece);
      },
    });
  }

  async function uploadAmount(signal, amount, onBytes, streaming) {
    if (streaming) {
      const body = streamBody(randomBuffer(CFG.uploadChunk), amount, CFG.uploadChunk, onBytes);
      const res = await fetch(speedUrl(`/__speed/up?r=${cacheBuster()}`), {
        method: 'POST',
        body,
        duplex: 'half',
        cache: 'no-store',
        signal,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      });
      if (!res.ok) throw new Error(`upload failed with ${res.status}`);
      await res.arrayBuffer();
      return;
    }

    const source = randomBuffer(CFG.uploadBuffer);
    let sent = 0;
    while (sent < amount) {
      const size = Math.min(source.byteLength, amount - sent);
      const body = size === source.byteLength ? source : source.subarray(0, size);
      const res = await fetch(speedUrl(`/__speed/up?r=${cacheBuster()}`), {
        method: 'POST',
        body,
        cache: 'no-store',
        signal,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      });
      if (!res.ok) throw new Error(`upload failed with ${res.status}`);
      await res.arrayBuffer();
      sent += size;
      onBytes(size);
    }
  }

  /**
   * Some browsers only allow streamed request bodies over HTTP/2 (Chromium
   * answers ERR_H2_OR_QUIC_REQUIRED on HTTP/1.1), so decide once per page
   * whether this browser can stream an upload instead of guessing mid-test.
   */
  let streamingUploads = null;

  function negotiatedProtocol() {
    try {
      const entries = performance.getEntriesByType('resource');
      for (const entry of entries) {
        if (entry.name.startsWith(location.origin) && entry.nextHopProtocol) return entry.nextHopProtocol;
      }
    } catch { /* resource timing unavailable */ }
    return null;
  }

  async function canStreamUploads(signal) {
    if (streamingUploads !== null) return streamingUploads;
    const protocol = negotiatedProtocol();
    if (protocol && protocol !== 'h2' && protocol !== 'h3') {
      streamingUploads = false;
      return streamingUploads;
    }
    const probeBytes = 64 * 1024;
    try {
      const body = streamBody(new Uint8Array(probeBytes), probeBytes, probeBytes, () => {});
      const res = await fetch(speedUrl(`/__speed/up?probe=1&r=${cacheBuster()}`), {
        method: 'POST',
        body,
        duplex: 'half',
        cache: 'no-store',
        signal,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      });
      await res.arrayBuffer();
      streamingUploads = res.ok;
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      streamingUploads = false;
    }
    return streamingUploads;
  }

  async function runStage(signal, direction, size, streaming, onProgress) {
    const streams = Math.max(1, Math.min(CFG.streams, Math.ceil(size / (2 * 1024 * 1024))));
    const slice = Math.floor(size / streams);
    const loaded = [];
    let bytes = 0;

    const stopProbes = watchLoadedLatency(signal, loaded);
    const started = performance.now();
    const tasks = [];
    for (let index = 0; index < streams; index += 1) {
      const amount = index === streams - 1 ? size - slice * (streams - 1) : slice;
      const onBytes = (count) => {
        bytes += count;
        if (onProgress) onProgress(Math.min(1, bytes / size));
      };
      tasks.push(direction === 'down'
        ? downloadAmount(signal, amount, onBytes)
        : uploadAmount(signal, amount, onBytes, streaming));
    }

    try {
      await Promise.all(tasks);
    } finally {
      stopProbes();
    }

    const elapsed = performance.now() - started;
    return {
      size,
      bytes,
      ms: elapsed,
      mbps: elapsed > 0 ? (bytes * 8) / (elapsed / 1000) / 1e6 : 0,
      loaded: median(loaded),
    };
  }

  async function runStages(signal, direction, streaming, onProgress, onStage) {
    let previous = null;
    for (let index = 0; index < CFG.stages.length; index += 1) {
      const size = CFG.stages[index];
      const base = index / CFG.stages.length;
      const span = 1 / CFG.stages.length;

      if (previous && previous.mbps > 0) {
        const projected = (size * 8) / (previous.mbps * 1e6);
        if (projected > CFG.maxStageMs / 1000) {
          onStage({ size, skipped: true });
          onProgress(base + span);
          continue;
        }
      }

      setStatus(`${direction === 'down' ? 'Download' : 'Upload'} ${formatBytes(size)}`);
      const result = await runStage(signal, direction, size, streaming, (fraction) => onProgress(base + span * fraction));
      onStage(result);
      previous = result;
      onProgress(base + span);
    }
  }

  function lastStage(stages) {
    for (let index = stages.length - 1; index >= 0; index -= 1) {
      if (!stages[index].skipped) return stages[index];
    }
    return null;
  }

  /* ------------------------------------------------------------ the run */

  /**
   * When the worker published a host port this page can reach, measure straight
   * against it: one hop instead of two and nothing buffering in the middle.
   * Falls back to the same-origin proxy when the probe fails.
   */
  async function pickOrigin(meta, signal) {
    const origin = meta && meta.workerOrigin;
    if (!origin || location.protocol !== 'http:' || !/^http:\/\/[^/]+$/.test(origin)) return '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const relayAbort = () => controller.abort();
    signal.addEventListener('abort', relayAbort, { once: true });
    try {
      const ping = await fetch(`${origin}/__speed/ping?r=${cacheBuster()}`, { cache: 'no-store', signal: controller.signal });
      if (!ping.ok) return '';
      await ping.arrayBuffer();
      const sample = await fetch(`${origin}/__speed/down?bytes=65536&r=${cacheBuster()}`, { cache: 'no-store', signal: controller.signal });
      if (!sample.ok) return '';
      await sample.arrayBuffer();
      return origin;
    } catch (err) {
      if (window.console) console.warn('[speedtest] direct worker unreachable, measuring through the proxy', err);
      return '';
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', relayAbort);
    }
  }

  function emptyMetrics() {
    return { down: null, up: null, lat: null, jitter: null, loss: null, loadedDown: null, loadedUp: null };
  }

  function resetMetrics() {
    setMetric(el.down, null);
    setMetric(el.up, null);
    setMetric(el.lat, null);
    setMetric(el.jit, null);
    setMetric(el.loss, null);
    renderScores(emptyMetrics());
    renderScale(emptyMetrics());
    renderStages(el.stageDown, [], 'Download not measured yet');
    renderStages(el.stageUp, [], 'Upload not measured yet');
    setProgress(0);
  }

  async function runTest() {
    if (state.running) return;
    state.running = true;
    state.controller = new AbortController();
    const signal = state.controller.signal;

    if (el.gate) el.gate.classList.add('hidden');
    state.base = '';
    resetMetrics();
    setStatus('Connecting to the test worker');
    if (el.play) el.play.disabled = true;
    if (el.restart) el.restart.disabled = false;

    const metrics = emptyMetrics();
    const downloadStages = [];
    const uploadStages = [];

    try {
      phaseProgress('connect', 0.2);
      const meta = await fetchMeta(signal);
      renderMeta(meta);
      state.base = await pickOrigin(meta, signal);
      phaseProgress('connect', 1);

      setStatus('Measuring latency');
      const latency = await measureLatency(signal, CFG.latencyProbes, (fraction) => phaseProgress('latency', fraction));
      metrics.lat = latency.median;
      metrics.jitter = latency.jitter;
      metrics.loss = latency.loss;
      setMetric(el.lat, latency.median, 'ms');
      setMetric(el.jit, latency.jitter, 'ms');
      setMetric(el.loss, latency.loss, '%');
      if (el.lat) {
        el.lat.title = `median of ${latency.samples} probes, lowest ${latency.min === null ? '-' : latency.min.toFixed(1)} ms`;
      }
      renderScale(metrics);
      phaseProgress('latency', 1);

      const streaming = await canStreamUploads(signal);

      await runStages(
        signal,
        'down',
        streaming,
        (fraction) => phaseProgress('download', fraction),
        (stage) => {
          downloadStages.push(stage);
          const best = lastStage(downloadStages);
          metrics.down = best ? best.mbps : metrics.down;
          metrics.loadedDown = best ? best.loaded : metrics.loadedDown;
          setMetric(el.down, metrics.down, 'Mbps');
          if (el.down) el.down.title = `sustained rate of the largest completed transfer`;
          renderStages(el.stageDown, downloadStages, 'Download not measured yet');
          renderScale(metrics);
        },
      );
      phaseProgress('download', 1);

      await runStages(
        signal,
        'up',
        streaming,
        (fraction) => phaseProgress('upload', fraction),
        (stage) => {
          uploadStages.push(stage);
          const best = lastStage(uploadStages);
          metrics.up = best ? best.mbps : metrics.up;
          metrics.loadedUp = best ? best.loaded : metrics.loadedUp;
          setMetric(el.up, metrics.up, 'Mbps');
          if (el.up) el.up.title = `sustained rate of the largest completed transfer`;
          renderStages(el.stageUp, uploadStages, 'Upload not measured yet');
          renderScale(metrics);
        },
      );
      phaseProgress('upload', 1);

      setStatus('Finished');
      renderScores(metrics);
      renderScale(metrics);
      setProgress(100);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        setStatus('Paused');
      } else {
        setStatus('Could not reach the test worker');
        if (window.console) console.error('[speedtest]', err);
        renderScores(metrics);
      }
    } finally {
      state.running = false;
      state.controller = null;
      if (el.play) el.play.disabled = true;
      if (el.restart) el.restart.disabled = false;
    }
  }

  async function restart() {
    if (state.controller) state.controller.abort();
    while (state.running) await new Promise((resolve) => setTimeout(resolve, 50));
    runTest();
  }

  if (el.start) el.start.addEventListener('click', () => { runTest(); });
  if (el.restart) el.restart.addEventListener('click', () => { restart(); });

  const privacyDialog = $('#privacy-dialog');
  const learnMore = $('#learn-more');
  const closeDialog = $('#close-privacy');
  if (learnMore && privacyDialog) {
    learnMore.addEventListener('click', () => {
      try { privacyDialog.showModal(); } catch { privacyDialog.setAttribute('open', ''); }
    });
  }
  if (closeDialog && privacyDialog) {
    closeDialog.addEventListener('click', () => {
      try { privacyDialog.close(); } catch { privacyDialog.removeAttribute('open'); }
    });
  }

  resetMetrics();
  setStatus('Ready');

  // Fill the sidebar before the first run so the page shows where it tests.
  (async () => {
    try {
      renderMeta(await fetchMeta());
    } catch (err) {
      if (el.server) el.server.textContent = 'unavailable';
      if (el.ip) el.ip.textContent = '-';
      if (window.console) console.warn('[speedtest] could not load worker info', err);
    }
  })();
})();
