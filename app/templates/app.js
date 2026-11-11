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
  };

  const CFG = {
    latencyProbes: 20,
    latencyGapMs: 30,
    streams: 4,
    windowMs: 8000,
    warmupMs: 700,
    sampleMs: 200,
    downloadRequestBytes: 16 * 1024 * 1024,
    uploadBufferBytes: 2 * 1024 * 1024,
    uploadRequestBytes: 16 * 1024 * 1024,
    uploadChunkBytes: 64 * 1024,
    loadedProbeMs: 500,
  };

  const PHASE = {
    connect: [0, 4],
    latency: [4, 18],
    download: [18, 58],
    upload: [58, 100],
  };

  const state = { running: false, controller: null };

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

  function mbps(bytes, ms) { return ms > 0 ? (bytes * 8) / (ms / 1000) / 1e6 : 0; }

  function cacheBuster() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

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
    const res = await fetch(`/__speed/ping?r=${cacheBuster()}`, { cache: 'no-store', signal });
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

  /**
   * Runs the given streams for a fixed window, samples throughput every 200 ms
   * and returns the raw samples so the caller can take a percentile.
   */
  async function timedWindow(signal, durationMs, startStreams, onSample) {
    const stop = new AbortController();
    const window = { bytes: 0, error: null };
    const tasks = startStreams(stop.signal, window).map((task) =>
      task.catch((err) => {
        if (err && err.name !== 'AbortError' && !window.error) window.error = err;
      }));

    const samples = [];
    const startedAt = performance.now();
    let lastBytes = 0;
    let lastAt = startedAt;

    const timer = setInterval(() => {
      const now = performance.now();
      const elapsed = now - lastAt;
      if (elapsed <= 0) return;
      const rate = mbps(window.bytes - lastBytes, elapsed);
      lastBytes = window.bytes;
      lastAt = now;
      if (now - startedAt >= CFG.warmupMs) {
        samples.push(rate);
        if (onSample) onSample(samples, (now - startedAt) / durationMs);
      }
    }, CFG.sampleMs);

    try {
      await sleep(durationMs, signal);
    } finally {
      clearInterval(timer);
      stop.abort();
      await Promise.allSettled(tasks);
    }

    if (window.error) throw window.error;
    return { bytes: window.bytes, samples };
  }

  function startDownloads(stopSignal, window) {
    const tasks = [];
    for (let i = 0; i < CFG.streams; i += 1) tasks.push(downloadStream(stopSignal, window, i * 40));
    return tasks;
  }

  async function downloadStream(signal, window, delayMs) {
    if (delayMs) await sleep(delayMs, signal).catch(() => {});
    while (!signal.aborted) {
      const res = await fetch(`/__speed/down?bytes=${CFG.downloadRequestBytes}&r=${cacheBuster()}`, { cache: 'no-store', signal });
      if (!res.ok) throw new Error(`download failed with ${res.status}`);
      if (!res.body) {
        const buffer = await res.arrayBuffer();
        window.bytes += buffer.byteLength;
        continue;
      }
      const reader = res.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value) window.bytes += chunk.value.byteLength;
          if (signal.aborted) break;
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    }
  }

  function uploadBuffer(bytes) {
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
      // HTTP/1.1 rejects streamed request bodies, so post buffers instead.
      streamingUploads = false;
      return streamingUploads;
    }
    const probeBytes = 64 * 1024;
    try {
      const body = streamBody(new Uint8Array(probeBytes), probeBytes, probeBytes, () => {});
      const res = await fetch(`/__speed/up?probe=1&r=${cacheBuster()}`, {
        method: 'POST',
        body,
        duplex: 'half',
        cache: 'no-store',
        signal,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      await res.arrayBuffer();
      streamingUploads = res.ok;
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      streamingUploads = false;
    }
    return streamingUploads;
  }

  function startUploads(stopSignal, window, source, streaming) {
    const tasks = [];
    for (let i = 0; i < CFG.streams; i += 1) tasks.push(uploadStream(stopSignal, window, source, i * 40, streaming));
    return tasks;
  }

  async function uploadStream(signal, window, source, delayMs, streaming) {
    if (delayMs) await sleep(delayMs, signal).catch(() => {});

    while (!signal.aborted) {
      const url = `/__speed/up?r=${cacheBuster()}`;

      if (streaming) {
        const body = streamBody(source, CFG.uploadRequestBytes, CFG.uploadChunkBytes, (size) => { window.bytes += size; });
        const res = await fetch(url, {
          method: 'POST',
          body,
          duplex: 'half',
          cache: 'no-store',
          signal,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
        if (!res.ok) throw new Error(`upload failed with ${res.status}`);
        await res.arrayBuffer();
        continue;
      }

      // Buffered fallback: one preallocated body per request, counted on ack.
      const res = await fetch(url, {
        method: 'POST',
        body: source,
        cache: 'no-store',
        signal,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!res.ok) throw new Error(`upload failed with ${res.status}`);
      await res.arrayBuffer();
      window.bytes += source.byteLength;
    }
  }

  /** Small probes fired while a load window runs, for the loaded latency. */
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

  /* ------------------------------------------------------------ the run */

  function resetMetrics() {
    setMetric(el.down, null);
    setMetric(el.up, null);
    setMetric(el.lat, null);
    setMetric(el.jit, null);
    setMetric(el.loss, null);
    renderScores({ down: null, up: null, lat: null, jitter: null, loss: null, loadedDown: null, loadedUp: null });
    setProgress(0);
  }

  async function runTest() {
    if (state.running) return;
    state.running = true;
    state.controller = new AbortController();
    const signal = state.controller.signal;

    if (el.gate) el.gate.classList.add('hidden');
    resetMetrics();
    setStatus('Connecting to the test worker');
    if (el.play) el.play.disabled = true;
    if (el.restart) el.restart.disabled = false;

    const metrics = { down: null, up: null, lat: null, jitter: null, loss: null, loadedDown: null, loadedUp: null };

    try {
      phaseProgress('connect', 0.2);
      renderMeta(await fetchMeta(signal));
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
      phaseProgress('latency', 1);

      setStatus(`Measuring download (${CFG.streams} streams)`);
      const loadedDown = [];
      const stopDown = watchLoadedLatency(signal, loadedDown);
      const download = await timedWindow(signal, CFG.windowMs, startDownloads, (samples, fraction) => {
        setMetric(el.down, percentile(samples, 90), 'Mbps');
        phaseProgress('download', fraction);
      });
      stopDown();
      metrics.down = percentile(download.samples, 90);
      metrics.loadedDown = median(loadedDown);
      setMetric(el.down, metrics.down, 'Mbps');
      if (el.down) {
        el.down.title = `90th percentile of ${download.samples.length} samples, loaded latency ${metrics.loadedDown === null ? '-' : metrics.loadedDown.toFixed(1)} ms`;
      }
      phaseProgress('download', 1);

      setStatus(`Measuring upload (${CFG.streams} streams)`);
      const source = uploadBuffer(CFG.uploadBufferBytes);
      const streamingUpload = await canStreamUploads(signal);
      const loadedUp = [];
      const stopUp = watchLoadedLatency(signal, loadedUp);
      const upload = await timedWindow(
        signal,
        CFG.windowMs,
        (stopSignal, window) => startUploads(stopSignal, window, source, streamingUpload),
        (samples, fraction) => {
          setMetric(el.up, percentile(samples, 90), 'Mbps');
          phaseProgress('upload', fraction);
        },
      );
      stopUp();
      metrics.up = percentile(upload.samples, 90);
      metrics.loadedUp = median(loadedUp);
      setMetric(el.up, metrics.up, 'Mbps');
      if (el.up) {
        el.up.title = `90th percentile of ${upload.samples.length} samples, loaded latency ${metrics.loadedUp === null ? '-' : metrics.loadedUp.toFixed(1)} ms`;
      }
      phaseProgress('upload', 1);

      setStatus('Finished');
      renderScores(metrics);
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
