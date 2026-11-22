import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildData,
  SERIES,
  DENSE,
  BASE_MS,
  DAY_MS,
  HOUR_MS,
  utcLabel,
  isoDate,
  msForDay,
} from '../demo/data.js';

const PAD = { top: 24, right: 28, bottom: 38, left: 56 };
const TOOLTIP_DELAY_MS = 460;
const MIN_ZOOM_MS = 6 * HOUR_MS;
const WIDTH_STEPS = [null, 760, 560, 980];

function palette() {
  const cs = getComputedStyle(document.documentElement);
  const g = (name, fb) => cs.getPropertyValue(name).trim() || fb;
  return {
    surface: g('--surface', '#fcfcfb'),
    grid: g('--grid', '#e1e0d9'),
    axis: g('--axis', '#c3c2b7'),
    muted: g('--muted', '#898781'),
    font: g('--sans', 'system-ui, sans-serif'),
    dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  };
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function decimalsFor(step) {
  return step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
}

function colorOf(series) {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? series.colorDark : series.color;
}

const fmt = (v) => (v == null ? '无记录' : Number.isInteger(v) ? String(v) : v.toFixed(1));

function denseNoteText() {
  const names = SERIES.filter((s) => DENSE.appliesTo.includes(s.id)).map((s) => s.name).join('、');
  const from = utcLabel(msForDay(DENSE.startDay), { seconds: false });
  const to = utcLabel(msForDay(DENSE.endDay), { seconds: false });
  return `密集点已开启：${names} 在 ${from} 至 ${to} 每 ${DENSE.stepHours} 小时有额外采样（UTC 整点除外）。`;
}

export default function ChartPage() {
  const [dense, setDense] = useState(false);
  const [lag, setLag] = useState(false);
  const [freeze, setFreeze] = useState(false);
  const [visible, setVisible] = useState(() => Object.fromEntries(SERIES.map((s) => [s.id, true])));
  const [view, setView] = useState(null);
  const [widthStep, setWidthStep] = useState(0);
  const [notice, setNotice] = useState('');

  const data = useMemo(() => buildData({ dense }), [dense]);
  const refs = useRef({
    data,
    visible,
    view,
    lag,
    freeze,
    dense,
  });
  refs.current.data = data;
  refs.current.visible = visible;
  refs.current.view = view;
  refs.current.lag = lag;
  refs.current.freeze = freeze;
  refs.current.dense = dense;

  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const tooltipRef = useRef(null);
  const rangeRef = useRef(null);
  const captionRef = useRef(null);
  const geomRef = useRef(null);
  const hoverRef = useRef(null);
  const dragRef = useRef(null);
  const cardRef = useRef(null);
  const shownMsRef = useRef(null);
  const tipVisibleRef = useRef(false);
  const pendingRef = useRef(false);
  const timerRef = useRef(0);
  const drawRef = useRef(() => {});

  const bounds = useCallback(() => refs.current.view ?? {
    fromMs: refs.current.data.minMs,
    toMs: refs.current.data.maxMs,
  }, []);

  const locate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(280, Math.round(rect.width));
    const h = Math.max(220, Math.round(rect.height));
    return { w, h, plot: { left: PAD.left, top: PAD.top, right: w - PAD.right, bottom: h - PAD.bottom } };
  }, []);

  const clearCard = useCallback(() => {
    cardRef.current?.remove();
    cardRef.current = null;
    shownMsRef.current = null;
    tipVisibleRef.current = false;
    pendingRef.current = false;
    const host = tooltipRef.current;
    if (host) host.hidden = true;
  }, []);

  const hideTooltip = useCallback(() => {
    clearTimeout(timerRef.current);
    clearCard();
  }, [clearCard]);

  const placeCard = useCallback((card, x, y) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    const tw = card.offsetWidth;
    const th = card.offsetHeight;
    let left = x + 14;
    if (left + tw > wr.width - 6) left = x - tw - 14;
    left = Math.max(6, Math.min(left, wr.width - tw - 6));
    let top = y - th - 14;
    if (top < 6) top = y + 18;
    top = Math.max(6, Math.min(top, wr.height - th - 6));
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }, []);

  const showPendingCard = useCallback((x, y) => {
    const host = tooltipRef.current;
    if (!host) return;
    if (pendingRef.current) {
      placeCard(cardRef.current, x, y);
      return;
    }
    clearTimeout(timerRef.current);
    cardRef.current?.remove();
    const card = document.createElement('div');
    card.className = 'tt-card tt-pending-card';
    const line = document.createElement('div');
    line.className = 'tt-pending';
    line.textContent = '正在读取提示…';
    card.appendChild(line);
    host.hidden = false;
    host.appendChild(card);
    cardRef.current = card;
    pendingRef.current = true;
    shownMsRef.current = null;
    tipVisibleRef.current = true;
    placeCard(card, x, y);
  }, [placeCard]);

  const showRealCard = useCallback((point, x, y) => {
    const host = tooltipRef.current;
    if (!host) return;
    clearTimeout(timerRef.current);
    const card = document.createElement('div');
    card.className = 'tt-card';
    const time = document.createElement('div');
    time.className = 'tt-time';
    time.textContent = `${utcLabel(point.ms)} · 精确时间`;
    card.appendChild(time);
    for (const s of SERIES) {
      if (!refs.current.visible[s.id]) continue;
      const row = document.createElement('div');
      row.className = 'tt-row';
      const key = document.createElement('span');
      key.className = 'tt-key';
      key.style.background = colorOf(s);
      const name = document.createElement('span');
      name.className = 'tt-name';
      name.textContent = s.name;
      const val = document.createElement('span');
      val.className = 'tt-val';
      val.textContent = fmt(point.values[s.id]);
      row.append(key, name, val);
      card.appendChild(row);
    }
    cardRef.current?.remove();
    host.hidden = false;
    host.appendChild(card);
    cardRef.current = card;
    shownMsRef.current = point.ms;
    tipVisibleRef.current = true;
    pendingRef.current = false;
    placeCard(card, x, y);
  }, [placeCard]);

  const yForPoint = useCallback((point) => {
    const g = geomRef.current;
    if (!g) return 40;
    for (const s of SERIES) {
      if (refs.current.visible[s.id] && point.values[s.id] != null) {
        return g.yOf(point.values[s.id]);
      }
    }
    return g.plot.top + 44;
  }, []);

  const reveal = useCallback((point, x, y) => {
    const st = refs.current;
    if (st.freeze && tipVisibleRef.current && !pendingRef.current) return; // stuck-tooltip demo
    const stale = pendingRef.current || !tipVisibleRef.current || shownMsRef.current !== point.ms;
    if (!stale) return;
    if (st.lag) {
      showPendingCard(x, y);
      timerRef.current = setTimeout(() => {
        if (hoverRef.current?.point === point) showRealCard(point, x, y);
      }, TOOLTIP_DELAY_MS);
    } else {
      showRealCard(point, x, y);
    }
  }, [placeCard, showPendingCard, showRealCard]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const geom = locate();
    if (!canvas || !geom) return;
    const { w, h, plot } = geom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pal = palette();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = pal.surface;
    ctx.fillRect(0, 0, w, h);

    const st = refs.current;
    const shown = SERIES.filter((s) => st.visible[s.id]);
    const empty = document.getElementById('chart-empty');
    if (empty) empty.hidden = shown.length > 0;

    const { fromMs, toMs } = bounds();
    const pts = st.data.points.filter((p) => p.ms >= fromMs && p.ms <= toMs);
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      for (const s of shown) {
        const v = p.values[s.id];
        if (v == null) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 10;
    }
    const step = niceStep(Math.max(1, (hi - lo) / 4));
    const yMin = Math.max(0, Math.floor((lo - step * 0.5) / step) * step);
    const yMax = Math.ceil((hi + step * 0.6) / step) * step;
    const xOf = (ms) => plot.left + ((ms - fromMs) / (toMs - fromMs || 1)) * (plot.right - plot.left);
    const yOf = (v) => plot.bottom - ((v - yMin) / (yMax - yMin || 1)) * (plot.bottom - plot.top);
    geomRef.current = { w, h, plot, fromMs, toMs, yMin, yMax, step, xOf, yOf, shown };

    ctx.font = `11px ${pal.font}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(yMin / step) * step; v <= yMax + 1e-9; v += step) {
      const y = yOf(v);
      ctx.strokeStyle = pal.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.left, Math.round(y) + 0.5);
      ctx.lineTo(plot.right, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = pal.muted;
      ctx.fillText(v.toFixed(decimalsFor(step)), plot.left - 9, y);
    }

    const spanDays = (toMs - fromMs) / DAY_MS;
    const dayStep = spanDays > 110 ? 30 : spanDays > 50 ? 14 : spanDays > 18 ? 7 : spanDays > 6 ? 2 : 1;
    const firstDay = Math.ceil((fromMs - BASE_MS) / DAY_MS);
    const lastDay = Math.floor((toMs - BASE_MS) / DAY_MS);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let d = firstDay; d <= lastDay; d++) {
      if (d % dayStep !== 0 && d !== firstDay && d !== lastDay) continue;
      const x = xOf(BASE_MS + d * DAY_MS);
      if (x < plot.left + 22 || x > plot.right - 22) continue;
      ctx.strokeStyle = pal.grid;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plot.bottom);
      ctx.lineTo(Math.round(x) + 0.5, plot.bottom + 4);
      ctx.stroke();
      ctx.fillStyle = pal.muted;
      ctx.fillText(isoDate(BASE_MS + d * DAY_MS).slice(5).replace('-', '/'), x, plot.bottom + 9);
    }

    ctx.strokeStyle = pal.axis;
    ctx.beginPath();
    ctx.moveTo(plot.left, Math.round(plot.bottom) + 0.5);
    ctx.lineTo(plot.right, Math.round(plot.bottom) + 0.5);
    ctx.stroke();

    for (const s of shown) {
      ctx.strokeStyle = colorOf(s);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      // A line breaks where the series' own cadence has a hole; timestamps that
      // belong to another series are not holes for this one.
      const seriesPts = pts.filter((p) => p.values[s.id] != null);
      const stepMs = s.cadence.stepDays * DAY_MS;
      const breakAfter = stepMs * 1.5;
      let seg = [];
      const flush = () => {
        if (seg.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(xOf(seg[0].ms), yOf(seg[0].values[s.id]));
          for (let i = 1; i < seg.length; i++) {
            ctx.lineTo(xOf(seg[i].ms), yOf(seg[i].values[s.id]));
          }
          ctx.stroke();
        }
        seg = [];
      };
      let prevMs = null;
      for (const p of seriesPts) {
        if (prevMs != null && p.ms - prevMs > breakAfter) flush();
        seg.push(p);
        prevMs = p.ms;
      }
      flush();
    }

    const hover = hoverRef.current;
    if (hover) {
      const p = hover.point;
      const x = xOf(p.ms);
      ctx.save();
      ctx.strokeStyle = pal.axis;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plot.top);
      ctx.lineTo(Math.round(x) + 0.5, plot.bottom);
      ctx.stroke();
      ctx.restore();
      for (const s of shown) {
        const v = p.values[s.id];
        if (v == null) continue;
        ctx.beginPath();
        ctx.arc(x, yOf(v), 4, 0, Math.PI * 2);
        ctx.fillStyle = colorOf(s);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = pal.surface;
        ctx.stroke();
      }
    }

    const drag = dragRef.current;
    if (drag) {
      const a = Math.min(drag.startX, drag.curX);
      const b = Math.max(drag.startX, drag.curX);
      ctx.fillStyle = 'rgba(42, 120, 214, 0.12)';
      ctx.fillRect(a, plot.top, b - a, plot.bottom - plot.top);
    }

    if (rangeRef.current) {
      rangeRef.current.textContent = `${st.view ? '可见范围' : '全量范围'} ${utcLabel(fromMs, { seconds: false })} → ${utcLabel(toMs, { seconds: false })}`;
    }
    if (captionRef.current) {
      captionRef.current.textContent = st.view
        ? '已缩放：提示只覆盖当前可见范围。双击画布或按 Esc 返回全量。'
        : '在画布上悬浮或用方向键读取提示；拖动框选可缩放；点击图例开关系列。';
    }
  }, [bounds, locate]);
  drawRef.current = draw;

  const hitTest = useCallback((x) => {
    const g = geomRef.current;
    if (!g) return null;
    const { plot } = g;
    if (x < plot.left || x > plot.right) return null;
    const t = Math.min(1, Math.max(0, (x - plot.left) / (plot.right - plot.left || 1)));
    const ms = g.fromMs + t * (g.toMs - g.fromMs);
    const pts = refs.current.data.points;
    let a = 0;
    let b = pts.length - 1;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (pts[mid].ms < ms) a = mid + 1;
      else b = mid;
    }
    const cand = [pts[Math.max(0, a - 1)], pts[a]].filter(Boolean);
    cand.sort((p, q) => Math.abs(p.ms - ms) - Math.abs(q.ms - ms));
    const hasVisible = (p) => SERIES.some((s) => refs.current.visible[s.id] && p.values[s.id] != null);
    return cand.find(hasVisible) ?? cand[0] ?? null;
  }, []);

  const hoverAt = useCallback((x) => {
    const point = hitTest(x);
    if (!point) {
      hoverRef.current = null;
      hideTooltip();
      drawRef.current();
      return;
    }
    hoverRef.current = { point, x };
    drawRef.current();
    reveal(point, x, yForPoint(point));
  }, [hideTooltip, hitTest, reveal, yForPoint]);

  useEffect(() => {
    draw();
    const ro = new ResizeObserver(() => {
      drawRef.current();
      if (cardRef.current && hoverRef.current && tipVisibleRef.current) {
        placeCard(cardRef.current, hoverRef.current.x, yForPoint(hoverRef.current.point));
      }
    });
    if (wrapRef.current) ro.observe(wrapRef.current);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => {
      drawRef.current();
      if (cardRef.current && hoverRef.current && tipVisibleRef.current) {
        const { point } = hoverRef.current;
        if (point && !pendingRef.current) showRealCard(point, hoverRef.current.x, yForPoint(point));
      }
    };
    mq.addEventListener('change', onTheme);
    return () => {
      ro.disconnect();
      mq.removeEventListener('change', onTheme);
      clearTimeout(timerRef.current);
    };
  }, [draw, placeCard, showRealCard, yForPoint]);

  useEffect(() => {
    draw();
  }, [data, visible, view, draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const pos = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const move = (e) => {
      const { x } = pos(e);
      if (dragRef.current) {
        dragRef.current.curX = x;
        drawRef.current();
        return;
      }
      hoverAt(x);
    };
    const leave = () => {
      if (dragRef.current) return;
      hoverRef.current = null;
      hideTooltip();
      drawRef.current();
    };
    const down = (e) => {
      if (e.button !== 0) return;
      const { x } = pos(e);
      dragRef.current = { startX: x, curX: x };
      hoverRef.current = null;
      hideTooltip();
    };
    const up = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      const g = geomRef.current;
      if (!drag || !g) {
        drawRef.current();
        return;
      }
      if (Math.abs(drag.curX - drag.startX) < 14) {
        drawRef.current();
        return;
      }
      const { plot } = g;
      const at = (x) => g.fromMs + Math.min(1, Math.max(0, (x - plot.left) / (plot.right - plot.left || 1))) * (g.toMs - g.fromMs);
      const from = Math.max(g.fromMs, at(Math.min(drag.startX, drag.curX)));
      const to = Math.min(g.toMs, at(Math.max(drag.startX, drag.curX)));
      if (to - from < MIN_ZOOM_MS) {
        setNotice('选区太窄（至少 6 小时），未缩放。');
        drawRef.current();
        return;
      }
      setNotice('');
      hoverRef.current = null;
      hideTooltip();
      setView({ fromMs: from, toMs: to });
    };
    const dbl = () => {
      hoverRef.current = null;
      hideTooltip();
      setView(null);
      setNotice('');
    };
    const key = (e) => {
      if (e.key === 'Escape') {
        if (refs.current.view) {
          setView(null);
          hoverRef.current = null;
          hideTooltip();
          setNotice('');
        } else if (hoverRef.current) {
          hoverRef.current = null;
          hideTooltip();
          drawRef.current();
        }
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const g = geomRef.current;
      if (!g) return;
      const hasVisible = (p) => SERIES.some((s) => refs.current.visible[s.id] && p.values[s.id] != null);
      const pts = refs.current.data.points.filter(hasVisible);
      const idx = hoverRef.current ? pts.indexOf(hoverRef.current.point) : 0;
      const next = Math.max(0, Math.min(pts.length - 1, idx + (e.key === 'ArrowRight' ? 1 : -1)));
      const point = pts[next];
      if (!point) return;
      const x = g.xOf(point.ms);
      hoverRef.current = { point, x };
      drawRef.current();
      clearTimeout(timerRef.current);
      showRealCard(point, x, yForPoint(point));
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    canvas.addEventListener('dblclick', dbl);
    canvas.addEventListener('keydown', key);
    return () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      canvas.removeEventListener('dblclick', dbl);
      canvas.removeEventListener('keydown', key);
    };
  }, [hideTooltip, hoverAt, showRealCard, yForPoint]);

  const toggleSeries = (id) => {
    setVisible((prev) => {
      const active = Object.values(prev).filter(Boolean).length;
      if (prev[id] && active === 1) return prev;
      return { ...prev, [id]: !prev[id] };
    });
    hoverRef.current = null;
    hideTooltip();
  };

  const widthPx = WIDTH_STEPS[widthStep];

  return (
    <div className="chart-page">
      <header className="chart-header">
        <div>
          <h1>边缘节点 · 日均活跃与作业量</h1>
          <p>匿名汇总演示。页面不提供数据接口，只有可见图例、缩放与悬浮提示。</p>
        </div>
        <nav className="page-links" aria-label="页面">
          <a href="/">采集操作台</a>
          <a href="#demo-controls">演示开关</a>
        </nav>
      </header>

      <section className="chart-shell" id="chart-shell" aria-label="演示图表">
        <div className="chart-topline">
          <div>
            <h2 className="chart-title">四路采样序列</h2>
            <p className="chart-subtitle">各系列采样节奏不同；提示给出精确 UTC 时刻与读数。</p>
            <p className="chart-range" ref={rangeRef}>全量范围</p>
          </div>
          <div className="legend" role="group" aria-label="图例，点击开关系列">
            {SERIES.map((s) => {
              const on = visible[s.id];
              return (
                <button
                  key={s.id}
                  type="button"
                  className={on ? 'legend-item' : 'legend-item off'}
                  aria-pressed={on}
                  onClick={() => toggleSeries(s.id)}
                >
                  <span className="legend-key" style={{ background: on ? colorOf(s) : 'var(--muted)' }} />
                  <span className="legend-name">{s.name}</span>
                  <span className="legend-cadence">{s.cadence.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <p className="chart-sampling" id="chart-sampling">
          采样说明：{SERIES.map((s) => `${s.name} ${s.cadence.label}`).join('；')}。
          {dense ? ` ${denseNoteText()}` : ''}
          折线在无记录处断开；零值是真实读数，不是缺失。
        </p>

        <div className="canvas-wrap" ref={wrapRef} id="canvas-wrap" style={widthPx ? { maxWidth: widthPx } : undefined}>
          <canvas
            ref={canvasRef}
            id="chart-canvas"
            tabIndex={0}
            role="img"
            aria-label="折线图。使用方向键移动提示，拖动框选缩放，双击或 Escape 返回全量。"
            aria-describedby="chart-caption chart-sampling"
          />
          <div className="chart-tooltip" ref={tooltipRef} role="status" aria-live="polite" hidden />
          <div className="chart-empty" id="chart-empty" hidden>至少开启一个系列才会显示折线。</div>
        </div>
        <p className="chart-caption" id="chart-caption" ref={captionRef} />
        {notice ? <p className="chart-notice" role="status">{notice}</p> : null}
      </section>

      <section className="chart-demo-controls" id="demo-controls" aria-label="演示开关">
        <span className="demo-label">演示开关</span>
        <button type="button" id="demo-width" onClick={() => setWidthStep((n) => (n + 1) % WIDTH_STEPS.length)}>
          改变容器宽度{widthPx ? `（${widthPx}px）` : '（自适应）'}
        </button>
        <button
          type="button"
          id="demo-dense"
          aria-pressed={dense}
          onClick={() => {
            setDense((v) => !v);
            setView(null);
            hoverRef.current = null;
            hideTooltip();
          }}
        >
          {dense ? '关闭密集点' : '开启密集点'}
        </button>
        <button type="button" id="demo-lag" aria-pressed={lag} onClick={() => setLag((v) => !v)}>
          {lag ? '关闭延迟提示' : '开启延迟提示'}
        </button>
        <button type="button" id="demo-freeze" aria-pressed={freeze} onClick={() => setFreeze((v) => !v)}>
          {freeze ? '恢复提示' : '卡住提示（故障演示）'}
        </button>
        <button type="button" onClick={() => drawRef.current()}>重绘</button>
      </section>

      <section className="table-view">
        <details>
          <summary>表格视图（不依赖悬浮的可读副本）</summary>
          <ChartTable visible={visible} view={view} dense={dense} />
        </details>
      </section>
    </div>
  );
}

function ChartTable({ visible, view, dense }) {
  const data = useMemo(() => buildData({ dense }), [dense]);
  const rows = useMemo(() => {
    const from = view?.fromMs ?? data.minMs;
    const to = view?.toMs ?? data.maxMs;
    return data.points.filter((p) => p.ms >= from && p.ms <= to);
  }, [data, view]);
  const shown = SERIES.filter((s) => visible[s.id]);
  if (!shown.length) return <p className="empty-note">没有开启的系列。</p>;
  return (
    <div className="table-scroll" style={{ maxHeight: 300 }}>
      <table>
        <thead>
          <tr>
            <th>采样时间（UTC）</th>
            {shown.map((s) => (
              <th key={s.id} className="num">{s.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 400).map((p) => (
            <tr key={p.ms}>
              <td className="mono">{utcLabel(p.ms)}</td>
              {shown.map((s) => (
                <td key={s.id} className="num">
                  {p.values[s.id] == null ? '—' : p.values[s.id]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
