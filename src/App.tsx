import { useEffect, useReducer, useState } from "react";
import type { ReactNode } from "react";
import "./styles.css";
import {
  DEFAULT_THRESHOLDS,
  activeCalibration,
  conflictGroups,
  fmtNum,
  groupNeedsReview,
  suggestedPick,
} from "./domain/core";
import { getStore, simulateRemoteUpload } from "./domain/store";
import type {
  CalibrationBatch,
  CalibrationReport,
  InspectionRecord,
  IsoClass,
  RecoveryReport,
  SyncReport,
  TicketStatus,
} from "./domain/types";

const store = getStore();

function useStoreVersion(): number {
  const [version, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => store.subscribe(force), []);
  return version;
}

const ROOMS: { id: string; iso: IsoClass }[] = [
  { id: "CR-1201", iso: "ISO 5" },
  { id: "CR-2107", iso: "ISO 6" },
  { id: "Y-0302", iso: "ISO 7" },
  { id: "CR-3305", iso: "ISO 7" },
];

const REVIEWERS = ["林岚 · 复核员", "赵衡 · 班组长", "陈工 · 厂务工程师"];

const TICKET_STATUS: Record<TicketStatus, { label: string; cls: string }> = {
  pending: { label: "待审批", cls: "b-warn" },
  confirmed: { label: "已确认", cls: "b-ok" },
  invalidated: { label: "已失效", cls: "b-muted" },
  pendingVerification: { label: "待核", cls: "b-info" },
};

const pad2 = (n: number) => String(n).padStart(2, "0");

function nowLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function shiftMinutes(ts: string, delta: number): string {
  const d = new Date(ts);
  d.setMinutes(d.getMinutes() + delta);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function slotOptions(): string[] {
  const out: string[] = [];
  for (let d = 0; d < 3; d += 1) {
    const date = new Date(Date.now() - d * 86400000);
    const s = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    out.push(`${s} · 夜班`, `${s} · 白班`);
  }
  return out;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function Badge({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`badge ${cls}`}>{children}</span>;
}

function thresholdText(t: { particle05: number; tempMin: number; tempMax: number; humidityMin: number; humidityMax: number; pressureMin: number }): string {
  return `粒子≤${fmtNum(t.particle05)} · 温度${t.tempMin}~${t.tempMax}℃ · 湿度${t.humidityMin}~${t.humidityMax}% · 压差≥${t.pressureMin}Pa`;
}

// ---------------------------------------------------------------------------
// 巡检记录
// ---------------------------------------------------------------------------

function recordBadges(rec: InspectionRecord): { label: string; cls: string }[] {
  const s = store.state;
  const out: { label: string; cls: string }[] = [];
  if (!rec.synced) out.push({ label: "待同步", cls: "b-info" });
  if (rec.calibrationId == null) out.push({ label: "待核", cls: "b-info" });
  if (rec.supersededBy) out.push({ label: `未选用`, cls: "b-muted" });
  if (rec.chosen) out.push({ label: "已选用", cls: "b-ok" });
  if (rec.conflictGroupId) {
    const members = s.records.filter((r) => r.conflictGroupId === rec.conflictGroupId);
    if (groupNeedsReview(members)) out.push({ label: "冲突待复核", cls: "b-warn" });
  }
  const ticket = [...s.tickets].reverse().find((t) => t.recordId === rec.id && t.status !== "invalidated");
  if (rec.calibrationId != null) {
    if (ticket?.status === "pending") out.push({ label: "异常·待审批", cls: "b-warn" });
    else if (ticket?.status === "confirmed") out.push({ label: "异常·已确认", cls: "b-ok" });
    else out.push({ label: "正常", cls: "b-ok" });
  }
  return out;
}

function RecordsTab({ online, notify }: { online: boolean; notify: (m: string) => void }) {
  const s = store.state;
  const [draftId, setDraftId] = useState(() => uid("R"));
  const [roomId, setRoomId] = useState(ROOMS[0].id);
  const [slot, setSlot] = useState(slotOptions()[0]);
  const [particle, setParticle] = useState("3500");
  const [temp, setTemp] = useState("22.0");
  const [humidity, setHumidity] = useState("45");
  const [pressure, setPressure] = useState("12");
  const [sealTime, setSealTime] = useState(nowLocal());
  const [note, setNote] = useState("");

  const room = ROOMS.find((r) => r.id === roomId) ?? ROOMS[0];

  const submit = () => {
    const rec: InspectionRecord = {
      id: draftId,
      roomId: room.id,
      isoClass: room.iso,
      slot,
      particle05: Number(particle) || 0,
      temperature: Number(temp) || 0,
      humidity: Number(humidity) || 0,
      pressure: Number(pressure) || 0,
      sealTime,
      createdAt: nowLocal(),
      origin: "local",
      synced: false, // 一律先落本地，恢复连接后随同步推出
      calibrationId: activeCalibration(s).id,
      note,
      conflictGroupId: null,
      chosen: false,
      supersededBy: null,
    };
    const res = store.dispatch("addRecord", rec, `op:addRecord:${rec.id}`, `录入 ${rec.roomId} ${rec.slot}`);
    if (!res.applied) {
      notify(`记录 ${rec.id} 重复提交已被幂等去重，未产生新记录和处理单`);
      return;
    }
    const ticketId = (res.result as { ticketId: string | null } | undefined)?.ticketId;
    let msg = online
      ? "已录入"
      : "已离线录入本地，恢复连接后自动合并";
    if (ticketId) msg += `，检出异常并生成处理单 ${ticketId}`;
    else msg += "，结论正常";
    if (online) {
      const rep = store.sync();
      msg += `（在线：已同步，推送 ${rep.pushed} 拉取 ${rep.pulled}）`;
    }
    notify(msg);
    setDraftId(uid("R"));
    setNote("");
  };

  const records = [...s.records].sort((a, b) => b.sealTime.localeCompare(a.sealTime));

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>断网可续作 · 本地先落库</p>
          <h2>巡检记录录入</h2>
        </div>
        <Badge cls={online ? "b-ok" : "b-warn"}>{online ? "在线" : "断网（洁净室模式）"}</Badge>
      </div>
      <div className="field-grid">
        <label>
          <span>房间编号</span>
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            {ROOMS.map((r) => (
              <option key={r.id} value={r.id}>{r.id}（{r.iso}）</option>
            ))}
          </select>
        </label>
        <label>
          <span>时段</span>
          <select value={slot} onChange={(e) => setSlot(e.target.value)}>
            {slotOptions().map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </label>
        <label>
          <span>0.5µm粒子计数（个/m³）</span>
          <input value={particle} onChange={(e) => setParticle(e.target.value)} inputMode="numeric" />
        </label>
        <label>
          <span>温度 ℃</span>
          <input value={temp} onChange={(e) => setTemp(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>湿度 %</span>
          <input value={humidity} onChange={(e) => setHumidity(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>压差 Pa</span>
          <input value={pressure} onChange={(e) => setPressure(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>现场封条时间</span>
          <input type="datetime-local" value={sealTime} onChange={(e) => setSealTime(e.target.value)} />
        </label>
        <label>
          <span>处理备注</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="选填" />
        </label>
      </div>
      <div className="actions-row">
        <button className="primary-action" onClick={submit}>提交记录（{online ? "在线" : "离线"}）</button>
        <span className="hint">重复点击/断网重试不会生成重复处理单</span>
      </div>

      <h3 className="list-title">全部记录（原始值永久保留）</h3>
      <div className="record-list">
        {records.map((rec) => (
          <article key={rec.id} className="record-card">
            <div className="record-index">{rec.roomId.slice(0, 2)}</div>
            <div>
              <h3>
                {rec.roomId} · {rec.slot}
                {recordBadges(rec).map((b) => (
                  <Badge key={b.label} cls={b.cls}>{b.label}</Badge>
                ))}
              </h3>
              <p>
                粒子 {fmtNum(rec.particle05)} · {rec.temperature}℃ · {rec.humidity}% · {rec.pressure}Pa
                ｜ 封条 {rec.sealTime.replace("T", " ")} ｜ 创建 {rec.createdAt.replace("T", " ")}
                ｜ {rec.origin === "local" ? "本机" : "对端"} ｜ 校准 {rec.calibrationId ?? "缺失"}
                {rec.note ? ` ｜ ${rec.note}` : ""}
              </p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 冲突复核
// ---------------------------------------------------------------------------

const COMPARE_FIELDS: { key: keyof InspectionRecord; label: string }[] = [
  { key: "particle05", label: "0.5µm粒子" },
  { key: "temperature", label: "温度℃" },
  { key: "humidity", label: "湿度%" },
  { key: "pressure", label: "压差Pa" },
  { key: "sealTime", label: "现场封条时间" },
  { key: "createdAt", label: "上传/创建时间" },
];

function ConflictCard({ members, notify }: { members: InspectionRecord[]; notify: (m: string) => void }) {
  const sorted = [...members].sort((a, b) => a.sealTime.localeCompare(b.sealTime));
  const suggested = suggestedPick(members);
  const needsReview = groupNeedsReview(members);
  const [chosenId, setChosenId] = useState(suggested.id);
  const [reviewer, setReviewer] = useState(REVIEWERS[0]);
  const gid = members[0].conflictGroupId ?? "";

  const resolve = () => {
    const res = store.dispatch(
      "resolveConflict",
      { groupId: gid, chosenId, reviewer },
      `op:resolve:${gid}:${chosenId}`,
      `复核 ${members[0].roomId} ${members[0].slot}：选用 ${chosenId}`
    );
    notify(
      res.applied
        ? `已按现场封条时间选用 ${chosenId}，另一份原始值保留、其待审批结论作废`
        : "该复核结论已提交过，重复操作被去重"
    );
  };

  return (
    <article className={`conflict-card ${needsReview ? "" : "resolved"}`}>
      <div className="section-heading">
        <div>
          <p>{gid}</p>
          <h3>{members[0].roomId} · {members[0].slot} · {members.length} 份记录</h3>
        </div>
        {needsReview ? <Badge cls="b-warn">待复核</Badge> : <Badge cls="b-ok">已复核</Badge>}
      </div>
      <table className="compare">
        <thead>
          <tr>
            <th>字段</th>
            {sorted.map((m) => (
              <th key={m.id}>
                {needsReview ? (
                  <label className="pick">
                    <input
                      type="radio"
                      name={gid}
                      checked={chosenId === m.id}
                      onChange={() => setChosenId(m.id)}
                    />
                    选用 {m.id}
                  </label>
                ) : (
                  <span>{m.id}{m.chosen ? " ✓选用" : "（未选用）"}</span>
                )}
                {m.id === suggested.id && needsReview && <em className="suggest">建议：封条最早</em>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARE_FIELDS.map((f) => (
            <tr key={f.key}>
              <td>{f.label}</td>
              {sorted.map((m) => {
                const v = String(m[f.key]);
                const diff = m.id !== suggested.id && v !== String(suggested[f.key]);
                return (
                  <td key={m.id} className={diff ? "diff" : ""}>
                    {f.key === "particle05" ? fmtNum(m.particle05) : v.replace("T", " ")}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr>
            <td>来源</td>
            {sorted.map((m) => (
              <td key={m.id}>{m.origin === "local" ? "本机" : "对端"}</td>
            ))}
          </tr>
        </tbody>
      </table>
      {needsReview && (
        <div className="actions-row">
          <select value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
            {REVIEWERS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <button className="primary-action" onClick={resolve}>确认选用</button>
          <span className="hint">按现场封条时间定先后；后上传的记录不能盖掉先封条的记录</span>
        </div>
      )}
    </article>
  );
}

function ConflictsTab({ notify }: { notify: (m: string) => void }) {
  const groups = conflictGroups(store.state);
  if (groups.length === 0) {
    return <section className="panel"><h2>冲突复核</h2><p className="hint">暂无同房间同时段的多份记录。</p></section>;
  }
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>两份原始值都保留 · 差异已标红</p>
          <h2>冲突复核</h2>
        </div>
      </div>
      {groups.map((members) => (
        <ConflictCard key={members[0].conflictGroupId} members={members} notify={notify} />
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 异常处理单
// ---------------------------------------------------------------------------

function TicketsTab({ notify }: { notify: (m: string) => void }) {
  const s = store.state;
  const [filter, setFilter] = useState<TicketStatus | "all">("all");
  const [reviewer, setReviewer] = useState(REVIEWERS[0]);
  const tickets = [...s.tickets]
    .filter((t) => filter === "all" || t.status === filter)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const approve = (ticketId: string) => {
    const res = store.dispatch(
      "approveTicket",
      { ticketId, reviewer },
      `op:approve:${ticketId}`,
      `审批确认 ${ticketId}`
    );
    notify(
      res.applied
        ? `处理单 ${ticketId} 已确认，冻结当时阈值与校准编号`
        : "该单当前状态不可审批（待核/已失效/已确认），操作被跳过"
    );
  };

  const filters: { id: TicketStatus | "all"; label: string }[] = [
    { id: "all", label: "全部" },
    { id: "pending", label: "待审批" },
    { id: "confirmed", label: "已确认" },
    { id: "invalidated", label: "已失效" },
    { id: "pendingVerification", label: "待核" },
  ];

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>确认后冻结阈值快照与校准编号</p>
          <h2>异常处理单</h2>
        </div>
        <label className="inline-label">
          审批人
          <select value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
            {REVIEWERS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="chips">
        {filters.map((f) => (
          <button key={f.id} className={filter === f.id ? "chip-active" : ""} onClick={() => setFilter(f.id)}>
            {f.label}（{f.id === "all" ? s.tickets.length : s.tickets.filter((t) => t.status === f.id).length}）
          </button>
        ))}
      </div>
      <div className="record-list">
        {tickets.length === 0 && <p className="hint">该状态下暂无处理单。</p>}
        {tickets.map((t) => {
          const st = TICKET_STATUS[t.status];
          return (
            <article key={t.id} className="record-card">
              <div className="record-index">{t.roomId.slice(0, 2)}</div>
              <div>
                <h3>
                  {t.roomId} · {t.slot} <Badge cls={st.cls}>{st.label}</Badge>
                </h3>
                <p className="mono">{t.id}</p>
                <ul className="violations">
                  {t.violations.map((v) => (
                    <li key={v}>{v}</li>
                  ))}
                </ul>
                <p>
                  {t.thresholdSnapshot ? `阈值快照：${thresholdText(t.thresholdSnapshot)}` : "无阈值快照（缺校准编号）"}
                  {t.calibrationId ? ` ｜ 校准批次 ${t.calibrationId}` : ""}
                </p>
                {t.status === "confirmed" && (
                  <p className="hint">已确认 · {t.confirmedBy} · {t.confirmedAt?.replace("T", " ")} —— 保留当时阈值与校准编号，校准变更不影响本单</p>
                )}
                {t.status === "invalidated" && <p className="hint">失效原因：{t.invalidatedReason}</p>}
                {t.status === "pendingVerification" && <p className="hint">旧记录缺校准编号，先待核，不参加新审批</p>}
                {t.status === "pending" && (
                  <div className="actions-row">
                    <button className="primary-action" onClick={() => approve(t.id)}>审批确认</button>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 校准批次
// ---------------------------------------------------------------------------

function CalibrationTab({ notify }: { notify: (m: string) => void }) {
  const s = store.state;
  const [deviceId, setDeviceId] = useState("PC-3100");
  const [preset, setPreset] = useState("standard");
  const [report, setReport] = useState<CalibrationReport | null>(null);

  const activate = () => {
    const factor = preset === "tight" ? 0.8 : preset === "loose" ? 1.25 : 1;
    const thresholds = Object.fromEntries(
      Object.entries(DEFAULT_THRESHOLDS).map(([k, t]) => [
        k,
        { ...t, particle05: Math.round(t.particle05 * factor) },
      ])
    ) as CalibrationBatch["thresholds"];
    const batch: CalibrationBatch = {
      id: `CAL-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${String(s.calibrations.length + 1).padStart(2, "0")}`,
      deviceId,
      activatedAt: nowLocal(),
      status: "active",
      thresholds,
    };
    const res = store.dispatch(
      "activateCalibration",
      { batch },
      `op:cal:${batch.id}`,
      `启用校准批次 ${batch.id}`
    );
    if (res.applied) {
      const r = res.result as CalibrationReport;
      setReport(r);
      notify(
        `校准批次 ${r.batchId} 已启用：未审批失效 ${r.invalidated} · 重算仍异常 ${r.recomputed} · 转正常 ${r.cleared} · 新检出 ${r.newDetected} · 保留已确认 ${r.keptConfirmed} · 待核除外 ${r.pendingVerification}`
      );
    } else {
      notify("该校准批次已启用过，重复提交被去重");
    }
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>批次变更 → 未审批结论失效重算</p>
          <h2>设备校准批次</h2>
        </div>
      </div>
      <div className="record-list">
        {[...s.calibrations].reverse().map((c) => (
          <article key={c.id} className="record-card">
            <div className="record-index">{c.status === "active" ? "用" : "旧"}</div>
            <div>
              <h3>
                {c.id} <Badge cls={c.status === "active" ? "b-ok" : "b-muted"}>{c.status === "active" ? "使用中" : "已替换"}</Badge>
              </h3>
              <p>设备 {c.deviceId} ｜ 启用 {c.activatedAt.replace("T", " ")} ｜ ISO5 {thresholdText(c.thresholds["ISO 5"])}</p>
            </div>
          </article>
        ))}
      </div>
      <h3 className="list-title">启用新校准批次</h3>
      <div className="field-grid">
        <label>
          <span>设备编号</span>
          <input value={deviceId} onChange={(e) => setDeviceId(e.target.value)} />
        </label>
        <label>
          <span>阈值方案</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="standard">标准阈值（ISO 14644-1）</option>
            <option value="tight">收紧 20%</option>
            <option value="loose">放宽 25%</option>
          </select>
        </label>
      </div>
      <div className="actions-row">
        <button className="primary-action" onClick={activate}>启用新批次并重算</button>
        <span className="hint">已确认处理单保留当时阈值与校准编号；缺校准编号的旧记录不参与</span>
      </div>
      {report && (
        <div className="report-box">
          <strong>重算报告 · {report.batchId}</strong>
          <ul>
            <li>未审批结论失效：{report.invalidated} 单</li>
            <li>重算后仍为异常：{report.recomputed} 单（已生成新处理单）</li>
            <li>重算后转为正常：{report.cleared} 单</li>
            <li>新批次下新检出异常：{report.newDetected} 单</li>
            <li>保留不动的已确认处理单：{report.keptConfirmed} 单</li>
            <li>缺校准编号待核、排除在审批外：{report.pendingVerification} 条</li>
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 交接与同步
// ---------------------------------------------------------------------------

function SyncTab({
  online,
  setOnline,
  notify,
}: {
  online: boolean;
  setOnline: (v: boolean) => void;
  notify: (m: string) => void;
}) {
  const s = store.state;
  const [syncReport, setSyncReport] = useState<SyncReport | null>(null);

  const doSync = () => {
    const rep = store.sync();
    setSyncReport(rep);
    notify(`合并完成：推送 ${rep.pushed} 条，拉取 ${rep.pulled} 条，当前待复核冲突 ${rep.openConflicts} 组`);
  };

  const remoteUpload = () => {
    const latest = [...s.records].sort((a, b) => b.sealTime.localeCompare(a.sealTime))[0];
    if (!latest) return;
    const rec: InspectionRecord = {
      id: uid("R-REM"),
      roomId: latest.roomId,
      isoClass: latest.isoClass,
      slot: latest.slot,
      particle05: Math.max(0, Math.round(latest.particle05 * (0.55 + Math.random() * 0.8))),
      temperature: Math.round((latest.temperature + (Math.random() - 0.5)) * 10) / 10,
      humidity: Math.round(latest.humidity + (Math.random() - 0.5) * 4),
      pressure: latest.pressure,
      sealTime: shiftMinutes(latest.sealTime, -8), // 封条更早
      createdAt: nowLocal(), // 但上传更晚
      origin: "remote",
      synced: true,
      calibrationId: activeCalibration(s).id,
      note: "对端终端补录（模拟）",
      conflictGroupId: null,
      chosen: false,
      supersededBy: null,
    };
    simulateRemoteUpload(rec);
    notify(`对端已上传 ${rec.roomId} ${rec.slot} 的记录（封条 ${rec.sealTime.replace("T", " ")}，比本机更早）。恢复连接合并后进入冲突复核`);
  };

  const seal = () => {
    const b = store.sealHandoff();
    notify(b ? `交接批次 ${b.id} 已封存（${b.opCount} 项操作），成为崩溃恢复的最近完整点` : "当前没有进行中的交接批次");
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>断网续作 · 恢复连接时合并</p>
          <h2>交接与同步</h2>
        </div>
        <Badge cls={online ? "b-ok" : "b-warn"}>{online ? "在线" : "断网（洁净室模式）"}</Badge>
      </div>

      <div className="sync-grid">
        <div className="sync-card">
          <h3>连接与合并</h3>
          <p>待同步记录 {s.outbox.length} 条 ｜ 最近同步 {s.lastSyncAt ? s.lastSyncAt.replace("T", " ").slice(0, 19) : "从未"}</p>
          <div className="actions-row">
            <button onClick={() => setOnline(!online)}>{online ? "切换为断网" : "切换为在线"}</button>
            <button className="primary-action" disabled={!online} onClick={doSync}>恢复连接并合并</button>
            <button onClick={remoteUpload}>模拟对端上传</button>
          </div>
          {syncReport && (
            <p className="hint">上次合并：推送 {syncReport.pushed} · 拉取 {syncReport.pulled} · 待复核冲突 {syncReport.openConflicts} 组</p>
          )}
        </div>

        <div className="sync-card">
          <h3>交接批次与崩溃恢复</h3>
          <p>崩溃后从最近完整交接批次恢复，只补未完成项，重复操作幂等跳过。</p>
          <div className="actions-row">
            <button onClick={seal}>封存当前交接批次</button>
            <button
              className="danger-action"
              onClick={() => {
                if (window.confirm("模拟浏览器崩溃：页面将刷新，并从最近完整交接批次恢复")) {
                  store.simulateCrash();
                }
              }}
            >
              模拟浏览器崩溃
            </button>
          </div>
        </div>
      </div>

      <h3 className="list-title">交接批次</h3>
      <table className="compare">
        <thead>
          <tr><th>批次</th><th>开始</th><th>封存</th><th>操作数</th><th>状态</th></tr>
        </thead>
        <tbody>
          {[...store.batches].reverse().map((b) => (
            <tr key={b.id}>
              <td className="mono">{b.id}</td>
              <td>{b.openedAt.replace("T", " ").slice(0, 19)}</td>
              <td>{b.sealedAt ? b.sealedAt.replace("T", " ").slice(0, 19) : "—"}</td>
              <td>{b.opCount}</td>
              <td>{b.sealedAt ? <Badge cls="b-ok">已封存</Badge> : <Badge cls="b-warn">进行中</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="list-title">操作日志（最近 10 条，含被幂等去重的重复提交）</h3>
      <div className="ops-log">
        {[...store.ops].slice(-10).reverse().map((op) => (
          <div key={`${op.idemKey}-${op.appliedAt}`} className="op-row">
            <Badge cls={op.applied ? "b-ok" : "b-muted"}>{op.applied ? "已应用" : "重复·跳过"}</Badge>
            <span className="mono">{op.batchId}</span>
            <span>{op.summary}</span>
            <span className="hint">{op.appliedAt.replace("T", " ").slice(0, 19)}</span>
          </div>
        ))}
        {store.ops.length === 0 && <p className="hint">暂无操作。</p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 主框架
// ---------------------------------------------------------------------------

const TABS = [
  { id: "records", label: "巡检记录" },
  { id: "conflicts", label: "冲突复核" },
  { id: "tickets", label: "异常处理单" },
  { id: "calibration", label: "校准批次" },
  { id: "sync", label: "交接与同步" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function RecoveryBanner({ recovery }: { recovery: RecoveryReport }) {
  return (
    <div className="banner">
      <strong>崩溃恢复完成</strong>
      <span>
        从最近完整交接批次 {recovery.recoveredFromBatchId ?? "（无，使用初始快照）"} 恢复：
        重放已提交操作 {recovery.replayedOps} 项，幂等跳过重复 {recovery.skippedDuplicates} 项，
        补做未完成项 {recovery.completedItems.length} 项。
      </span>
      {recovery.completedItems.length > 0 && (
        <ul>
          {recovery.completedItems.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function App() {
  useStoreVersion();
  const s = store.state;
  const [tab, setTab] = useState<TabId>("records");
  const [online, setOnline] = useState(false); // 默认断网：洁净室无网场景
  const [notice, setNotice] = useState("");

  const openConflicts = conflictGroups(s).filter(groupNeedsReview).length;
  const pendingTickets = s.tickets.filter((t) => t.status === "pending").length;
  const pendingVerification = s.tickets.filter((t) => t.status === "pendingVerification").length;

  const metrics = [
    { label: "待同步记录", value: s.outbox.length, cls: "status-ok" },
    { label: "冲突待复核", value: openConflicts, cls: "status-watch" },
    { label: "待审批处理单", value: pendingTickets, cls: "status-watch" },
    { label: "待核旧记录", value: pendingVerification, cls: "status-danger" },
  ];

  const tabCount: Record<TabId, number> = {
    records: s.records.length,
    conflicts: openConflicts,
    tickets: pendingTickets,
    calibration: s.calibrations.length,
    sync: s.outbox.length,
  };

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-09 · 断网续作 / 合并 / 校准重算 / 崩溃恢复</p>
          <h1>半导体洁净室巡检</h1>
          <p className="subtitle">
            夜班巡检员在无网洁净室离线录入粒子计数，回办公区恢复连接后与对端合并；
            同房间同时段的两份记录都保留原始值并标出差异，复核员按现场封条时间选用；
            校准批次变更后未审批结论失效重算，已确认处理单保留当时阈值与校准编号。
          </p>
        </div>
        <div className="stack-card">
          <span>连接状态</span>
          <strong>{online ? "在线（办公区）" : "断网（洁净室）"}</strong>
          <span>所有操作先落本地操作日志，恢复连接后合并</span>
        </div>
      </section>

      <section className="metrics-grid">
        {metrics.map((m) => (
          <article key={m.label} className="metric-card">
            <span>{m.label}</span>
            <strong>{m.value}</strong>
            <i className={m.cls} />
          </article>
        ))}
      </section>

      {store.recovery && <RecoveryBanner recovery={store.recovery} />}
      {notice && <div className="notice" onClick={() => setNotice("")}>{notice}</div>}

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
            {tabCount[t.id] > 0 && <span className="count">{tabCount[t.id]}</span>}
          </button>
        ))}
      </nav>

      {tab === "records" && <RecordsTab online={online} notify={setNotice} />}
      {tab === "conflicts" && <ConflictsTab notify={setNotice} />}
      {tab === "tickets" && <TicketsTab notify={setNotice} />}
      {tab === "calibration" && <CalibrationTab notify={setNotice} />}
      {tab === "sync" && <SyncTab online={online} setOnline={setOnline} notify={setNotice} />}
    </main>
  );
}
