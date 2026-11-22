/**
 * End-to-end accuracy tests.
 *
 * These import src/demo/data.js ONLY to compute the expected answer. The
 * collector itself (collector/*.mjs) never imports it — it reads the page's
 * visible legend, range text and tooltip DOM, nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCollection } from '../collector/index.mjs';
import { VisibleChart } from '../collector/page.mjs';
import { groundTruth } from '../src/demo/data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');

let server;
let origin;
let browser;

test.before(async () => {
  const app = express();
  app.use(express.static(DIST, { index: false, extensions: ['html'] }));
  app.get('/', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
  app.get('/chart', (_req, res) => res.sendFile(path.join(DIST, 'chart.html')));
  server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

async function newPage({ switchIds = [], viewport = { width: 1280, height: 900 }, dpr = 1 } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr, locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(`${origin}/chart.html`, { waitUntil: 'networkidle' });
  for (const id of switchIds) await page.click(id);
  if (switchIds.length) await page.waitForTimeout(400);
  return { ctx, page };
}

function compare(result, { dense = false, names, fromISO, toISO }) {
  const truth = groundTruth({
    dense,
    fromMs: Date.parse(`${fromISO}T00:00:00Z`),
    toMs: Date.parse(`${toISO}T23:59:59Z`),
  });
  const wanted = (row) => names.includes(row.seriesName);
  const got = new Set(result.confirmed.map((r) => `${r.seriesName}|${r.ms}|${r.value}|${r.status}`));
  const exp = new Set(
    truth.confirmed
      .filter(wanted)
      .map((t) => `${t.seriesName}|${t.ms}|${t.value}|${t.kind === 'zero' ? 'zero' : 'value'}`),
  );
  const gotMissing = new Set(result.missing.map((r) => `${r.seriesName}|${r.ms}`));
  const expMissing = new Set(truth.missing.filter(wanted).map((t) => `${t.seriesName}|${t.ms}`));
  assert.deepEqual([...got].filter((x) => !exp.has(x)), [], '读数中出现了页面上没有的值');
  assert.deepEqual([...exp].filter((x) => !got.has(x)), [], '漏采了页面上存在的值');
  assert.deepEqual([...gotMissing].filter((x) => !expMissing.has(x)), [], '把有值的点判成了缺失');
  assert.deepEqual([...expMissing].filter((x) => !gotMissing.has(x)), [], '漏报了缺失点');
  assert.equal(result.unconfirmed.length, 0, '不应有无法确认的点');
}

test('每日系列：精确时间、精确值、缺失与零值', { timeout: 180_000 }, async () => {
  const { ctx, page } = await newPage();
  try {
    const names = ['边缘 A 区', '边缘 C 区'];
    const result = await runCollection({
      page,
      request: { series: names, window: { preset: 'custom', fromISO: '2024-04-05', toISO: '2024-05-24' } },
    });
    compare(result, { names, fromISO: '2024-04-05', toISO: '2024-05-24' });
    // zero readings must be stored as zero, not as missing or as "no record"
    const zeros = result.confirmed.filter((r) => r.status === 'zero');
    assert.ok(zeros.length >= 1, '应采集到至少一个真实零值');
    assert.ok(zeros.every((r) => r.value === 0));
    // the blackout day has no point at all for the daily series
    const blackout = Date.UTC(2024, 4, 12);
    assert.ok(result.missing.some((r) => r.ms === blackout && r.seriesName === '边缘 A 区'));
  } finally {
    await ctx.close();
  }
});

test('两日节奏系列：按图例文字排程，不按窗口起点漂移', { timeout: 120_000 }, async () => {
  const { ctx, page } = await newPage();
  try {
    const names = ['回源中心'];
    const result = await runCollection({
      page,
      request: { series: names, window: { preset: 'custom', fromISO: '2024-03-03', toISO: '2024-03-19' } },
    });
    compare(result, { names, fromISO: '2024-03-03', toISO: '2024-03-19' });
    assert.ok(result.confirmed.every((r) => new Date(r.ms).getUTCHours() === 12), '12:00 UTC 的偏移必须被遵守');
    assert.ok(result.confirmed.every((r) => new Date(r.ms).getUTCDate() % 2 === 1), '两天一次的节奏必须被遵守');
  } finally {
    await ctx.close();
  }
});

test('密集点开关：识别分钟级额外采样', { timeout: 180_000 }, async () => {
  const { ctx, page } = await newPage({ switchIds: ['#demo-dense'] });
  try {
    const names = ['边缘 A 区', '边缘 B 区'];
    const result = await runCollection({
      page,
      request: { series: names, window: { preset: 'custom', fromISO: '2024-02-14', toISO: '2024-02-16' } },
    });
    compare(result, { dense: true, names, fromISO: '2024-02-14', toISO: '2024-02-16' });
    const intraday = result.confirmed.filter((r) => new Date(r.ms).getUTCHours() % 2 === 0 && new Date(r.ms).getUTCHours() !== 0);
    assert.ok(intraday.length > 0, '应读到页面说明里的 2 小时额外采样');
  } finally {
    await ctx.close();
  }
});

test('窄屏 + 2x DPR：不依赖固定像素坐标', { timeout: 180_000 }, async () => {
  const { ctx, page } = await newPage({ viewport: { width: 860, height: 780 }, dpr: 2 });
  try {
    for (let i = 0; i < 2; i++) await page.click('#demo-width');
    await page.waitForTimeout(300);
    const names = ['边缘 A 区', '回源中心'];
    const result = await runCollection({
      page,
      request: { series: names, window: { preset: 'custom', fromISO: '2024-02-20', toISO: '2024-02-26' } },
    });
    compare(result, { names, fromISO: '2024-02-20', toISO: '2024-02-26' });
  } finally {
    await ctx.close();
  }
});

test('延迟提示：等提示给出目标时刻后才算成功', { timeout: 120_000 }, async () => {
  const { ctx, page } = await newPage({ switchIds: ['#demo-lag'] });
  try {
    const names = ['边缘 B 区'];
    const result = await runCollection({
      page,
      request: { series: names, window: { preset: 'custom', fromISO: '2024-01-08', toISO: '2024-01-12' } },
    });
    compare(result, { names, fromISO: '2024-01-08', toISO: '2024-01-12' });
    assert.ok(result.confirmed.every((r) => r.source === 'tooltip'));
  } finally {
    await ctx.close();
  }
});

test('卡住提示的故障演示：宁可不确认，也不把上一条读数算成目标', { timeout: 180_000 }, async () => {
  const { ctx, page } = await newPage({ switchIds: ['#demo-freeze'] });
  try {
    const names = ['边缘 A 区'];
    const fromISO = '2024-01-03';
    const toISO = '2024-01-07';
    const result = await runCollection({
      page,
      request: { series: names, window: { preset: 'custom', fromISO, toISO } },
    });
    const truth = groundTruth({ fromMs: Date.parse(`${fromISO}T00:00:00Z`), toMs: Date.parse(`${toISO}T23:59:59Z`) });
    const expected = new Map(truth.confirmed.filter((t) => t.seriesName === '边缘 A 区').map((t) => [t.ms, t.value]));
    // No confirmed row may carry the value of a different (stale) card.
    for (const row of result.confirmed) {
      assert.equal(expected.get(row.ms), row.value, `卡住的提示被当成了 ${row.time}`);
    }
    // Anything not confirmed must be explained as a tooltip fault, not silently dropped.
    for (const row of [...result.missing, ...result.unconfirmed]) {
      assert.ok(row.reason && row.reason.length > 0, `${row.time} 没有原因`);
    }
    assert.ok(result.confirmed.length >= 1);
  } finally {
    await ctx.close();
  }
});

test('卡住的提示卡面：不会把旧卡面当作新目标', { timeout: 120_000 }, async () => {
  const { ctx, page } = await newPage({ switchIds: ['#demo-freeze'] });
  try {
    const chart = new VisibleChart(page);
    await chart.open();
    const restore = await chart.isolateSeries('边缘 B 区');
    // Put a card on screen for Jan 1, then ask for Jan 2 without any gesture
    // that would legitimately dismiss the card.
    const jan1 = Date.UTC(2024, 0, 1);
    const jan2 = Date.UTC(2024, 0, 2);
    const first = await chart.hoverTime(jan1, { timeout: 2200 });
    assert.equal(first.tip?.ms, jan1);
    const second = await chart.hoverTime(jan2, { timeout: 2200 });
    assert.notEqual(second.tip?.values?.['边缘 B 区'], 0, 'sanity');
    assert.ok(
      second.tip == null || second.tip.ms !== jan2,
      `旧卡面被当成了 ${new Date(jan2).toISOString()} 的读数（${second.tip?.time}）`,
    );
    await restore();
  } finally {
    await ctx.close();
  }
});
