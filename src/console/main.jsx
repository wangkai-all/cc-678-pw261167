import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SERIES } from '../demo/data.js';
import { utcLabel } from '../shared/time.js';
import '../styles/fonts.css';
import '../styles/tokens.css';
import '../styles/console.css';

const PRESETS = [
  { id: 'all', label: '全部' },
  { id: 'last30', label: '最近 30 天' },
  { id: 'last60', label: '最近 60 天' },
  { id: 'custom', label: '自定义' },
];

const TABS = [
  { id: 'confirmed', label: '已确认' },
  { id: 'missing', label: '缺失' },
  { id: 'unconfirmed', label: '无法确认' },
  { id: 'log', label: '作业日志' },
];

const STATUS_LABEL = {
  value: '读数',
  zero: '零值',
  missing: '缺失',
  unconfirmed: '无法确认',
};

function useJob() {
  const [jobId, setJobId] = useState(null);
  const [state, setState] = useState('idle');
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const sourceRef = useRef(null);

  const stopStream = () => {
    sourceRef.current?.close();
    sourceRef.current = null;
  };

  const start = useCallback(async (payload) => {
    stopStream();
    setError(null);
    setEvents([]);
    setState('starting');
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      setState('error');
      setError(data.error || '任务创建失败');
      return;
    }
    setJobId(data.id);
    setState('running');
    const es = new EventSource(`/api/jobs/${data.id}/events`);
    sourceRef.current = es;
    es.onmessage = (evt) => {
      const payloadEvent = JSON.parse(evt.data);
      setEvents((prev) => [...prev, payloadEvent]);
      if (payloadEvent.type === 'state') setState(payloadEvent.state);
      if (payloadEvent.type === 'error') setError(payloadEvent.message);
    };
    es.onerror = () => {
      // The server closes the stream on completion; EventSource would retry.
      es.close();
    };
  }, []);

  const control = useCallback(async (action) => {
    if (!jobId) return;
    await fetch(`/api/jobs/${jobId}/${action}`, { method: 'POST' });
  }, [jobId]);

  useEffect(() => stopStream, []);

  return { jobId, state, events, error, start, control, setState };
}

function deriveView(events) {
  const rows = { confirmed: [], missing: [], unconfirmed: [] };
  let target = null;
  let tip = null;
  let page = null;
  let windowInfo = null;
  let summary = null;
  let seriesProgress = null;
  let phase = null;
  const logs = [];

  for (const ev of events) {
    if (ev.type === 'phase') phase = ev;
    if (ev.type === 'page') page = ev.page;
    if (ev.type === 'window') windowInfo = ev.window;
    if (ev.type === 'series-start') seriesProgress = { name: ev.seriesName, index: ev.index, total: ev.total };
    if (ev.type === 'targets') seriesProgress = { ...seriesProgress, count: ev.count };
    if (ev.type === 'target') {
      target = ev;
      tip = null;
    }
    if (ev.type === 'probe') {
      tip = {
        ...ev,
        status: ev.matched ? 'matched' : 'probe',
        value: ev.values?.[ev.seriesName] ?? null,
      };
    }
    if (ev.type === 'tip') tip = { ...ev, target };
    if (ev.type === 'confirmed' || ev.type === 'missing' || ev.type === 'unconfirmed') {
      rows[ev.type].push(ev.row);
      if (ev.summary) summary = ev.summary;
    }
    if (ev.type === 'done') summary = ev.summary;
    if (ev.type === 'log') logs.push(ev);
    if (ev.type === 'error') logs.push({ level: 'error', message: ev.message });
    if (ev.type === 'target-zoom') logs.push({ level: 'info', message: `${ev.rowId}: ${ev.message}` });
  }
  return { rows, target, tip, page, windowInfo, summary, seriesProgress, phase, logs };
}

function StatusDot({ state }) {
  return <span className={`status-dot ${state}`} aria-hidden="true" />;
}

