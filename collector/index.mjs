import { VisibleChart } from './page.mjs';
import { cadenceFromLabel, denseTimes, parseDenseNote, scheduledTimes } from './plan.mjs';
import { utcLabel } from '../src/shared/time.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

class StopSignal extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

function chunkTargets(targets, geom, { maxPerChunk = 14 } = {}) {
  if (!targets.length) return [];
  const pxPerMs = (geom.right - geom.left) / Math.max(1, geom.toMs - geom.fromMs);
  const chunks = [];
  let cur = [];
  for (const t of targets) {
    if (cur.length && (cur.length >= maxPerChunk || (t.ms - cur[0].ms) * pxPerMs > (geom.right - geom.left) * 0.6)) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(t);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function zoomWindowForChunk(chunk, coverage) {
  const first = chunk[0].ms;
  const last = chunk[chunk.length - 1].ms;
  const span = Math.max(last - first, 30 * 60 * 1000);
  const pad = Math.max(span * 0.15, 45 * 60 * 1000);
  let from = first - pad;
  let to = last + pad;
  // keep a comfortable minimum so two points don't share a pixel
  const minSpan = Math.max(span * 1.25, 90 * 60 * 1000);
  if (to - from < minSpan) {
    const mid = (from + to) / 2;
    from = mid - minSpan / 2;
    to = mid + minSpan / 2;
  }
  from = Math.max(coverage.fromMs, from);
  to = Math.min(coverage.toMs, to);
  return { fromMs: from, toMs: to };
}

/**
 * The whole run. Only public page affordances are used:
 *  - legend buttons to isolate a series,
 *  - drag-select to zoom,
 *  - pointer movement + the tooltip text,
 *  - the visible range and sampling notes.
 */
export async function runCollection({ page, request, emit = () => {}, signal, log = () => {} }) {
  const check = async () => {
    if (signal?.aborted) throw new StopSignal(signal.reason || 'stopped');
    if (signal?.paused?.()) {
      emit({ type: 'paused' });
      await signal.waitResume();
      emit({ type: 'resumed' });
    }
  };
  const chart = new VisibleChart(page, { log, pauseCheck: check });

  const startedAt = Date.now();
  emit({ type: 'phase', phase: 'open', message: '打开演示页并读取可见图例' });
  await chart.open();
  await check();

  if (request.options?.switches) {
    emit({ type: 'phase', phase: 'switches', message: '按操作台要求切换演示开关', switches: request.options.switches });
    await chart.applyDemoSwitches(request.options.switches);
  }

  const legend = chart.series;
  const knownNames = new Set(legend.map((s) => s.name));
  const requested = request.series.length ? request.series : legend.map((s) => s.name);
  const unknown = requested.filter((n) => !knownNames.has(n));
  if (unknown.length) throw new Error(`图例中没有这些系列：${unknown.join('、')}`);
  const denseNote = parseDenseNote(chart.samplingText);
  emit({
    type: 'page',
    page: {
      legend,
      coverage: chart.coverage,
      denseNote,
      samplingText: chart.samplingText,
      switches: chart.switches,
    },
  });

  const fullCoverage = chart.coverage.full ? { ...chart.coverage } : (await chart.resetZoom(), { ...chart.coverage });
  const window = await resolveWindow(chart, request, fullCoverage);
  emit({ type: 'window', window, fullCoverage });

  // With dense samples on, the visible note announces intra-day times.
  const denseActive = !!denseNote && denseNote.names.length > 0;

  const perSeries = [];
  const confirmed = [];
  const missing = [];
  const unconfirmed = [];
  let seq = 0;

  for (const name of requested) {
    await check();
    const series = chart.series.find((s) => s.name === name);
    emit({ type: 'series-start', seriesName: name, index: perSeries.length, total: requested.length });
    const cadence = cadenceFromLabel(series.cadence);
    // Cadence is anchored at the chart's full visible range, not at the
    // requested window (a 2-day cadence would otherwise drift by a day).
    const schedule = scheduledTimes({ cadence, coverage: fullCoverage, fromMs: window.fromMs, toMs: window.toMs });
    const extras = denseTimes({ denseNote, seriesName: name, coverage: fullCoverage, fromMs: window.fromMs, toMs: window.toMs });
    const times = [...schedule, ...extras.filter((t) => !schedule.includes(t))].sort((a, b) => a - b);
    const targets = times.map((ms) => ({ ms }));
    emit({ type: 'targets', seriesName: name, count: targets.length, cadence: cadence?.label ?? series.cadence, denseActive });
    if (!targets.length) {
      perSeries.push({ seriesName: name, targets: 0, confirmed: 0, missing: 0, unconfirmed: 0 });
      emit({ type: 'series-end', seriesName: name, summary: { targets: 0, confirmed: 0, missing: 0, unconfirmed: 0 } });
      continue;
    }

    const restore = await chart.isolateSeries(name);
    const seriesStats = { seriesName: name, targets: targets.length, confirmed: 0, missing: 0, unconfirmed: 0 };
    try {
      await chart.resetZoom();
      const chunkGeom = { left: chart.geom.left, right: chart.geom.right, fromMs: window.fromMs, toMs: window.toMs };
      const chunks = chunkTargets(targets, chunkGeom);
      const atWindow = atWindowOf(chart);
      for (const chunk of chunks) {
        await check();
        const zoomWindow = zoomWindowForChunk(chunk, window);
        const needsZoom = zoomWindow.toMs - zoomWindow.fromMs < (window.toMs - window.fromMs) * 0.98;
        let zoomed = await atWindow(zoomWindow);
        if (needsZoom && !zoomed) {
          emit({ type: 'phase', phase: 'zoom', message: `缩放到 ${utcLabel(zoomWindow.fromMs, { seconds: false })} → ${utcLabel(zoomWindow.toMs, { seconds: false })}`, zoomWindow });
          try {
            await chart.zoomTo(zoomWindow.fromMs, zoomWindow.toMs, { steps: 5 });
            zoomed = true;
          } catch (err) {
            emit({ type: 'log', level: 'warn', message: `缩放失败，改用全范围逐点核对：${err.message}` });
            await chart.resetZoom();
          }
        }
        for (const target of chunk) {
          await check();
          const rowId = `r${++seq}`;
          emit({ type: 'target', id: rowId, seriesName: name, ms: target.ms, time: utcLabel(target.ms), chunkSize: chunk.length });
          try {
            await chart.ensureTimeVisible(target.ms);
          } catch (err) {
            emit({ type: 'log', level: 'warn', message: `无法把目标移入可见范围：${err.message}` });
          }
          const outcome = await confirmTarget(chart, { seriesName: name, ms: target.ms, emit, rowId });
          emit({ type: 'tip', id: rowId, seriesName: name, targetMs: target.ms, ...outcome });
          if (outcome.status === 'value' || outcome.status === 'zero') {
            const row = {
              id: rowId,
              seriesName: name,
              ms: target.ms,
              time: utcLabel(target.ms),
              value: outcome.value,
              status: outcome.status,
              source: 'tooltip',
              zoom: outcome.zoomText,
            };
            confirmed.push(row);
            seriesStats.confirmed++;
            emit({ type: 'confirmed', row, summary: snapshot() });
          } else if (outcome.status === 'missing') {
            const row = {
              id: rowId,
              seriesName: name,
              ms: target.ms,
              time: utcLabel(target.ms),
              status: 'missing',
              reason: outcome.reason,
              observedTime: outcome.observedMs != null ? utcLabel(outcome.observedMs) : null,
            };
            missing.push(row);
            seriesStats.missing++;
            emit({ type: 'missing', row, summary: snapshot() });
          } else {
            const row = {
              id: rowId,
              seriesName: name,
              ms: target.ms,
              time: utcLabel(target.ms),
              status: 'unconfirmed',
              reason: outcome.reason,
              observedTime: outcome.observedMs != null ? utcLabel(outcome.observedMs) : null,
              tooltipTime: outcome.tooltipTime ?? null,
            };
            unconfirmed.push(row);
            seriesStats.unconfirmed++;
            emit({ type: 'unconfirmed', row, summary: snapshot() });
          }
        }
      }
    } finally {
      await restore().catch((e) => emit({ type: 'log', level: 'warn', message: `恢复图例失败：${e.message}` }));
    }
    perSeries.push(seriesStats);
    emit({ type: 'series-end', seriesName: name, summary: seriesStats });
  }

  await chart.resetZoom().catch(() => {});
  const finishedAt = Date.now();
  const summary = {
    ...snapshot(),
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    perSeries,
    page: { coverage: fullCoverage, legend, denseNote, samplingText: chart.samplingText },
    window,
  };
  emit({ type: 'done', summary });
  return { confirmed, missing, unconfirmed, summary };

  function snapshot() {
    return {
      confirmed: confirmed.length,
      missing: missing.length,
      unconfirmed: unconfirmed.length,
      zeros: confirmed.filter((r) => r.status === 'zero').length,
    };
  }
}

/**
 * The page keeps its zoom until something changes it. Reuse a view that already
 * contains this window instead of re-zooming (each extra drag is a chance to
 * round a target out of the visible range).
 */
function atWindowOf(chart) {
  return async ({ fromMs, toMs }) => {
    const cov = chart.coverage;
    if (!cov || cov.full) return false;
    const tol = 90_000;
    if (cov.fromMs <= fromMs + tol && cov.toMs >= toMs - tol) return true;
    try {
      await chart.zoomTo(fromMs, toMs, { steps: 5 });
      return true;
    } catch {
      return false;
    }
  };
}

async function resolveWindow(chart, request, coverage) {
  if (request.window?.fromISO && request.window?.toISO) {
    const fromMs = Date.parse(`${request.window.fromISO}T00:00:00Z`);
    const toMs = Date.parse(`${request.window.toISO}T23:59:59Z`);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      throw new Error('自定义时间范围无效');
    }
    return {
      fromMs: Math.max(fromMs, coverage.fromMs),
      toMs: Math.min(toMs, coverage.toMs),
    };
  }
  const preset = request.window?.preset ?? 'all';
  if (preset === 'last30') return { fromMs: Math.max(coverage.fromMs, coverage.toMs - 29 * DAY_MS), toMs: coverage.toMs };
  if (preset === 'last60') return { fromMs: Math.max(coverage.fromMs, coverage.toMs - 59 * DAY_MS), toMs: coverage.toMs };
  return { fromMs: coverage.fromMs, toMs: coverage.toMs };
}

/**
 * Confirm one target strictly from the tooltip.
 * Success requires the tooltip's own timestamp to equal the target: a tooltip
 * that still points at the previous sample is never accepted.
 */
async function confirmTarget(chart, { seriesName, ms, emit, rowId }) {
  const attempt = async (why) => {
    const res = await chart.hoverTime(ms, { timeout: 2600 });
    const tip = res.tip;
    emit({
      type: 'probe',
      rowId,
      seriesName,
      targetMs: ms,
      targetTime: utcLabel(ms),
      attempt: why,
      tooltipTime: tip?.time ?? null,
      observedMs: tip?.ms ?? null,
      matched: tip ? tip.ms === ms : false,
      values: tip?.values ?? null,
    });
    const row = tip?.values?.[seriesName];
    const rows = tip ? Object.keys(tip.values) : [];
    const other = rows.filter((n) => n !== seriesName);
    if (!tip) {
      return { status: 'unconfirmed', reason: `${why}：悬浮后没有出现提示`, tooltipTime: null };
    }
    if (tip.ms === ms && row === null) {
      return {
        status: 'missing',
        reason: `${why}：提示确认时刻 ${tip.time}，但该系列显示「无记录」`,
        observedMs: tip.ms,
        tooltipTime: tip.time,
      };
    }
    if (tip.ms === ms && row != null) {
      if (other.length) {
        emit({ type: 'log', level: 'warn', message: `提示里仍有其他系列：${other.join('、')}（隔离未完全生效）` });
      }
      if (!Number.isFinite(row)) {
        return { status: 'unconfirmed', reason: `${why}：提示值无法解析（${row}）`, observedMs: tip.ms, tooltipTime: tip.time };
      }
      return {
        status: row === 0 ? 'zero' : 'value',
        value: row,
        observedMs: tip.ms,
        tooltipTime: tip.time,
        zoomText: chart.coverage?.text ?? '',
      };
    }
    // Tooltip points at another time: either a neighbouring sample or a stale card.
    const deltaMs = tip.ms - ms;
    return {
      status: 'retry',
      observedMs: tip.ms,
      tooltipTime: tip.time,
      deltaMs,
      reason: `${why}：提示指在 ${tip.time}（目标 ${utcLabel(ms)}）`,
    };
  };

  let r = await attempt('全范围');
  if (r.status !== 'retry') return r;

  // Points collide on one pixel, or the tooltip is stale. Zoom around the
  // target on the visible time axis and ask again.
  const zoomSpan = Math.max(Math.abs(r.deltaMs) * 6, 12 * HOUR_MS);
  const from = Math.max(chart.coverage.fromMs, ms - zoomSpan / 2);
  const to = Math.min(chart.coverage.toMs, ms + zoomSpan / 2);
  emit({ type: 'target-zoom', rowId, message: '提示未对上目标时刻，缩放到局部再确认', fromMs: from, toMs: to });
  try {
    await chart.zoomTo(from, to, { steps: 3 });
  } catch (err) {
    return { status: 'unconfirmed', reason: `无法缩放核对：${err.message}`, observedMs: r.observedMs, tooltipTime: r.tooltipTime };
  }
  r = await attempt('局部放大');
  if (r.status !== 'retry') return r;

  // Still not matching: one more nudge at extreme zoom.
  try {
    await chart.zoomTo(Math.max(chart.coverage.fromMs, ms - 6 * HOUR_MS), Math.min(chart.coverage.toMs, ms + 6 * HOUR_MS), { steps: 3 });
  } catch {
    /* keep the first retry verdict */
  }
  r = await attempt('极限放大');
  if (r.status !== 'retry') return r;

  // The tooltip never showed the target even at extreme zoom. Zoom out far
  // enough that the neighbouring samples are on screen, then sweep the pointer
  // one screenshot-pixel at a time and read the tooltip after each move:
  //  - a reading appears at the target      => it was a pixel collision, accept;
  //  - 无记录 appears at the target          => the series really has no record;
  //  - times move, target is skipped         => real gap in the series;
  //  - the card never changes                => the tooltip is stuck (fault demo).
  let scan = null;
  try {
    const full = chart.fullCoverage ?? chart.coverage;
    const span = 2.2 * DAY_MS;
    const from = Math.max(full.fromMs, ms - span);
    const to = Math.min(full.toMs, ms + span);
    await chart.zoomTo(from, to, { steps: 5 });
    scan = await chart.scanAround(ms, { radiusPx: 200, stepPx: 4 });
  } catch (err) {
    emit({ type: 'log', level: 'warn', message: `邻近扫描无法完成：${err.message}` });
  }
  if (scan) {
    const atTarget = scan.find((r) => r.tip && r.tip.ms === ms);
    if (atTarget) {
      const v = atTarget.tip.values[seriesName];
      if (v === null) {
        return {
          status: 'missing',
          reason: `邻近扫描：${atTarget.tip.time} 的提示显示该系列「无记录」`,
          observedMs: ms,
          tooltipTime: atTarget.tip.time,
        };
      }
      if (Number.isFinite(v)) {
        return {
          status: v === 0 ? 'zero' : 'value',
          value: v,
          observedMs: ms,
          tooltipTime: atTarget.tip.time,
          zoomText: chart.coverage?.text ?? '',
        };
      }
    }
    const times = [...new Set(scan.filter((r) => r.tip).map((r) => r.tip.ms))].sort((a, b) => a - b);
    if (!times.length) {
      return {
        status: 'unconfirmed',
        reason: '目标附近连续移动指针都没有出现提示（页面提示无响应）',
        observedMs: null,
        tooltipTime: null,
      };
    }
    if (times.length === 1) {
      return {
        status: 'unconfirmed',
        reason: `提示始终停在 ${utcLabel(times[0])}，指针移动和缩放后都不更新，无法确认目标时刻`,
        observedMs: times[0],
        tooltipTime: r.tooltipTime,
      };
    }
    const before = times.filter((t) => t < ms).pop();
    const after = times.find((t) => t > ms);
    return {
      status: 'missing',
      reason: `邻近扫描：提示在 ${before != null ? utcLabel(before) : '—'} 与 ${after != null ? utcLabel(after) : '—'} 之间逐像素跟随指针，目标时刻没有出现读数（该处被跳过）`,
      observedMs: ms,
      tooltipTime: null,
    };
  }
  const observedMs = r.observedMs;
  if (observedMs != null) {
    return {
      status: 'missing',
      reason: `目标时刻没有可访问的数据点：最大放大下提示仍吸附到 ${utcLabel(observedMs)}，未出现该时刻的读数`,
      observedMs,
      tooltipTime: r.tooltipTime,
    };
  }
  return { status: 'unconfirmed', reason: r.reason, observedMs: null, tooltipTime: r.tooltipTime };
}

export { StopSignal, chunkTargets, zoomWindowForChunk };
