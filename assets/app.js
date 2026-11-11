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

  /* ------------------------------------------------------------ theme */

  // The inline script in <head> applies the stored choice before the first
  // paint; this keeps the menu, the media query and the storage in sync.
  const THEME_KEY = 'speedtest.theme';
  const themeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let themeMode = document.documentElement.getAttribute('data-theme-mode') || 'system';

  function applyTheme(mode) {
    themeMode = mode;
    const dark = mode === 'dark' || (mode === 'system' && Boolean(themeMedia && themeMedia.matches));
    const root = document.documentElement;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-theme-mode', mode);
    $all('[data-theme-value]').forEach((button) => {
      button.classList.toggle('active', button.getAttribute('data-theme-value') === mode);
    });
    setTimeout(() => { try { redrawAllCharts(); } catch { /* charts not ready yet */ } }, 0);
  }

  $all('[data-theme-value]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.getAttribute('data-theme-value');
      try { localStorage.setItem(THEME_KEY, mode); } catch { /* storage blocked */ }
      applyTheme(mode);
    });
  });

  if (themeMedia) {
    const followSystem = () => { if (themeMode === 'system') applyTheme('system'); };
    if (themeMedia.addEventListener) themeMedia.addEventListener('change', followSystem);
    else if (themeMedia.addListener) themeMedia.addListener(followSystem);
  }

  applyTheme(themeMode);

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
    stageDown: $('#stage-download-cards'),
    stageUp: $('#stage-upload-cards'),
    latencyCards: $('#latency-cards'),
    chartDown: $('#chart-download'),
    chartUp: $('#chart-upload'),
  };

  const CFG = {
    latencyProbes: 20,
    latencyGapMs: 30,
    // Four transfer sizes, smallest first: the small stages are dominated by
    // connection setup and latency, the large ones by sustained throughput.
    stages: [10 * 1024, 1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024],
    uploadBuffer: 4 * 1024 * 1024,
    uploadChunk: 256 * 1024,
    loadedProbeMs: 150,
  };

  /** Parallel connections per stage: small transfers are one shot, the large
   *  ones need several streams before the pipe is actually full. */
  function streamsFor(size) {
    if (size >= 64 * 1024 * 1024) return 6;
    if (size >= 4 * 1024 * 1024) return 4;
    if (size >= 512 * 1024) return 2;
    return 1;
  }

  /** A path can get slower the more connections you open: a VirtualBox bridge
   *  or a NAT that serialises flows drops from ~90 Mbps on one stream to ~13
   *  Mbps on six. Measure 1, 2, 4 and 6 streams and cap the large stages to the
   *  best of them, so the result reflects the path and not our own concurrency. */
  const MAX_STREAMS = 6;
  const CALIBRATION_STREAMS = [1, 2, 4, 6];
  const CALIBRATION_MS = 1200;
  const calibration = { cap: null, mbps: null };

  async function measureStreams(count, ms, parentSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const relay = () => controller.abort();
    parentSignal.addEventListener('abort', relay, { once: true });
    let bytes = 0;
    const started = performance.now();
    const tasks = [];
    for (let index = 0; index < count; index += 1) {
      tasks.push(downloadAmount(controller.signal, 64 * 1024 * 1024, (count2) => { bytes += count2; }).catch(() => {}));
    }
    try {
      await Promise.all(tasks);
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', relay);
    }
    const elapsed = Math.max(performance.now() - started, 1);
    return bytes === 0 ? 0 : (bytes * 8) / (elapsed / 1000) / 1e6;
  }

  async function calibrateStreams(signal) {
    let best = { count: 1, mbps: 0 };
    for (const count of CALIBRATION_STREAMS) {
      if (signal.aborted) throw abortError();
      let mbps = 0;
      try {
        mbps = await measureStreams(count, CALIBRATION_MS, signal);
      } catch (err) {
        if (signal.aborted) throw abortError();
      }
      if (mbps > best.mbps * 1.05) best = { count, mbps };
    }
    calibration.cap = best.mbps > 0 ? best.count : 1;
    calibration.mbps = best.mbps;
    return calibration.cap;
  }

  /** Per-stage deadline. A stage that runs out of time is still reported: the
   *  bytes it moved over the elapsed time are a real measurement. The largest
   *  stage must never be skipped, because that is where the peak shows. */
  function budgetFor(size) {
    if (size >= 64 * 1024 * 1024) return 75000;
    if (size >= 4 * 1024 * 1024) return 30000;
    return 15000;
  }

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

  /* ------------------------------------------------------------- charts */

  const DOWN_COLOR = '#f7941d';
  const UP_COLOR = '#8b5cf6';
  const LAT_COLOR = '#22a06b';
  const HERO_SLOTS = 150;

  const charts = {
    down: { canvas: el.chartDown, series: [], color: DOWN_COLOR },
    up: { canvas: el.chartUp, series: [], color: UP_COLOR },
  };

  const lastResults = { down: [], up: [], latency: { unloaded: [], down: [], up: [] } };

  let chartTimer = null;

  function themeColor(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function fontFor(size) { return `${size}px ${themeColor('--font-sans', 'sans-serif')}`; }

  function prepCanvas(canvas) {
    if (!canvas) return null;
    const width = Math.max(1, Math.round(canvas.clientWidth || 0));
    const height = Math.max(1, Math.round(canvas.clientHeight || 0));
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  /** Round up to 1, 2 or 5 times a power of ten so the axis stops jittering. */
  function niceMax(value) {
    if (!Number.isFinite(value) || value <= 0) return 10;
    const power = Math.pow(10, Math.floor(Math.log10(value)));
    const scaled = value / power;
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return step * power;
  }

  function pushHeroSample(direction, mbps) {
    const chart = charts[direction];
    if (!chart || !Number.isFinite(mbps)) return;
    chart.series.push(mbps);
    if (chart.series.length > 600) chart.series.splice(0, chart.series.length - 600);
  }

  /** The live line: grows left to right, fills underneath and keeps the 90th
   *  percentile drawn above it, the way the original speed test reads. */
  function drawHero(direction) {
    const chart = charts[direction];
    const prepared = prepCanvas(chart.canvas);
    if (!prepared) return;
    const { ctx, width, height } = prepared;
    const line = themeColor('--line', '#d4d4d4');
    const muted = themeColor('--muted', '#737373');
    const series = chart.series.slice(-HERO_SLOTS);
    const top = 12;
    const bottom = height - 12;
    const innerHeight = Math.max(1, bottom - top);
    const max = niceMax(Math.max.apply(null, series.concat([1])) * 1.15);
    const xAt = (index) => (index / Math.max(1, HERO_SLOTS - 1)) * width;
    const yAt = (value) => bottom - Math.min(1, Math.max(0, value) / max) * innerHeight;

    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, bottom + 0.5);
    ctx.lineTo(width, bottom + 0.5);
    ctx.stroke();

    if (!series.length) {
      ctx.fillStyle = muted;
      ctx.font = fontFor(11);
      ctx.fillText('waiting for samples', 1, top + 8);
      return;
    }

    const p90 = percentile(series, 90);
    if (p90) {
      const y = yAt(p90);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = line;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = muted;
      ctx.font = fontFor(10);
      ctx.fillText(`90th percentile ${p90.toFixed(1)} Mbps`, 1, Math.max(9, y - 5));
    }

    const gradient = ctx.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, `${chart.color}b3`);
    gradient.addColorStop(1, `${chart.color}00`);
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(series[0]));
    for (let index = 1; index < series.length; index += 1) ctx.lineTo(xAt(index), yAt(series[index]));
    ctx.lineTo(xAt(series.length - 1), bottom);
    ctx.lineTo(xAt(0), bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(series[0]));
    for (let index = 1; index < series.length; index += 1) ctx.lineTo(xAt(index), yAt(series[index]));
    ctx.strokeStyle = chart.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    const headX = xAt(series.length - 1);
    const headY = yAt(series[series.length - 1]);
    ctx.beginPath();
    ctx.arc(headX, headY, 6, 0, Math.PI * 2);
    ctx.fillStyle = `${chart.color}40`;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(headX, headY, 3, 0, Math.PI * 2);
    ctx.fillStyle = chart.color;
    ctx.fill();
  }

  function startChartLoop() {
    if (chartTimer) return;
    chartTimer = setInterval(() => { drawHero('down'); drawHero('up'); }, 110);
  }

  function stopChartLoop() {
    if (chartTimer) { clearInterval(chartTimer); chartTimer = null; }
  }

  /** Every sample of a stage on a log speed axis, with quartiles, median and
   *  whiskers: the point cloud shows the spread a single average hides. */
  function drawPointCloud(canvas, values, color) {
    const prepared = prepCanvas(canvas);
    if (!prepared) return;
    const { ctx, width, height } = prepared;
    const line = themeColor('--line', '#d4d4d4');
    const muted = themeColor('--muted', '#737373');
    const numeric = (values || []).filter((value) => Number.isFinite(value) && value > 0);
    const top = 8;
    const bottom = height - 12;
    const innerHeight = Math.max(1, bottom - top);
    const axisMax = niceMax(Math.max.apply(null, numeric.concat([1])) * 1.4);
    const xAt = (value) => (Math.log10(Math.max(1, Math.min(axisMax, value))) / Math.log10(axisMax)) * width;

    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, bottom + 0.5);
    ctx.lineTo(width, bottom + 0.5);
    ctx.stroke();

    ctx.fillStyle = muted;
    ctx.font = fontFor(9);
    ctx.fillText('0', 1, height - 1);
    const label = axisMax >= 1000 ? `${axisMax / 1000} Gbps` : `${axisMax} Mbps`;
    ctx.fillText(label, Math.max(0, width - ctx.measureText(label).width - 1), height - 1);

    if (!numeric.length) return;

    const q1 = percentile(numeric, 25);
    const q2 = percentile(numeric, 50);
    const q3 = percentile(numeric, 75);
    const midY = top + innerHeight / 2;

    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(xAt(Math.min.apply(null, numeric)), midY);
    ctx.lineTo(xAt(Math.max.apply(null, numeric)), midY);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = color;
    ctx.fillRect(xAt(q1), midY - 5, Math.max(2, xAt(q3) - xAt(q1)), 10);
    ctx.strokeStyle = themeColor('--card', '#ffffff');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xAt(q2), midY - 8);
    ctx.lineTo(xAt(q2), midY + 8);
    ctx.stroke();

    numeric.forEach((value, index) => {
      const wobble = Math.sin(index * 12.9898) * 0.5 + Math.sin(index * 4.1414) * 0.5;
      const y = midY + wobble * Math.max(3, innerHeight / 2 - 4);
      ctx.beginPath();
      ctx.arc(xAt(value), y, 1.9, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function drawLatencyPlot(canvas, values, color) {
    const prepared = prepCanvas(canvas);
    if (!prepared) return;
    const { ctx, width, height } = prepared;
    const line = themeColor('--line', '#d4d4d4');
    const muted = themeColor('--muted', '#737373');
    const numeric = (values || []).filter((value) => Number.isFinite(value));
    const top = 8;
    const bottom = height - 12;
    const innerHeight = Math.max(1, bottom - top);
    const axisMax = Math.max(1, Math.max.apply(null, numeric.concat([1])) * 1.1);
    const xAt = (value) => Math.min(1, Math.max(0, value / axisMax)) * width;

    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, bottom + 0.5);
    ctx.lineTo(width, bottom + 0.5);
    ctx.stroke();

    ctx.fillStyle = muted;
    ctx.font = fontFor(9);
    ctx.fillText('0 ms', 1, height - 1);
    const label = `${Math.round(axisMax)} ms`;
    ctx.fillText(label, Math.max(0, width - ctx.measureText(label).width - 1), height - 1);

    if (!numeric.length) return;

    const med = median(numeric);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(xAt(med), top);
    ctx.lineTo(xAt(med), bottom);
    ctx.stroke();
    ctx.globalAlpha = 1;

    numeric.forEach((value, index) => {
      const wobble = Math.sin(index * 7.31) * 0.5 + Math.sin(index * 2.17) * 0.5;
      const y = top + innerHeight / 2 + wobble * Math.max(3, innerHeight / 2 - 4);
      ctx.beginPath();
      ctx.arc(xAt(value), y, 1.9, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function renderStages(container, stages, emptyText, direction) {
    if (!container) return;
    if (!stages.length) {
      container.innerHTML = `<p class="measure-empty">${emptyText}</p>`;
      return;
    }
    const color = direction === 'up' ? UP_COLOR : DOWN_COLOR;
    container.innerHTML = stages.map((stage, index) => {
      const samples = stage.samples || [];
      const centre = samples.length ? median(samples) : stage.mbps;
      const loaded = stage.loaded === null || stage.loaded === undefined ? '-' : `${stage.loaded.toFixed(0)} ms`;
      const note = stage.partial ? ' <span class="stage-note">partial</span>' : '';
      return '<article class="measure-card">'
        + `<header class="measure-head"><span class="measure-name">${formatBytes(stage.size)} ${direction === 'up' ? 'upload' : 'download'}${note}</span>`
        + `<span class="measure-count">${samples.length} samples</span></header>`
        + `<canvas class="measure-canvas" data-index="${index}" aria-hidden="true"></canvas>`
        + `<footer class="measure-foot"><span>median ${centre.toFixed(1)} Mbps</span><span>${loaded}</span></footer>`
        + '</article>';
    }).join('');
    container.querySelectorAll('canvas').forEach((canvas) => {
      const stage = stages[Number(canvas.getAttribute('data-index'))];
      drawPointCloud(canvas, stage.samples || [], color);
    });
  }

  function renderLatencyCards(unloaded, loadedDown, loadedUp) {
    if (!el.latencyCards) return;
    const groups = [
      { name: 'Unloaded latency', values: unloaded || [], color: LAT_COLOR },
      { name: 'Latency during download', values: loadedDown || [], color: DOWN_COLOR },
      { name: 'Latency during upload', values: loadedUp || [], color: UP_COLOR },
    ];
    el.latencyCards.innerHTML = groups.map((group, index) => {
      const values = group.values.filter((value) => Number.isFinite(value));
      const med = values.length ? median(values) : null;
      const p95 = values.length ? percentile(values, 95) : null;
      return '<article class="measure-card">'
        + `<header class="measure-head"><span class="measure-name">${group.name}</span>`
        + `<span class="measure-count">${values.length} probes</span></header>`
        + `<canvas class="measure-canvas" data-latency="${index}" aria-hidden="true"></canvas>`
        + `<footer class="measure-foot"><span>median ${med === null ? '-' : `${med.toFixed(1)} ms`}</span>`
        + `<span>${p95 === null ? '' : `p95 ${p95.toFixed(1)} ms`}</span></footer>`
        + '</article>';
    }).join('');
    el.latencyCards.querySelectorAll('canvas').forEach((canvas) => {
      const group = groups[Number(canvas.getAttribute('data-latency'))];
      drawLatencyPlot(canvas, group.values, group.color);
    });
  }

  /** Theme switches change the CSS variables the plots read, so redraw them. */
  function redrawAllCharts() {
    drawHero('down');
    drawHero('up');
    renderStages(el.stageDown, lastResults.down, 'Download not measured yet', 'down');
    renderStages(el.stageUp, lastResults.up, 'Upload not measured yet', 'up');
    renderLatencyCards(lastResults.latency.unloaded, lastResults.latency.down, lastResults.latency.up);
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
      values: samples.slice(),
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
    const streams = Math.max(1, Math.min(streamsFor(size), calibration.cap || MAX_STREAMS));
    const slice = Math.floor(size / streams);
    const loaded = [];
    const samples = [];
    let bytes = 0;
    let sampledBytes = 0;
    let sampledAt = performance.now();

    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), budgetFor(size));
    const relayAbort = () => budget.abort();
    signal.addEventListener('abort', relayAbort, { once: true });

    const stopProbes = watchLoadedLatency(budget.signal, loaded);
    const started = performance.now();
    const sampler = setInterval(() => {
      const now = performance.now();
      const span = Math.max(now - sampledAt, 1);
      const moved = bytes - sampledBytes;
      sampledBytes = bytes;
      sampledAt = now;
      const mbps = (moved * 8) / (span / 1000) / 1e6;
      if (mbps > 0) {
        samples.push(mbps);
        pushHeroSample(direction, mbps);
      }
    }, 140);
    const tasks = [];
    for (let index = 0; index < streams; index += 1) {
      const amount = index === streams - 1 ? size - slice * (streams - 1) : slice;
      const onBytes = (count) => {
        bytes += count;
        if (onProgress) onProgress(Math.min(1, bytes / size));
      };
      tasks.push(direction === 'down'
        ? downloadAmount(budget.signal, amount, onBytes)
        : uploadAmount(budget.signal, amount, onBytes, streaming));
    }

    let partial = false;
    try {
      await Promise.all(tasks);
    } catch (err) {
      if (signal.aborted) throw abortError();
      if (!budget.signal.aborted) throw err;
      partial = true;
    } finally {
      clearTimeout(timer);
      clearInterval(sampler);
      signal.removeEventListener('abort', relayAbort);
      stopProbes();
    }

    const elapsed = performance.now() - started;
    if (bytes === 0) {
      throw new Error(`the ${formatBytes(size)} stage moved no data`);
    }
    const mbps = (bytes * 8) / (Math.max(elapsed, 1) / 1000) / 1e6;
    if (!samples.length) {
      samples.push(mbps);
      pushHeroSample(direction, mbps);
    }
    return {
      size,
      bytes,
      ms: elapsed,
      mbps,
      samples,
      loaded: median(loaded),
      loadedValues: loaded.slice(),
      partial,
    };
  }

  async function runStages(signal, direction, streaming, onProgress, onStage) {
    if (direction === 'down') calibration.cap = null;
    for (let index = 0; index < CFG.stages.length; index += 1) {
      const size = CFG.stages[index];
      const base = index / CFG.stages.length;
      const span = 1 / CFG.stages.length;
      const label = direction === 'down' ? 'Download' : 'Upload';
      if (direction === 'down' && size >= 4 * 1024 * 1024 && calibration.cap === null) {
        setStatus('Checking how many streams this link wants');
        await calibrateStreams(signal);
      }
      setStatus(`${label} ${formatBytes(size)}`);
      const result = await runStage(signal, direction, size, streaming, (fraction) => onProgress(base + span * fraction));
      onStage(result);
      onProgress(base + span);
    }
  }

  /** Headline comes from the fastest stage: the small ones are latency bound and
   *  understate the link, so the peak is what the connection can actually do. */
  function bestStage(stages) {
    return stages.reduce((best, stage) => (!best || stage.mbps > best.mbps ? stage : best), null);
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
    charts.down.series.length = 0;
    charts.up.series.length = 0;
    lastResults.down = [];
    lastResults.up = [];
    lastResults.latency = { unloaded: [], down: [], up: [] };
    renderStages(el.stageDown, [], 'Download not measured yet', 'down');
    renderStages(el.stageUp, [], 'Upload not measured yet', 'up');
    renderLatencyCards([], [], []);
    drawHero('down');
    drawHero('up');
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
    const loadedDownAll = [];
    const loadedUpAll = [];

    try {
      phaseProgress('connect', 0.2);
      const meta = await fetchMeta(signal);
      renderMeta(meta);
      state.base = await pickOrigin(meta, signal);
      startChartLoop();
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
      lastResults.latency.unloaded = latency.values || [];
      renderLatencyCards(lastResults.latency.unloaded, lastResults.latency.down, lastResults.latency.up);
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
          if (stage.loadedValues && stage.loadedValues.length) loadedDownAll.push.apply(loadedDownAll, stage.loadedValues);
          const best = bestStage(downloadStages);
          metrics.down = best ? best.mbps : metrics.down;
          metrics.loadedDown = best ? best.loaded : metrics.loadedDown;
          setMetric(el.down, metrics.down, 'Mbps');
          if (el.down) el.down.title = 'best measured stage, with loaded latency during it';
          lastResults.down = downloadStages.slice();
          lastResults.latency.down = loadedDownAll.slice();
          renderStages(el.stageDown, downloadStages, 'Download not measured yet', 'down');
          renderLatencyCards(lastResults.latency.unloaded, loadedDownAll, loadedUpAll);
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
          if (stage.loadedValues && stage.loadedValues.length) loadedUpAll.push.apply(loadedUpAll, stage.loadedValues);
          const best = bestStage(uploadStages);
          metrics.up = best ? best.mbps : metrics.up;
          metrics.loadedUp = best ? best.loaded : metrics.loadedUp;
          setMetric(el.up, metrics.up, 'Mbps');
          if (el.up) el.up.title = 'best measured stage, with loaded latency during it';
          lastResults.up = uploadStages.slice();
          lastResults.latency.up = loadedUpAll.slice();
          renderStages(el.stageUp, uploadStages, 'Upload not measured yet', 'up');
          renderLatencyCards(lastResults.latency.unloaded, loadedDownAll, loadedUpAll);
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
      stopChartLoop();
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