function App() {
  const { jobId, state, events, error, start, control } = useJob();
  const view = useMemo(() => deriveView(events), [events]);
  const [selectedSeries, setSelectedSeries] = useState(() => SERIES.map((s) => s.name));
  const [preset, setPreset] = useState('all');
  const [fromISO, setFromISO] = useState('2024-01-01');
  const [toISO, setToISO] = useState('2024-06-16');
  const [switches, setSwitches] = useState({ dense: false, lag: false, freeze: false });
  const [tab, setTab] = useState('confirmed');
  const [localError, setLocalError] = useState(null);
  const [verify, setVerify] = useState(null);
  const [verifyBusy, setVerifyBusy] = useState(null);

  const running = state === 'running' || state === 'starting' || state === 'paused';
  const canExport = view.rows.confirmed.length + view.rows.missing.length > 0;

  const toggleSeries = (name) => {
    setSelectedSeries((prev) => {
      if (prev.includes(name)) {
        if (prev.length === 1) return prev;
        return prev.filter((n) => n !== name);
      }
      return [...prev, name];
    });
  };

  const submit = (e) => {
    e.preventDefault();
    setLocalError(null);
    if (!selectedSeries.length) {
      setLocalError('请至少选择一个系列');
      return;
    }
    if (preset === 'custom') {
      if (!fromISO || !toISO) {
        setLocalError('自定义范围需要开始与结束日期');
        return;
      }
      if (fromISO > toISO) {
        setLocalError('开始日期不能晚于结束日期');
        return;
      }
    }
    start({
      series: selectedSeries,
      window: preset === 'custom' ? { preset, fromISO, toISO } : { preset },
      options: { switches },
    });
  };

  const exportCsv = () => {
    const header = ['series', 'exact_time_utc', 'ms', 'status', 'value', 'reason'];
    const lines = [header.join(',')];
    for (const r of view.rows.confirmed) {
      lines.push([r.seriesName, r.time, r.ms, r.status, r.value, ''].map(csvCell).join(','));
    }
    for (const r of [...view.rows.missing, ...view.rows.unconfirmed]) {
      lines.push([r.seriesName, r.time, r.ms, r.status, '', r.reason].map(csvCell).join(','));
    }
    download('collect.csv', lines.join('\n'), 'text/csv');
  };

  const exportJson = () => {
    const payload = {
      window: view.windowInfo,
      page: view.page,
      summary: view.summary,
      rows: {
        confirmed: view.rows.confirmed,
        missing: view.rows.missing,
        unconfirmed: view.rows.unconfirmed,
      },
    };
    download('collect.json', JSON.stringify(payload, null, 2), 'application/json');
  };

  const verifyRow = async (row) => {
    if (!row) return;
    setVerifyBusy(row.id);
    setVerify({ row, loading: true });
    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seriesName: row.seriesName, ms: row.ms }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '核对失败');
      setVerify({ row, ...data });
    } catch (err) {
      setVerify({ row, error: err.message });
    } finally {
      setVerifyBusy(null);
    }
  };

  return (
    <div className="console">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>图表采集操作台</h1>
            <p>只读页面：图例、缩放与悬浮提示。没有数据接口，也不读图表内部变量。</p>
          </div>
        </div>
        <div className="topbar-right">
          <a className="ghost-link" href="/chart.html" target="_blank" rel="noreferrer">打开演示图表 ↗</a>
          <span className="state-chip">
            <StatusDot state={state === 'starting' ? 'running' : state} />
            {stateLabel(state)}
          </span>
        </div>
      </header>

      <div className="layout">
        <section className="panel controls" aria-label="采集设置">
          <form onSubmit={submit}>
            <fieldset>
              <legend>系列</legend>
              <div className="series-grid">
                {SERIES.map((s) => (
                  <label key={s.id} className={selectedSeries.includes(s.name) ? 'series-chip' : 'series-chip off'}>
                    <input
                      type="checkbox"
                      checked={selectedSeries.includes(s.name)}
                      onChange={() => toggleSeries(s.name)}
                    />
                    <span className="chip-key" style={{ background: s.color }} />
                    <span className="chip-name">{s.name}</span>
                    <span className="chip-cadence">{s.cadence.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend>时间范围</legend>
              <div className="preset-row">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={preset === p.id ? 'preset active' : 'preset'}
                    onClick={() => setPreset(p.id)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {preset === 'custom' ? (
                <div className="date-row">
                  <label>开始 <input type="date" value={fromISO} min="2024-01-01" max="2024-06-16" onChange={(e) => setFromISO(e.target.value)} /></label>
                  <label>结束 <input type="date" value={toISO} min="2024-01-01" max="2024-06-16" onChange={(e) => setToISO(e.target.value)} /></label>
                </div>
              ) : null}
              <p className="hint">窗口会按图表当前可见的日期范围裁剪。</p>
            </fieldset>

            <fieldset>
              <legend>演示页状态（采集前由程序通过页面按钮切换）</legend>
              <div className="switch-row">
                {[
                  { id: 'dense', label: '密集点', hint: '2024-02-14 → 02-17 每 2 小时额外采样' },
                  { id: 'lag', label: '延迟提示', hint: '提示先显示「正在读取」' },
                  { id: 'freeze', label: '卡住提示', hint: '故障演示：卡面不再更新' },
                ].map((s) => (
                  <label key={s.id} className={switches[s.id] ? 'series-chip' : 'series-chip off'} title={s.hint}>
                    <input
                      type="checkbox"
                      checked={switches[s.id]}
                      onChange={() => setSwitches((prev) => ({ ...prev, [s.id]: !prev[s.id] }))}
                    />
                    <span className="chip-name">{s.label}</span>
                    <span className="chip-cadence">{s.hint}</span>
                  </label>
                ))}
              </div>
              <p className="hint">只点演示页上公开的开关按钮，采集器仍然只读可见提示。</p>
            </fieldset>

            <div className="actions">
              <button type="submit" className="primary" disabled={running}>开始采集</button>
              {state === 'paused' ? (
                <button type="button" onClick={() => control('resume')}>继续</button>
              ) : (
                <button type="button" disabled={state !== 'running'} onClick={() => control('pause')}>暂停</button>
              )}
              <button type="button" disabled={!running} onClick={() => control('stop')}>停止</button>
            </div>
            {(localError || error) ? <p className="error" role="alert">{localError || error}</p> : null}
          </form>

          <div className="live" aria-live="polite">
            <div className="live-block">
              <span className="live-label">当前目标</span>
              {view.target ? (
                <strong className="mono">
                  {view.target.seriesName} · {view.target.time}
                </strong>
              ) : <strong className="muted">—</strong>}
              {view.seriesProgress ? (
                <span className="live-sub">
                  系列 {view.seriesProgress.index + 1}/{view.seriesProgress.total}
                  {view.seriesProgress.count != null ? ` · 计划 ${view.seriesProgress.count} 点` : ''}
                </span>
              ) : null}
              {view.phase ? <span className="live-sub">{view.phase.message}</span> : null}
            </div>
            <div className="live-block">
              <span className="live-label">页面提示</span>
              {view.tip ? (
                <div className="tip-readout">
                  <div className="tip-time mono">
                    {view.tip.tooltipTime ?? '未对上目标时刻'}
                    {view.tip.observedMs != null && view.tip.observedMs !== view.tip.targetMs ? (
                      <span className="tip-warn">（非目标）</span>
                    ) : null}
                    {view.tip.attempt && view.tip.attempt !== '全范围' ? (
                      <span className="live-sub"> · {view.tip.attempt}</span>
                    ) : null}
                  </div>
                  {view.tip.status === 'value' || view.tip.status === 'zero' || view.tip.status === 'matched' ? (
                    <div className="tip-value mono">{view.tip.value ?? '—'}</div>
                  ) : view.tip.status === 'probe' ? (
                    <div className="tip-state unconfirmed">未对上目标</div>
                  ) : (
                    <div className={`tip-state ${view.tip.status}`}>{STATUS_LABEL[view.tip.status] ?? view.tip.status}</div>
                  )}
                </div>
              ) : (
                <div className="muted">
                  {view.target ? '正在读取提示…' : view.phase ? view.phase.message : '未开始'}
                </div>
              )}
            </div>
            <div className="live-block">
              <span className="live-label">已确认</span>
              <strong>{view.summary?.confirmed ?? 0}</strong>
              <span className="live-sub">
                零值 {view.summary?.zeros ?? 0} · 缺失 {view.summary?.missing ?? 0} · 无法确认 {view.summary?.unconfirmed ?? 0}
              </span>
            </div>
          </div>
        </section>

        <section className="panel results" aria-label="采集结果">
          <div className="results-head">
            <div className="tabs" role="tablist" aria-label="结果分类">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  className={tab === t.id ? 'tab active' : 'tab'}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                  {t.id !== 'log' ? <span className="tab-count">{view.rows[t.id].length}</span> : null}
                </button>
              ))}
            </div>
            <div className="export-row">
              <button type="button" disabled={!canExport} onClick={exportCsv}>导出 CSV</button>
              <button type="button" disabled={!canExport} onClick={exportJson}>导出 JSON</button>
            </div>
          </div>

          {view.windowInfo ? (
            <p className="window-note mono">
              采集窗口 {utcLabel(view.windowInfo.fromMs)} → {utcLabel(view.windowInfo.toMs)}
            </p>
          ) : null}

          <div className="table-host">
            {tab === 'log' ? (
              <LogTable logs={view.logs} page={view.page} />
            ) : (
              <RowsTable
                rows={view.rows[tab]}
                kind={tab}
                onVerify={verifyRow}
                busyId={verifyBusy}
                activeId={verify?.row?.id}
              />
            )}
          </div>
        </section>
      </div>

      {verify ? (
        <VerifyPanel
          data={verify}
          onClose={() => setVerify(null)}
          onRetry={() => verifyRow(verify.row)}
        />
      ) : null}
    </div>
  );
}

function stateLabel(state) {
  switch (state) {
    case 'running': return '采集中';
    case 'paused': return '已暂停';
    case 'done': return '已完成';
    case 'stopped': return '已停止';
    case 'error': return '出错';
    case 'starting': return '正在启动';
    default: return '待命';
  }
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(name, body, type) {
  const blob = new Blob([body], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function RowsTable({ rows, kind, onVerify, busyId, activeId }) {
  if (!rows.length) {
    return <p className="empty-note">{kind === 'confirmed' ? '还没有确认的读数。' : kind === 'missing' ? '没有检测到缺失。' : '没有无法确认的点。'}</p>;
  }
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>系列</th>
            <th>精确时间（UTC）</th>
            {kind === 'confirmed' ? <th className="num">值</th> : <th>原因</th>}
            <th className="num">状态</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.id === activeId ? 'row-active' : undefined}>
              <td>{r.seriesName}</td>
              <td className="mono">{r.time}</td>
              {kind === 'confirmed' ? (
                <td className="num mono">{r.status === 'zero' ? '0（零值）' : r.value}</td>
              ) : (
                <td className="reason">{r.reason}</td>
              )}
              <td className="num">
                <span className={`badge ${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
              </td>
              <td className="num">
                <button
                  type="button"
                  className="mini"
                  onClick={() => onVerify(r)}
                  disabled={busyId === r.id}
                >
                  {busyId === r.id ? '核对中…' : '在原图核对'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogTable({ logs, page }) {
  return (
    <div className="log-wrap">
      {page ? (
        <div className="page-facts">
          <h3>页面读到的可见信息</h3>
          <p className="mono">{page.coverage.text}</p>
          <ul>
            {page.legend.map((s) => (
              <li key={s.name}>
                {s.name} — {s.cadence}（初始{s.enabled ? '开启' : '关闭'}）
              </li>
            ))}
          </ul>
          {page.denseNote ? <p>密集采样说明：{page.samplingText}</p> : null}
        </div>
      ) : null}
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>时间</th><th>级别</th><th>消息</th></tr>
          </thead>
          <tbody>
            {logs.length ? logs.map((l, i) => (
              <tr key={`${l.at}-${i}`}>
                <td className="mono">{l.at ? new Date(l.at).toISOString().slice(11, 19) : ''}</td>
                <td>{l.level ?? 'info'}</td>
                <td className="reason">{l.message}</td>
              </tr>
            )) : <tr><td colSpan={3} className="empty-note">暂无日志</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VerifyPanel({ data, onClose, onRetry }) {
  return (
    <div className="verify-backdrop" role="dialog" aria-modal="true" aria-label="在原图核对">
      <div className="verify-panel">
        <header>
          <div>
            <h2>在原图核对</h2>
            <p className="mono">{data.row.seriesName} · {data.row.time}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">关闭</button>
        </header>
        {data.loading ? <p className="empty-note">正在打开图表并定位…</p> : null}
        {data.error ? <p className="error" role="alert">{data.error}</p> : null}
        {data.screenshot ? (
          <img className="verify-shot" src={`data:image/png;base64,${data.screenshot}`} alt={`图表定位截图：${data.row.time}`} />
        ) : null}
        {data.tooltip ? (
          <div className="verify-tip">
            <div className={`badge ${data.tooltip.matched ? 'value' : 'unconfirmed'}`}>
              {data.tooltip.matched ? '提示时刻与目标一致' : '提示未对上目标时刻'}
            </div>
            <p className="mono">{data.tooltip.time}</p>
            <ul>
              {data.tooltip.rows.map((r) => (
                <li key={r.name}>{r.name}：{r.value}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <footer>
          <button type="button" onClick={onRetry}>重新核对</button>
        </footer>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
