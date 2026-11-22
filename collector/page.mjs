/**
 * Visible-page driver.
 *
 * Every read and every action in this class goes through what a person could
 * do on the chart page: click a legend button, drag to zoom, move the pointer
 * and read the tooltip / visible range text. It never touches app globals,
 * React state, data attributes or network endpoints.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function parseUtcText(text) {
  const m = String(text || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

export class VisibleChart {
  constructor(page, { log = () => {}, pauseCheck = async () => {} } = {}) {
    this.page = page;
    this.log = log;
    this.pauseCheck = pauseCheck;
    this.box = null;
    this.geom = null;
    this.series = [];
    this.coverage = null;
    this.samplingText = '';
    this.switches = {};
  }

  async open() {
    await this.page.waitForSelector('#chart-canvas', { state: 'visible', timeout: 15_000 });
    await this.page.waitForFunction(() => {
      const c = document.querySelector('#chart-canvas');
      const r = c?.getBoundingClientRect();
      return r && r.width > 240 && r.height > 180;
    }, null, { timeout: 10_000 });
    await this.page.evaluate(() => {
      document.querySelector('#chart-canvas')?.scrollIntoView({ block: 'center', inline: 'center' });
    });
    await sleep(120);
    await this.readSeries();
    await this.readSwitches();
    await this.readCoverage();
    await this.canvasBox();
    await this.calibrate();
  }

  async readSeries() {
    this.series = await this.page.$$eval('#chart-shell .legend .legend-item', (nodes) =>
      nodes.map((n) => ({
        name: n.querySelector('.legend-name')?.textContent?.trim() ?? '',
        cadence: n.querySelector('.legend-cadence')?.textContent?.trim() ?? '',
        enabled: n.getAttribute('aria-pressed') === 'true',
      })),
    );
    if (!this.series.length) throw new Error('页面上读不到图例');
    this.samplingText = await this.page.locator('#chart-sampling').textContent().catch(() => '');
    return this.series;
  }

  async readSwitches() {
    this.switches = await this.page.evaluate(() => {
      const dense = document.querySelector('#demo-dense');
      const lag = document.querySelector('#demo-lag');
      const freeze = document.querySelector('#demo-freeze');
      return {
        dense: dense?.getAttribute('aria-pressed') === 'true',
        lag: lag?.getAttribute('aria-pressed') === 'true',
        freeze: freeze?.getAttribute('aria-pressed') === 'true',
        denseLabel: dense?.textContent?.trim() ?? '',
        lagLabel: lag?.textContent?.trim() ?? '',
      };
    });
    return this.switches;
  }

  /** Click a demo switch only when it is not already in the requested state. */
  async setDemoSwitch(id, on) {
    const el = this.page.locator(`#${id}`);
    if (!(await el.count())) return false;
    const pressed = (await el.getAttribute('aria-pressed')) === 'true';
    if (pressed === Boolean(on)) return false;
    await el.click();
    await sleep(260);
    await this.readSeries();
    this.log(`演示开关「${(await el.textContent())?.trim() ?? id}」已切换`);
    return true;
  }

  /** Put the page's visible demo switches into the requested state. */
  async applyDemoSwitches({ dense, lag, freeze } = {}) {
    let changed = false;
    if (dense != null) changed = (await this.setDemoSwitch('demo-dense', dense)) || changed;
    if (lag != null) changed = (await this.setDemoSwitch('demo-lag', lag)) || changed;
    if (freeze != null) changed = (await this.setDemoSwitch('demo-freeze', freeze)) || changed;
    if (changed) {
      await this.readSwitches();
      await this.readCoverage();
      await this.calibrate({ force: true });
    }
    return changed;
  }

  async getSeries(name) {
    await this.readSeries();
    const s = this.series.find((x) => x.name === name);
    if (!s) throw new Error(`图例中找不到系列「${name}」`);
    return s;
  }

  async setSeriesEnabled(name, enabled) {
    const s = await this.getSeries(name);
    if (s.enabled === enabled) return false;
    await this.page.locator('#chart-shell .legend .legend-item', {
      has: this.page.locator('.legend-name', { hasText: name }),
    }).first().click();
    await sleep(30);
    return true;
  }

  /**
   * Show exactly one series, using only the legend buttons. Overlapping points
   * and cross-series tooltip hits are only disambiguated this way. Returns a
   * restore() that puts every legend button back the way it was.
   */
  async isolateSeries(name) {
    await this.readSeries();
    const before = new Map(this.series.map((s) => [s.name, s.enabled]));
    if (!before.has(name)) throw new Error(`图例中找不到系列「${name}」`);
    for (const s of this.series) {
      const want = s.name === name;
      if (s.enabled !== want) {
        await this.setSeriesEnabled(s.name, want);
        this.log(`图例开关：${want ? '开启' : '关闭'}「${s.name}」`);
      }
    }
    return async () => {
      await this.readSeries();
      for (const s of this.series) {
        const was = before.get(s.name);
        if (was != null && s.enabled !== was) {
          await this.setSeriesEnabled(s.name, was);
          this.log(`图例开关：恢复${was ? '开启' : '关闭'}「${s.name}」`);
        }
      }
    };
  }

  async readCoverage() {
    const text = await this.page.locator('.chart-range').first().textContent();
    const m = text.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?) UTC\s*→\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?) UTC/);
    if (!m) throw new Error(`读不到可见范围文本：${text}`);
    this.coverage = {
      fromMs: parseUtcText(`${m[1]} ${m[2]}`),
      toMs: parseUtcText(`${m[3]} ${m[4]}`),
      full: text.startsWith('全量范围'),
      text,
    };
    if (this.coverage.full) this.fullCoverage = { ...this.coverage };
    return this.coverage;
  }

  async canvasBox() {
    const box = await this.page.locator('#chart-canvas').boundingBox();
    if (!box) throw new Error('画布不可见');
    this.box = { x: box.x, y: box.y, width: box.width, height: box.height };
    return this.box;
  }

  /**
   * A real pointermove only fires when the coordinate changes. If a target maps
   * to the pixel the mouse already sits on, nudge by one pixel so the page
   * re-runs its hit test (this is exactly what a person would do).
   */
  async moveTo(x, y = null) {
    const box = await this.canvasBox();
    const yy = y ?? Math.round(box.height * 0.45);
    let px = Math.round(x);
    const py = Math.round(yy);
    const key = `${px},${py}`;
    if (this.lastMouse === key) {
      px = px <= this.geom?.left ? px + 1 : px - 1;
    }
    this.lastMouse = `${px},${py}`;
    await this.page.mouse.move(box.x + px, box.y + py);
  }

  async readTooltip() {
    return this.page.evaluate(() => {
      const host = document.querySelector('.chart-tooltip');
      if (!host || host.hidden) return { state: 'hidden' };
      if (host.querySelector('.tt-pending')) return { state: 'pending' };
      const card = host.querySelector('.tt-card');
      if (!card) return { state: 'hidden' };
      const time = card.querySelector('.tt-time')?.textContent?.trim() ?? '';
      const rows = [...card.querySelectorAll('.tt-row')].map((r) => ({
        name: r.querySelector('.tt-name')?.textContent?.trim() ?? '',
        value: r.querySelector('.tt-val')?.textContent?.trim() ?? '',
      }));
      return { state: 'shown', time, rows };
    });
  }

  parseTooltip(raw) {
    if (!raw || raw.state !== 'shown') return null;
    const label = String(raw.time || '').split('·')[0].trim();
    const ms = parseUtcText(label);
    if (ms == null) return null;
    const values = {};
    for (const row of raw.rows) {
      if (!row.name) continue;
      values[row.name] = row.value === '无记录' ? null : Number(row.value);
    }
    return { ms, time: label, values, raw };
  }

  /** Read the settled tooltip (waiting out the delayed-tooltip demo). */
  async settledTooltip({ timeout = 1200 } = {}) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeout) {
      const raw = await this.readTooltip();
      if (raw.state === 'shown') {
        last = this.parseTooltip(raw);
        // A real card is final; the delayed demo shows a pending card first.
        if (last) return last;
      }
      await sleep(20);
    }
    return last;
  }

  /**
   * Move the pointer one screenshot-pixel at a time across the target and read
   * the settled tooltip after every move. Positions are recorded so the log
   * shows exactly what the page answered around a suspicious time.
   */
  async scanAround(ms, { radiusPx = 200, stepPx = 4 } = {}) {
    const g = this.geom;
    if (!g) throw new Error('未校准绘图区');
    const center = Math.round(g.xOf(ms));
    const out = [];
    for (let dx = -radiusPx; dx <= radiusPx; dx += stepPx) {
      const x = center + dx;
      if (x < g.left || x > g.right) continue;
      await this.moveTo(x);
      const tip = await this.settledTooltip({ timeout: 700 });
      out.push({ x, dx, tip });
    }
    return out;
  }

  /** Wait until the tooltip reports `expectMs` (or until timeout). */
  async hoverAt(x, { expectMs = null, rejectMs = null, timeout = 2600 } = {}) {
    await this.moveTo(x);
    const start = Date.now();
    let last = null;
    let pendingSeen = false;
    let stable = 0;
    while (Date.now() - start < timeout) {
      await this.pauseCheck();
      const raw = await this.readTooltip();
      if (raw.state === 'pending') {
        pendingSeen = true;
        stable = 0;
      }
      const tip = this.parseTooltip(raw);
      if (tip) {
        if (last && last.ms === tip.ms) stable++;
        else stable = 0;
        last = tip;
        if (expectMs != null && tip.ms === expectMs) return { tip, x, pendingSeen };
        if (expectMs == null && (rejectMs == null || tip.ms !== rejectMs)) return { tip, x, pendingSeen };
        // A shown card only appears once the page settled on this position;
        // three identical reads mean this is its answer, not a transition.
        if (!pendingSeen && stable >= 3) return { tip, x, pendingSeen };
      }
      await sleep(14);
    }
    return { tip: last, x, pendingSeen, timedOut: true };
  }

  /** Make sure `ms` is inside the visible range, re-zooming if needed. */
  async ensureTimeVisible(ms, { spanMs = 24 * HOUR_MS } = {}) {
    const cov = await this.readCoverage();
    const tol = 60_000;
    if (ms >= cov.fromMs + tol && ms <= cov.toMs - tol) return cov;
    const full = this.fullCoverage ?? cov;
    const from = Math.max(full.fromMs, ms - spanMs);
    const to = Math.min(full.toMs, ms + spanMs);
    return this.zoomTo(from, to, { steps: 5 });
  }

  /** Hover the pixel that the visible time axis maps `ms` to, with nudges. */
  async hoverTime(ms, { timeout = 2600 } = {}) {
    const g = this.geom;
    if (!g) throw new Error('未校准绘图区');
    if (ms < g.fromMs - 60_000 || ms > g.toMs + 60_000) {
      throw new Error(`目标时刻不在当前可见范围（${this.coverage?.text ?? ''}）`);
    }
    const x0 = g.xOf(ms);
    const first = await this.hoverAt(x0, { expectMs: ms, timeout });
    if (first.tip?.ms === ms) return first;
    // Search both sides around the time-axes position; collisions on one pixel
    // are usually resolved a few pixels away.
    const pxPerMs = (g.right - g.left) / Math.max(1, g.toMs - g.fromMs);
    const seen = first.tip?.ms ?? null;
    const bias = seen == null ? 0 : seen < ms ? 1 : -1;
    const step = Math.max(2, Math.min(40, Math.abs(((seen ?? ms) - ms) * pxPerMs) || 2));
    const offsets = [];
    for (let i = 1; i <= 5; i++) {
      offsets.push((bias >= 0 ? 1 : -1) * step * i);
      offsets.push((bias >= 0 ? -1 : 1) * step * i);
    }
    for (const off of offsets) {
      const x = x0 + off;
      if (x < g.left || x > g.right) continue;
      const r = await this.hoverAt(x, { expectMs: ms, timeout: 900 });
      if (r.tip?.ms === ms) return r;
    }
    return first;
  }

  /**
   * Find the plot box by probing where the tooltip appears. The tooltip is the
   * only visible signal, so this works at any canvas size / DPR.
   */
  async calibrate({ force = false } = {}) {
    await this.readCoverage();
    const box = await this.canvasBox();
    const key = `${Math.round(box.width)}x${Math.round(box.height)}`;
    if (!force && this.plotPx && this.plotKey === key) {
      this.geom = this.makeGeom(this.plotPx.left, this.plotPx.right, this.coverage.fromMs, this.coverage.toMs);
      return this.geom;
    }
    const midY = Math.round(box.height * 0.5);
    const appears = async (x) => {
      await this.moveTo(x, midY);
      const start = Date.now();
      while (Date.now() - start < 1200) {
        const raw = await this.readTooltip();
        if (raw.state === 'shown') return true;
        await sleep(20);
      }
      return false;
    };
    if (!(await appears(Math.round(box.width / 2)))) {
      throw new Error('探针失败：画布中央没有提示');
    }
    let lo = 0;
    let hi = Math.round(box.width / 2);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await appears(mid)) hi = mid;
      else lo = mid;
    }
    const left = hi;
    lo = Math.round(box.width / 2);
    hi = Math.round(box.width) - 1;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await appears(mid)) lo = mid;
      else hi = mid;
    }
    const right = lo;
    this.plotPx = { left, right };
    this.plotKey = key;
    this.geom = this.makeGeom(left, right, this.coverage.fromMs, this.coverage.toMs);
    return this.geom;
  }

  makeGeom(left, right, fromMs, toMs) {
    const self = this;
    return {
      left,
      right,
      fromMs,
      toMs,
      xOf(ms) {
        return left + ((ms - fromMs) / (toMs - fromMs || 1)) * (right - left);
      },
      get box() {
        return self.box;
      },
    };
  }

  async resetZoom() {
    const cov = await this.readCoverage();
    if (cov.full) return cov;
    const box = await this.canvasBox();
    await this.page.mouse.dblclick(box.x + Math.round(box.width / 2), box.y + Math.round(box.height / 2));
    const start = Date.now();
    while (Date.now() - start < 3000) {
      const c = await this.readCoverage();
      if (c.full) {
        if (this.plotPx) this.geom = this.makeGeom(this.plotPx.left, this.plotPx.right, c.fromMs, c.toMs);
        this.coverage = c;
        return c;
      }
      await sleep(25);
    }
    throw new Error('重置缩放失败');
  }

  /**
   * Drag-select [fromMs, toMs]. A drag can only select whole pixels and only
   * inside the current view, so the selection is padded slightly and the
   * gesture is repeated until the requested times are actually inside the
   * visible range (minute precision is what the page displays).
   */
  async zoomTo(fromMs, toMs, { steps = 8, tolerance = 90_000 } = {}) {
    const full = this.fullCoverage;
    if (full) {
      fromMs = Math.max(fromMs, full.fromMs);
      toMs = Math.min(toMs, full.toMs);
    }
    if (toMs - fromMs < 6 * 60 * 60 * 1000) toMs = fromMs + 6 * 60 * 60 * 1000;
    // A drag can only zoom further in. If the requested window is not (mostly)
    // inside the current view, go back to the full chart first.
    const cov0 = await this.readCoverage();
    if (!cov0.full && (cov0.fromMs > fromMs + 60_000 || cov0.toMs < toMs - 60_000)) {
      await this.resetZoom();
    }
    for (let i = 0; i < steps; i++) {
      const cov = await this.readCoverage();
      const span = cov.toMs - cov.fromMs;
      const targetSpan = toMs - fromMs;
      const fits = cov.fromMs <= fromMs + tolerance && cov.toMs >= toMs - tolerance;
      const tight = span <= targetSpan * 1.25 + 2 * 60 * 60 * 1000;
      if (fits && tight) return cov;
      const pxPerMs = (this.geom.right - this.geom.left) / span;
      // Extend outward so a one-pixel rounding error cannot push the target
      // outside the next visible range.
      const padPx = 3;
      const padMs = padPx / pxPerMs;
      let a = Math.max(cov.fromMs, fromMs - padMs);
      let b = Math.min(cov.toMs, toMs + padMs);
      if ((b - a) * pxPerMs < 18) {
        const center = (a + b) / 2;
        const half = Math.max((b - a) / 2, 18 / pxPerMs / 2, span * 0.08);
        a = Math.max(cov.fromMs, center - half);
        b = Math.min(cov.toMs, center + half);
      }
      let px1 = Math.max(this.geom.left, this.geom.xOf(a));
      let px2 = Math.min(this.geom.right, this.geom.xOf(b));
      if (px2 - px1 < 14) throw new Error('无法用可见手势缩放到该范围');
      const box = await this.canvasBox();
      const y = box.y + Math.round(box.height * 0.5);
      await this.page.mouse.move(box.x + px1, y);
      await this.page.mouse.down();
      await this.page.mouse.move(box.x + px2, y, { steps: 10 });
      await this.page.mouse.up();
      const prev = cov.text;
      const start = Date.now();
      let changed = false;
      while (Date.now() - start < 3000) {
        const c = await this.readCoverage();
        if (c.text !== prev) {
          changed = true;
          break;
        }
        await sleep(25);
      }
      if (!changed) throw new Error('拖动缩放没有生效');
      const cov2 = await this.readCoverage();
      this.geom = this.makeGeom(this.plotPx.left, this.plotPx.right, cov2.fromMs, cov2.toMs);
      this.coverage = cov2;
    }
    const final = await this.readCoverage();
    if (final.fromMs <= fromMs + tolerance && final.toMs >= toMs - tolerance) return final;
    throw new Error(`缩放未覆盖目标范围（${final.text}）`);
  }

  async screenshot(path, clip = null) {
    const box = await this.canvasBox();
    await this.page.screenshot({
      path,
      scale: 'css',
      clip: clip ?? { x: box.x, y: box.y, width: box.width, height: box.height },
    });
  }
}

export { HOUR_MS, DAY_MS };
