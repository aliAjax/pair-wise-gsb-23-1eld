import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import type { ConflictView, ExceptionTicket, InspectionRecord } from "./domain/types";
import { buildConflictViews, fmtClock, fmtTime } from "./domain/logic";
import {
  ROOMS,
  approveTicket,
  boot,
  canApprove,
  closeHandover,
  crashAndReload,
  openHandover,
  publishNewCalibration,
  resetDemo,
  resolveConflict,
  resubmitTicket,
  saveRecord,
  setOnline,
  simulateOtherDeviceDuplicate,
  syncNow,
  useStore,
  verifyRecord,
} from "./store/store";

function useConflictViews() {
  const records = useStore((s) => s.records);
  const resolutions = useStore((s) => s.resolutions);
  return useMemo(() => buildConflictViews(records, resolutions), [records, resolutions]);
}

type Tab = "inspect" | "review" | "calib" | "logs";

function Badge({ tone, children }: { tone: "ok" | "warn" | "danger" | "muted" | "info"; children: React.ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function ticketTone(t: ExceptionTicket): "warn" | "danger" | "ok" | "muted" {
  if (t.status === "confirmed") return "ok";
  if (!t.basis) return "danger";
  if (t.basis?.exceeded) return "warn";
  return "muted";
}

function ticketLabel(t: ExceptionTicket): string {
  if (t.status === "confirmed") return "已确认·冻结";
  if (!t.basis) return "待核";
  if (t.basis?.exceeded) return "未审批·超限";
  if (t.history.some((e) => e.type === "recomputed")) return "未审批·重算合格";
  return "未审批";
}

function RecordLine({ r }: { r: InspectionRecord }) {
  return (
    <div className="record-mini">
      <span className={`dot ${r.origin === "巡检端A" ? "dot-a" : "dot-b"}`} />
      <div>
        <strong>{r.roomId}</strong>
        <span className="dim">
          {r.isoClass} · 封条 {fmtTime(r.sealedAt)} · {r.origin}
        </span>
        <span className="dim">
          0.5µm={r.counts["0.5um"] ?? "—"} / 5µm={r.counts["5um"] ?? "—"} · 校准{" "}
          {r.calibrationId ?? <b className="missing">缺失·待核</b>}
        </span>
      </div>
    </div>
  );
}

function ConflictCard({ view }: { view: ConflictView }) {
  const chosen = view.chosenRecordId;
  return (
    <article className="card conflict-card">
      <header className="card-head">
        <div>
          <h3>
            {view.roomId} · {view.periodKey}
          </h3>
          <p className="dim">两份原始记录均保留，差异字段已标出；按现场封条时间定先后</p>
        </div>
        {chosen ? <Badge tone="ok">已选用</Badge> : <Badge tone="danger">待复核选用</Badge>}
      </header>

      <div className="dup-grid">
        {view.records.map((r, i) => (
          <div
            className={`dup-col ${chosen === r.id ? "picked" : ""} ${
              r.id === view.suggestedRecordId ? "suggested" : ""
            }`}
            key={r.id}
          >
            <div className="dup-head">
              <strong>{r.origin}</strong>
              {r.id === view.suggestedRecordId && <Badge tone="info">封条最早·建议</Badge>}
              {chosen === r.id && <Badge tone="ok">已选</Badge>}
              <span className="dim">#{i + 1}</span>
            </div>
            <p className="dim">封条 {fmtClock(r.sealedAt)}</p>
            <p className="dim">上传/录入 {fmtClock(r.capturedAt)}（不参与排序）</p>
            <p>
              0.5µm：<b>{r.counts["0.5um"] ?? "—"}</b>
            </p>
            <p>
              5µm：<b>{r.counts["5um"] ?? "—"}</b>
            </p>
            {!chosen && (
              <button className="primary-action small" onClick={() => resolveConflict(view.roomId, view.periodKey, r.id)}>
                按此封条时间选用
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="diff-row">
        {view.differences.map((d) => (
          <span key={d.field} className={d.divergent ? "diff-on" : "diff-off"}>
            {d.field}：{d.divergent ? "两份不一致 ⚠" : "一致"}
          </span>
        ))}
      </div>
    </article>
  );
}

function TicketCard({ ticket }: { ticket: ExceptionTicket }) {
  const [text, setText] = useState(ticket.conclusion ?? "已更换高效滤网并复测，粒子计数回落。");
  const guard = canApprove(ticket);
  const lastBasis = ticket.basis;
  return (
    <article className={`card ticket-card tone-${ticketTone(ticket)}`}>
      <header className="card-head">
        <div>
          <h3>
            {ticket.roomId} · {ticket.periodKey}
          </h3>
          <p className="dim mono">{ticket.id}</p>
        </div>
        <Badge tone={ticketTone(ticket)}>{ticketLabel(ticket)}</Badge>
      </header>

      <div className="basis">
        {lastBasis ? (
          <>
            <p>
              判定依据：<b>{lastBasis.calibrationId}</b>
              {ticket.status === "confirmed" && <Badge tone="ok">阈值/编号已冻结</Badge>}
            </p>
            <p className="dim">
              {lastBasis.violations.length
                ? lastBasis.violations.map((v) => `${v.kind} ${v.value} > 阈值 ${v.limit}`).join("；")
                : "各粒子计数均未超当时阈值"}
            </p>
          </>
        ) : (
          <p className="missing">无可用判定依据（校准编号缺失）</p>
        )}
      </div>

      {ticket.status === "confirmed" ? (
        <div className="confirmed-box">
          <p>
            <b>复核结论：</b>
            {ticket.conclusion}
          </p>
          <p className="dim">
            确认人 {ticket.handler} · {ticket.confirmedAt ? fmtClock(ticket.confirmedAt) : ""}
          </p>
        </div>
      ) : (
        <div className="approve-row">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="处理结论" />
          <button
            className="primary-action"
            disabled={!guard.ok}
            title={guard.reason}
            onClick={() => approveTicket(ticket.id, text)}
          >
            复核确认
          </button>
          <button onClick={() => resubmitTicket(ticket.id)}>重复提交</button>
        </div>
      )}
      {!guard.ok && ticket.status !== "confirmed" && <p className="block-reason">⛔ {guard.reason}</p>}

      <details className="history">
        <summary>处理轨迹（{ticket.history.length}）</summary>
        {ticket.history.map((e, i) => (
          <p key={i} className={`hist hist-${e.type}`}>
            <span className="dim">{fmtTime(e.at)}</span> {e.message}
          </p>
        ))}
      </details>
    </article>
  );
}

function InspectTab() {
  const allRecords = useStore((s) => s.records);
  const records = useMemo(
    () => allRecords.filter((r) => !r.deleted).sort((a, b) => b.sealedAt - a.sealedAt),
    [allRecords],
  );
  const handovers = useStore((s) => s.handovers);
  const openId = useStore((s) => s.openHandoverId);
  const tickets = useStore((s) => s.tickets);
  const resolutions = useStore((s) => s.resolutions);
  const calibrations = useStore((s) => s.calibrations);
  const outboxCount = useStore((s) => s.outbox.filter((o) => o.status !== "acked").length);

  const [roomId, setRoomId] = useState(ROOMS[0].id);
  const [sealedValue, setSealedValue] = useState(toLocalInput(Date.now() - 5 * 60_000));
  const [c05, setC05] = useState("3650");
  const [c5, setC5] = useState("18");

  const conflicts = useConflictViews();
  const open = handovers.find((h) => h.id === openId);

  function submit(origin: InspectionRecord["origin"]) {
    saveRecord({
      roomId,
      isoClass: ROOMS.find((r) => r.id === roomId)!.iso,
      sealedAt: new Date(sealedValue).getTime(),
      counts: { "0.5um": Number(c05), "5um": Number(c5) },
      origin,
    });
  }

  return (
    <div className="tab-grid">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">夜班巡检员</p>
            <h2>现场粒子计数（断网可记）</h2>
          </div>
          {outboxCount > 0 && <Badge tone="warn">本地待同步 {outboxCount} 条</Badge>}
        </div>

        <div className="handover-box">
          {open ? (
            <>
              <div>
                <b>{open.shiftLabel}</b> <Badge tone="warn">进行中</Badge>
                <p className="dim mono">{open.id}</p>
              </div>
              <button onClick={closeHandover}>完成交接批次（写检查点）</button>
            </>
          ) : (
            <>
              <p>当前没有进行中的交接批次</p>
              <button className="primary-action" onClick={openHandover}>
                开始新交接批次
              </button>
            </>
          )}
        </div>

        <div className="field-grid">
          <label>
            <span>房间</span>
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {ROOMS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}（{r.iso}）
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>现场封条时间（现场先后只认它）</span>
            <input type="datetime-local" value={sealedValue} onChange={(e) => setSealedValue(e.target.value)} />
          </label>
          <label>
            <span>0.5µm 计数（粒/m³）</span>
            <input value={c05} onChange={(e) => setC05(e.target.value)} inputMode="numeric" />
          </label>
          <label>
            <span>5µm 计数（粒/m³）</span>
            <input value={c5} onChange={(e) => setC5(e.target.value)} inputMode="numeric" />
          </label>
        </div>
        <div className="btn-row">
          <button className="primary-action" onClick={() => submit("巡检端A")}>
            巡检端A 保存（本机）
          </button>
          <button onClick={() => simulateOtherDeviceDuplicate()}>
            模拟：巡检端B 断网也记了同一房间（后上传）
          </button>
        </div>
        <p className="dim hint">
          当前生效校准：{calibrations.filter((c) => c.approved).sort((a, b) => b.issuedAt - a.issuedAt)[0]?.id ?? "无"}
          ，保存时按封条时刻落校准编号；没有已生效批次则留空（待核）。
        </p>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">合并冲突</p>
            <h2>同房间同时段双份记录</h2>
          </div>
          <Badge tone={conflicts.length ? "danger" : "ok"}>{conflicts.length} 组</Badge>
        </div>
        {conflicts.length === 0 && <p className="dim">暂无冲突。断网下用两个端各记一次同房间，再点“立即同步合并”。</p>}
        <div className="stack">
          {conflicts.map((c) => (
            <ConflictCard key={c.id} view={c} />
          ))}
        </div>
      </section>

      <section className="panel wide">
        <div className="section-heading">
          <div>
            <p className="eyebrow">原始数据</p>
            <h2>巡检记录（全部保留，按封条时间排序）</h2>
          </div>
        </div>
        <div className="record-table">
          {records.map((r) => {
            const t = tickets.find((x) => x.roomId === r.roomId && x.periodKey === r.periodKey);
            const isChosen = resolutions.find((x) => x.id === `C|${r.roomId}|${r.periodKey}`)?.chosenRecordId === r.id;
            return (
              <div className="tr" key={r.id}>
                <span className="td-seal">{fmtTime(r.sealedAt)}</span>
                <span className="td-room">
                  {r.roomId}
                  {isChosen && <Badge tone="ok">选用</Badge>}
                </span>
                <span className="dim">{r.origin}</span>
                <span>
                  0.5µm {r.counts["0.5um"] ?? "—"} / 5µm {r.counts["5um"] ?? "—"}
                </span>
                <span>{r.calibrationId ?? <Badge tone="danger">缺校准编号</Badge>}</span>
                <span className="dim">
                  {r.handoverBatchId ?? "无批次"} · 上传 {fmtTime(r.capturedAt)}
                </span>
                {!r.calibrationId && (
                  <button className="small" onClick={() => verifyRecord(r.id, "CAL-2026Q3")}>
                    补核为 CAL-2026Q3
                  </button>
                )}
                {t && <Badge tone={ticketTone(t)}>{ticketLabel(t)}</Badge>}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ReviewTab() {
  const tickets = useStore((s) => s.tickets);
  const sorted = useMemo(
    () =>
      [...tickets].sort(
        (a, b) =>
          Number(a.status === "confirmed") - Number(b.status === "confirmed") ||
          a.roomId.localeCompare(b.roomId),
      ),
    [tickets],
  );
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">复核员 · 回办公区整理</p>
          <h2>异常处理单</h2>
        </div>
        <Badge tone="muted">{tickets.length} 张（编号按 房间|时段 确定，重复提交不新增）</Badge>
      </div>
      <div className="ticket-grid">
        {sorted.map((t) => (
          <TicketCard key={t.id} ticket={t} />
        ))}
      </div>
    </section>
  );
}

function CalibTab() {
  const calibrations = useStore((s) => s.calibrations);
  const tickets = useStore((s) => s.tickets);
  return (
    <div className="tab-grid">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">设备校准批次 · LPC-A07</p>
            <h2>批次管理</h2>
          </div>
        </div>
        <div className="stack">
          {[...calibrations].sort((a, b) => b.issuedAt - a.issuedAt).map((c) => (
            <article className="card" key={c.id}>
              <div className="card-head">
                <div>
                  <h3>{c.id}</h3>
                  <p>{c.label}</p>
                </div>
                <Badge tone={c.approved ? "ok" : "warn"}>{c.approved ? "已审批" : "未审批"}</Badge>
              </div>
              <p className="dim">生效 {fmtClock(c.issuedAt)}</p>
              <div className="thr-grid">
                {Object.entries(c.thresholds).map(([iso, v]) => (
                  <span key={iso}>
                    {iso}: 0.5µm≤{v["0.5um"]} / 5µm≤{v["5um"]}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>
        <div className="btn-row">
          <button className="primary-action" onClick={publishNewCalibration}>
            发布 CAL-2026Q4（ISO5 的 0.5µm 阈值 3520→4200）
          </button>
        </div>
        <p className="dim hint">
          发布后：未审批单立即失效并按新阈值重算（合格单不再超限）；已确认单冻结，保留当时阈值与校准编号。
        </p>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">影响预览</p>
            <h2>处理单状态</h2>
          </div>
        </div>
        <div className="stack">
          {tickets.map((t) => (
            <article className={`card tone-${ticketTone(t)}`} key={t.id}>
              <div className="card-head">
                <strong>{t.id}</strong>
                <Badge tone={ticketTone(t)}>{ticketLabel(t)}</Badge>
              </div>
              <p className="dim">
                依据 {t.basis?.calibrationId ?? "—"} ·{" "}
                {t.basis?.exceeded ? "超限" : t.basis ? "合格" : "待核"}
              </p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function LogsTab() {
  const logs = useStore((s) => s.logs);
  const outbox = useStore((s) => s.outbox);
  const handovers = useStore((s) => s.handovers);
  return (
    <div className="tab-grid">
      <section className="panel">
        <h2>操作 / 同步日志</h2>
        <div className="logs">
          {logs.map((l, i) => (
            <p key={i} className={`log-line log-${l.level}`}>
              <span className="dim">{fmtTime(l.at)}</span> {l.message}
            </p>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>出站操作队列（幂等键）</h2>
        <div className="logs">
          {outbox.length === 0 && <p className="dim">空</p>}
          {outbox.map((op) => (
            <p key={op.id} className={`log-line ${op.status === "acked" ? "log-ok" : "log-warn"}`}>
              <span className="dim">{op.type}</span> {op.entityId} · tries {op.tries} · {op.status}
            </p>
          ))}
        </div>
        <h2>交接批次检查点</h2>
        <div className="logs">
          {handovers.map((h) => (
            <p key={h.id} className="log-line">
              {h.status === "complete" ? "✅" : "🔧"} {h.id} · {h.shiftLabel} · 检查点{" "}
              {h.checkpointAt ? fmtClock(h.checkpointAt) : "未建立"}
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}

function toLocalInput(t: number) {
  const d = new Date(t - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function App() {
  const ready = useStore((s) => s.ready);
  const online = useStore((s) => s.online);
  const syncing = useStore((s) => s.syncing);
  const recovery = useStore((s) => s.recovery);
  const ticketCount = useStore((s) => s.tickets.length);
  const pendingCount = useStore((s) => s.tickets.filter((t) => t.status === "pending").length);
  const verifyCount = useStore((s) => s.tickets.filter((t) => t.status !== "confirmed" && !t.basis).length);
  const conflictCount = useConflictViews().length;
  const [tab, setTab] = useState<Tab>("inspect");

  useEffect(() => {
    void boot();
  }, []);

  if (!ready) {
    return <main className="app-shell"><p className="loading">正在打开本地库并恢复交接批次…</p></main>;
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-09 · 断网续作 / 合并 / 校准换批 / 崩溃恢复</p>
          <h1>半导体洁净室巡检</h1>
          <p className="subtitle">
            巡检员在无网洁净室记录粒子计数，回办公区与复核员合并整理：双份原始值保留并按
            <b> 现场封条时间</b> 定先后；校准换批后未审批结论失效重算、已确认单冻结依据；崩溃只补未完成项，
            重复提交幂等不多单；旧记录缺校准编号先待核。
          </p>
        </div>
        <div className="stack-card">
          <span>连接状态</span>
          <strong className={online ? "net-on" : "net-off"}>{online ? "● 已连接" : "○ 断网模式"}</strong>
          <div className="btn-row">
            <button onClick={() => setOnline(!online)}>{online ? "断开网络" : "恢复网络"}</button>
            <button className="primary-action" onClick={() => void syncNow()} disabled={!online || syncing}>
              {syncing ? "同步中…" : "立即同步合并"}
            </button>
          </div>
          <div className="btn-row">
            <button onClick={crashAndReload}>💥 模拟浏览器崩溃</button>
            <button onClick={resetDemo}>重置演示数据</button>
          </div>
        </div>
      </section>

      {recovery && (
        <section className="recovery-banner">
          <b>崩溃恢复：</b> 从最近完整交接批次 {recovery.lastCompleteHandoverId ?? "（无）"}
          （{recovery.lastCompleteAt ? fmtClock(recovery.lastCompleteAt) : "—"}）恢复；
          重放未确认操作 {recovery.replayedOpIds.length} 条（幂等，不会多出处理单）；
          未完成项：进行中批次 {recovery.openHandoverId ?? "无"} 内 {recovery.unfinishedRecordIds.length} 条记录。
        </section>
      )}

      <section className="metrics-grid">
        <article className="metric-card"><span>处理单总数</span><strong>{ticketCount}</strong><i className="status-ok" /></article>
        <article className="metric-card"><span>未审批</span><strong>{pendingCount}</strong><i className="status-watch" /></article>
        <article className="metric-card"><span>待核（缺校准编号）</span><strong>{verifyCount}</strong><i className="status-danger" /></article>
        <article className="metric-card"><span>双记录冲突组</span><strong>{conflictCount}</strong><i className="status-danger" /></article>
      </section>

      <nav className="tabs">
        {([
          ["inspect", "巡检录入 / 冲突"],
          ["review", "复核处理单"],
          ["calib", "校准批次"],
          ["logs", "日志 / 队列"],
        ] as [Tab, string][]).map(([key, label]) => (
          <button key={key} className={tab === key ? "tab active" : "tab"} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === "inspect" && <InspectTab />}
      {tab === "review" && <ReviewTab />}
      {tab === "calib" && <CalibTab />}
      {tab === "logs" && <LogsTab />}
    </main>
  );
}

export default App;
