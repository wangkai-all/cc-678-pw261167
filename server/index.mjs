import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runCollection } from '../collector/index.mjs';
import { VisibleChart } from '../collector/page.mjs';
import { utcLabel } from '../src/shared/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');
const PORT = Number(process.env.PORT || 4173);

const app = express();
app.use(express.json({ limit: '1mb' }));

async function newBrowser() {
  return chromium.launch({ headless: true });
}

async function newChartPage(browser, origin) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(`${origin}/chart.html`, { waitUntil: 'networkidle' });
  return { context, page };
}

const jobs = new Map();

app.post('/api/jobs', async (req, res) => {
  const wanted = req.body?.options?.switches ?? {};
  const request = {
    series: Array.isArray(req.body?.series) ? req.body.series.map(String) : [],
    window: req.body?.window ?? { preset: 'all' },
    options: {
      isolate: req.body?.options?.isolate !== false,
      switches: {
        dense: wanted.dense === true,
        lag: wanted.lag === true,
        freeze: wanted.freeze === true,
      },
    },
  };
  if (!request.series.length) {
    res.status(400).json({ error: '请至少选择一个系列' });
    return;
  }
  if (request.window?.preset === 'custom') {
    if (!request.window.fromISO || !request.window.toISO) {
      res.status(400).json({ error: '自定义范围需要开始和结束日期' });
      return;
    }
    if (request.window.fromISO > request.window.toISO) {
      res.status(400).json({ error: '开始日期不能晚于结束日期' });
      return;
    }
  }

  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    id,
    request,
    createdAt: Date.now(),
    events: [],
    clients: new Set(),
    state: 'running',
    browser: null,
    result: null,
    error: null,
    log: [],
  };
  jobs.set(id, job);

  const send = (event) => {
    const payload = { ...event, at: Date.now() };
    job.events.push(payload);
    if (job.events.length > 5000) job.events.splice(0, job.events.length - 5000);
    for (const client of job.clients) {
      client.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  let paused = false;
  const waiters = [];
  const signal = {
    get aborted() {
      return job.state === 'stopped';
    },
    reason: 'stopped',
    paused: () => paused,
    waitResume: () =>
      new Promise((resolve) => {
        if (!paused) resolve();
        else waiters.push(resolve);
      }),
  };
  job.pause = () => {
    if (job.state !== 'running') return;
    paused = true;
    job.state = 'paused';
    send({ type: 'state', state: 'paused' });
  };
  job.resume = () => {
    if (job.state !== 'paused') return;
    paused = false;
    job.state = 'running';
    while (waiters.length) waiters.shift()();
    send({ type: 'state', state: 'running' });
  };
  job.stop = () => {
    job.state = 'stopped';
    paused = false;
    while (waiters.length) waiters.shift()();
    send({ type: 'state', state: 'stopped' });
  };

  res.status(202).json({ id });

  (async () => {
    const origin = `http://127.0.0.1:${PORT}`;
    let browser;
    try {
      browser = await newBrowser();
      job.browser = browser;
      const { context, page } = await newChartPage(browser, origin);
      try {
        const result = await runCollection({
          page,
          request: { series: request.series, window: request.window },
          emit: (event) => {
            if (event.type === 'log') job.log.push(event);
            send(event);
          },
          signal,
          log: (message) => send({ type: 'log', level: 'info', message }),
        });
        job.result = result;
        job.state = 'done';
        send({ type: 'state', state: 'done' });
      } finally {
        await context.close().catch(() => {});
      }
    } catch (err) {
      if (err?.kind === 'stopped' || job.state === 'stopped') {
        job.state = 'stopped';
        send({ type: 'state', state: 'stopped' });
      } else {
        job.state = 'error';
        job.error = err?.message ?? String(err);
        send({ type: 'error', message: job.error });
        send({ type: 'state', state: 'error' });
      }
    } finally {
      await browser?.close().catch(() => {});
      job.browser = null;
      for (const client of job.clients) client.end();
      job.clients.clear();
    }
  })().catch((err) => {
    job.state = 'error';
    job.error = String(err);
    send({ type: 'error', message: job.error });
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  return res.json({
    id: job.id,
    state: job.state,
    request: job.request,
    result: job.result,
    error: job.error,
    events: job.events,
  });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 1000\n\n');
  for (const event of job.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (job.state === 'done' || job.state === 'error' || job.state === 'stopped') {
    res.end();
    return;
  }
  job.clients.add(res);
  req.on('close', () => job.clients.delete(res));
});

app.post('/api/jobs/:id/pause', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  job.pause?.();
  return res.json({ ok: true, state: job.state });
});

app.post('/api/jobs/:id/resume', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  job.resume?.();
  return res.json({ ok: true, state: job.state });
});

app.post('/api/jobs/:id/stop', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  job.stop?.();
  return res.json({ ok: true, state: job.state });
});

/* ---------- verification against the same original chart ---------- */

let verifyBrowser = null;
let verifyPage = null;

async function ensureVerifier(origin) {
  if (verifyPage && !verifyPage.isClosed()) return verifyPage;
  verifyBrowser = await newBrowser();
  const { page } = await newChartPage(verifyBrowser, origin);
  verifyPage = page;
  return page;
}

app.post('/api/verify', async (req, res) => {
  const { seriesName, ms } = req.body ?? {};
  if (!seriesName || !Number.isFinite(Number(ms))) {
    return res.status(400).json({ error: '需要 seriesName 与 ms' });
  }
  const targetMs = Number(ms);
  const origin = `http://127.0.0.1:${PORT}`;
  let page;
  try {
    page = await ensureVerifier(origin);
    const chart = new VisibleChart(page, { log: () => {} });
    await chart.open();
    await chart.resetZoom();
    const restore = await chart.isolateSeries(seriesName);
    let shot;
    let tip = null;
    let zoomed = false;
    try {
      // Zoom tightly around the point so a reader can see it on the original chart.
      const span = 3 * 86_400_000;
      const from = Math.max(chart.coverage.fromMs, targetMs - span / 2);
      const to = Math.min(chart.coverage.toMs, targetMs + span / 2);
      await chart.zoomTo(from, to, { steps: 5 });
      zoomed = true;
      await chart.ensureTimeVisible(targetMs);
      const got = await chart.hoverTime(targetMs, { timeout: 2600 });
      tip = got.tip;
      if (!tip || tip.ms !== targetMs) {
        await chart.resetZoom();
        zoomed = false;
        await chart.ensureTimeVisible(targetMs);
        const retry = await chart.hoverTime(targetMs, { timeout: 2600 });
        tip = retry.tip ?? tip;
      }
      const buffer = await page.screenshot({ scale: 'css', fullPage: false });
      shot = buffer.toString('base64');
    } finally {
      await restore().catch(() => {});
    }
    return res.json({
      ok: true,
      zoomed,
      screenshot: shot,
      tooltip: tip
        ? {
            time: tip.time,
            matched: tip.ms === targetMs,
            rows: tip.raw.rows,
          }
        : null,
    });
  } catch (err) {
    // Recycle the verifier so the next request starts clean.
    await verifyPage?.context().close().catch(() => {});
    verifyPage = null;
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.get('/api/meta', async (_req, res) => {
  const origin = `http://127.0.0.1:${PORT}`;
  try {
    const page = await ensureVerifier(origin);
    const series = await page.$$eval('#chart-shell .legend .legend-item', (nodes) =>
      nodes.map((n) => ({
        name: n.querySelector('.legend-name')?.textContent?.trim() ?? '',
        cadence: n.querySelector('.legend-cadence')?.textContent?.trim() ?? '',
        enabled: n.getAttribute('aria-pressed') === 'true',
      })),
    );
    const range = await page.locator('.chart-range').first().textContent();
    return res.json({ series, range, origin });
  } catch (err) {
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.use(express.static(DIST, { index: false, extensions: ['html'] }));
app.get('/', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
app.get('/chart', (_req, res) => res.sendFile(path.join(DIST, 'chart.html')));
app.use((_req, res) => res.status(404).send('Not found'));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`采集操作台 http://127.0.0.1:${PORT}/`);
  console.log(`演示图表   http://127.0.0.1:${PORT}/chart.html  (${utcLabel(Date.now())})`);
});

process.on('SIGINT', async () => {
  await verifyBrowser?.close().catch(() => {});
  process.exit(0);
});
