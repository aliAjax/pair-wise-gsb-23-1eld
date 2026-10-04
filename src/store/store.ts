import { useSyncExternalStore } from "react";
import type {
  CalibrationBatch,
  ConflictResolution,
  ExceptionTicket,
  HandoverBatch,
  InspectionRecord,
  ISOClass,
  OutboxOp,
  ParticleCounts,
  RecoveryReport,
  SyncLogEntry,
  TicketEvent,
} from "../domain/types";
import {
  DEVICE_ID,
  activeCalibrationAt,
  buildConflictViews,
  conflictIdOf,
  confirmTicket as confirmTicketLogic,
  latestCalibration,
  mergeByVersion,
  mergeRecord,
  mergeTicket,
  periodKeyOf,
  planRecovery,
  refreshTicket,
  resolutionIdOf,
  seedThresholds,
  ticketIdOf,
  ticketSig,
} from "../domain/logic";
import { idbBulkPut, idbClear, idbGetAll, idbPut, StoreName } from "./idb";
import {
  ApplyResult,
  EntityKind,
  loadServerState,
  PullChunk,
  resetServerState,
  saveServerState,
  serverApply,
  serverPull,
  serverSeedUpsert,
} from "./mockServer";

export interface AppState {
  ready: boolean;
  online: boolean;
  syncing: boolean;
  cursor: number;
  records: InspectionRecord[];
  tickets: ExceptionTicket[];
  calibrations: CalibrationBatch[];
  resolutions: ConflictResolution[];
  handovers: HandoverBatch[];
  outbox: OutboxOp[];
  logs: SyncLogEntry[];
  recovery: RecoveryReport | null;
  openHandoverId: string | null;
}

export const ROOMS: { id: string; iso: ISOClass }[] = [
  { id: "CR-1201", iso: "ISO 5" },
  { id: "CR-2107", iso: "ISO 6" },
  { id: "CR-3305", iso: "ISO 7" },
  { id: "Y-0302", iso: "黄光区" },
];

const SEED_KEY = "cleanroom-seed-v1";

let state: AppState = {
  ready: false,
  online: true,
  syncing: false,
  cursor: 0,
  records: [],
  tickets: [],
  calibrations: [],
  resolutions: [],
  handovers: [],
  outbox: [],
  logs: [],
  recovery: null,
  openHandoverId: null,
};

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
function setState(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  emit();
}

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function getState() {
  return state;
}
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

// ---------- 工具 ----------

const uuid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function log(message: string, level: SyncLogEntry["level"] = "info") {
  const entry = { at: Date.now(), level, message };
  setState({ logs: [entry, ...state.logs].slice(0, 80) });
}

function bump<T extends { version: number; updatedAt: number }>(entity: T): T {
  return { ...entity, version: entity.version + 1, updatedAt: Date.now() };
}

const STORE_OF: Record<string, StoreName> = {
  records: "records",
  tickets: "tickets",
  calibrations: "calibrations",
  resolutions: "resolutions",
  handovers: "handovers",
  outbox: "outbox",
};

async function persist(kind: "records" | "tickets" | "calibrations" | "resolutions" | "handovers" | "outbox", entity: { id: string }) {
  await idbPut(STORE_OF[kind], entity);
}

function enqueueOp(
  type: OutboxOp["type"],
  entity: { id: string },
  opId?: string,
): OutboxOp {
  const op: OutboxOp = {
    id: opId ?? uuid(),
    type,
    entityId: entity.id,
    payload: JSON.parse(JSON.stringify(entity)),
    createdAt: Date.now(),
    status: "queued",
    tries: 0,
  };
  // 相同幂等键（如崩溃重放/双击）只保留一条操作
  if (state.outbox.some((x) => x.id === op.id)) {
    return state.outbox.find((x) => x.id === op.id)!;
  }
  const outbox = [...state.outbox, op];
  setState({ outbox });
  void persist("outbox", op);
  return op;
}

function findRecord(id: string) {
  return state.records.find((r) => r.id === id);
}

// ---------- 本地对账：冲突视图由记录派生；处理单随校准/选用结果重算 ----------

/**
 * 在任何录入或 pull 合并后运行：
 * - 同房间同时段多份记录 => 冲突视图（原始值全部保留）；
 * - 每组对应一张确定性编号处理单；缺校准编号 => 待核；
 * - 未审批单按最新批次重算，已确认单冻结；
 * - 内容签名不变就不产生新版本/新操作（重复提交不多出单）。
 */
function reconcile() {
  const now = Date.now();
  const tickets = [...state.tickets];
  const newOps: OutboxOp[] = [];
  const touchedTickets: ExceptionTicket[] = [];

  const groups = new Map<string, InspectionRecord[]>();
  for (const r of state.records) {
    if (r.deleted) continue;
    const key = `${r.roomId}|${r.periodKey}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  for (const groupRecords of groups.values()) {
    const roomId = groupRecords[0].roomId;
    const periodKey = groupRecords[0].periodKey;
    const id = ticketIdOf(roomId, periodKey);
    const idx = tickets.findIndex((t) => t.id === id);
    let ticket =
      idx >= 0
        ? tickets[idx]
        : {
            id,
            roomId,
            periodKey,
            status: "pending" as const,
            recordId: null,
            basis: null,
            conclusion: null,
            handler: null,
            confirmedAt: null,
            history: [] as TicketEvent[],
            sig: null,
            version: 0,
            updatedAt: now,
          };

    const beforeSig = ticketSig(ticket);
    const refreshed =
      refreshTicket(ticket, state.records, state.calibrations, state.resolutions, DEVICE_ID, now) ??
      ticket;
    const afterSig = ticketSig(refreshed);

    // 新单仅当“超限”或“记录缺校准编号（待核）”时才建立
    const chosenId = refreshed.recordId;
    const chosen = groupRecords.find((r) => r.id === chosenId);
    const needsTicket =
      idx >= 0 || refreshed.basis?.exceeded === true || chosen?.calibrationId == null;
    if (!needsTicket) continue;

    if (idx < 0) {
      tickets.push(refreshed);
      touchedTickets.push(refreshed);
      newOps.push({
        id: uuid(),
        type: "upsertTicket",
        entityId: refreshed.id,
        payload: JSON.parse(JSON.stringify(refreshed)),
        createdAt: now,
        status: "queued",
        tries: 0,
      });
    } else if (afterSig !== beforeSig) {
      const next = bump(refreshed);
      tickets[idx] = next;
      touchedTickets.push(next);
      newOps.push({
        id: uuid(),
        type: "upsertTicket",
        entityId: next.id,
        payload: JSON.parse(JSON.stringify(next)),
        createdAt: now,
        status: "queued",
        tries: 0,
      });
    }
  }

  if (touchedTickets.length === 0) return;
  const outbox = [...state.outbox, ...newOps];
  setState({ tickets, outbox });
  for (const t of touchedTickets) void persist("tickets", t);
  for (const op of newOps) void persist("outbox", op);
}

// ---------- 巡检员动作 ----------

export interface RecordInput {
  roomId: string;
  isoClass: ISOClass;
  sealedAt: number;
  counts: ParticleCounts;
  origin: InspectionRecord["origin"];
}

/** 保存巡检记录：断网也能用；校准编号按封条时刻生效批次落，缺批次则为 null（待核） */
export function saveRecord(input: RecordInput): InspectionRecord {
  const now = Date.now();
  const cal = activeCalibrationAt(state.calibrations, DEVICE_ID, input.sealedAt);
  const record: InspectionRecord = {
    id: uuid(),
    roomId: input.roomId,
    isoClass: input.isoClass,
    periodKey: periodKeyOf(input.sealedAt),
    sealedAt: input.sealedAt,
    counts: input.counts,
    calibrationId: cal?.id ?? null,
    inspector: input.origin === "巡检端A" ? "夜班巡检员(甲)" : "夜班巡检员(乙)",
    origin: input.origin,
    handoverBatchId: state.openHandoverId,
    capturedAt: now,
    version: 1,
    updatedAt: now,
  };
  setState({ records: [...state.records, record] });
  void persist("records", record);
  enqueueOp("upsertRecord", record);
  reconcile();
  log(
    `${input.origin} 记录 ${input.roomId}（封条 ${new Date(input.sealedAt).toLocaleTimeString()}）已存本地${state.online ? "" : "，断网排队中"}`,
    "ok",
  );
  return record;
}

/** 场景：巡检端B 断网期间也记了同一房间（封条更早，回办公区才整理） */
export function simulateOtherDeviceDuplicate(baseRecordId?: string) {
  const base =
    (baseRecordId ? findRecord(baseRecordId) : undefined) ??
    state.records
      .filter((r) => r.roomId === "CR-1201")
      .sort((a, b) => b.sealedAt - a.sealedAt)[0];
  if (!base) {
    log("找不到可制造重复的记录", "warn");
    return;
  }
  saveRecord({
    roomId: base.roomId,
    isoClass: base.isoClass,
    // 封条时间比端A早 3 分钟，但录入/上传更晚 —— 现场先后仍以封条为准
    sealedAt: base.sealedAt - 3 * 60 * 1000,
    counts: { "0.5um": 4250, "5um": 24 },
    origin: "巡检端B",
  });
  log("巡检端B 的同房间记录已产生（后上传、封条更早），等待合并", "warn");
}

// ---------- 复核员动作 ----------

/** 复核员按现场封条时间选用一份（默认建议封条最早的一份） */
export function resolveConflict(roomId: string, periodKey: string, chosenRecordId: string) {
  const now = Date.now();
  const group = state.records.filter((r) => r.roomId === roomId && r.periodKey === periodKey);
  const chosen = group.find((r) => r.id === chosenRecordId);
  if (!chosen) return;
  const ordered = [...group].sort((a, b) => a.sealedAt - b.sealedAt);
  const id = resolutionIdOf(roomId, periodKey);
  const existing = state.resolutions.find((r) => r.id === id);
  const resolution: ConflictResolution = {
    id,
    roomId,
    periodKey,
    chosenRecordId,
    suggestedRecordId: ordered[0].id,
    resolvedBy: "复核员",
    sealTimeBasis: chosen.sealedAt,
    version: existing ? existing.version + 1 : 1,
    updatedAt: now,
  };
  setState({ resolutions: [...state.resolutions.filter((r) => r.id !== id), resolution] });
  void persist("resolutions", resolution);
  enqueueOp("upsertResolution", resolution);
  reconcile();
  log(`复核员选用封条 ${new Date(chosen.sealedAt).toLocaleTimeString()} 的一份（两份原始值均保留）`, "ok");
}

export function canApprove(ticket: ExceptionTicket): { ok: boolean; reason?: string } {
  if (ticket.status === "confirmed") return { ok: false, reason: "已确认并冻结" };
  // 待核以“当前仍无判定依据”为准；补核后历史事件保留但不再阻止审批
  if (!ticket.basis) {
    return { ok: false, reason: "待核：记录缺少校准编号，补核后才能审批" };
  }
  const group = state.records.filter(
    (r) => !r.deleted && r.roomId === ticket.roomId && r.periodKey === ticket.periodKey,
  );
  if (group.length > 1 && !state.resolutions.some((r) => r.id === conflictIdOf(ticket.roomId, ticket.periodKey))) {
    return { ok: false, reason: "同一房间同时段有两份记录，请先按封条时间选用一份" };
  }
  if (!ticket.basis) return { ok: false, reason: "尚无判定依据" };
  return { ok: true };
}

export function approveTicket(ticketId: string, conclusion: string) {
  const ticket = state.tickets.find((t) => t.id === ticketId);
  if (!ticket) return;
  const guard = canApprove(ticket);
  if (!guard.ok) {
    log(`审批被拒：${guard.reason}`, "warn");
    return;
  }
  const confirmed = confirmTicketLogic(ticket, "复核员", conclusion, Date.now());
  const next = bump(confirmed);
  setState({ tickets: state.tickets.map((t) => (t.id === ticketId ? next : t)) });
  void persist("tickets", next);
  enqueueOp("upsertTicket", next);
  log(`处理单 ${ticketId} 已确认，冻结当时阈值与校准编号 ${next.basis?.calibrationId}`, "ok");
}

/** 旧记录补核：补录校准编号后重新参加审批 */
export function verifyRecord(recordId: string, calibrationId: string) {
  const record = findRecord(recordId);
  if (!record) return;
  const next = bump({ ...record, calibrationId });
  setState({ records: state.records.map((r) => (r.id === recordId ? next : r)) });
  void persist("records", next);
  enqueueOp("upsertRecord", next);
  reconcile();
  log(`记录 ${record.roomId} 已补核校准编号 ${calibrationId}，对应处理单退出待核`, "ok");
}

/** 模拟重复提交：同一处理单再投一次，验证服务器幂等去重，不会多出处理单 */
export function resubmitTicket(ticketId: string) {
  const ticket = state.tickets.find((t) => t.id === ticketId);
  if (!ticket) return;
  // 固定幂等键：重放与首次完全相同的操作；本地不新增队列条目，直接向服务器再投一次
  const opId = `resubmit|${ticket.id}|v${ticket.version}`;
  const existing = state.outbox.find((op) => op.id === opId);
  const op: OutboxOp = existing ?? {
    id: opId,
    type: "upsertTicket",
    entityId: ticket.id,
    payload: JSON.parse(JSON.stringify(ticket)),
    createdAt: Date.now(),
    status: "queued",
    tries: 0,
  };
  if (!existing) {
    const outbox = [...state.outbox, op];
    setState({ outbox });
    void persist("outbox", op);
  }
  log(`处理单 ${ticketId} 被重复提交（相同业务编号/幂等键）`, "warn");
  void syncNow();
}

// ---------- 校准批次 ----------

/** 发布新校准批次：未审批结论失效重算，已确认单冻结 */
export function publishNewCalibration() {
  const now = Date.now();
  const id = "CAL-2026Q4";
  if (state.calibrations.some((c) => c.id === id)) {
    log("CAL-2026Q4 已存在", "warn");
    return;
  }
  const thresholds = seedThresholds();
  thresholds["ISO 5"]["0.5um"] = 4200; // 3520 -> 4200：部分未审批超限单将重算为合格
  thresholds["ISO 5"]["5um"] = 35;
  const cal: CalibrationBatch = {
    id,
    deviceId: DEVICE_ID,
    label: "2026 第四季度校准（ISO5 放宽）",
    issuedAt: now,
    thresholds,
    approved: true,
    version: 1,
    updatedAt: now,
  };
  setState({ calibrations: [...state.calibrations, cal] });
  void persist("calibrations", cal);
  enqueueOp("upsertCalibration", cal);
  reconcile();
  log("新校准批次 CAL-2026Q4 已生效：未审批单失效重算，已确认单保留原阈值/编号", "ok");
}

// ---------- 交接批次 / 崩溃恢复 ----------

export function openHandover() {
  const now = Date.now();
  const h: HandoverBatch = {
    id: `HB-${now.toString(36)}`,
    shiftLabel: "夜班巡检批次",
    openedAt: now,
    closedAt: null,
    checkpointAt: null,
    status: "open",
    recordIds: [],
    version: 1,
    updatedAt: now,
  };
  setState({ handovers: [...state.handovers, h], openHandoverId: h.id });
  void persist("handovers", h);
  enqueueOp("upsertHandover", h);
  log(`交接批次 ${h.id} 已开始`, "info");
}

export function closeHandover() {
  const id = state.openHandoverId;
  if (!id) return;
  const h = state.handovers.find((x) => x.id === id);
  if (!h) return;
  const now = Date.now();
  const next = bump({
    ...h,
    status: "complete" as const,
    closedAt: now,
    checkpointAt: now,
    recordIds: state.records.filter((r) => r.handoverBatchId === id).map((r) => r.id),
  });
  setState({
    handovers: state.handovers.map((x) => (x.id === id ? next : x)),
    openHandoverId: null,
  });
  void persist("handovers", next);
  enqueueOp("upsertHandover", next);
  log(`交接批次 ${id} 完成并写入本地检查点`, "ok");
}

/** 模拟浏览器崩溃：内存清空、页面重载；IDB 与出站队列保留，重启时从最近完整批次恢复 */
export function crashAndReload() {
  sessionStorage.setItem("cleanroom-crash", "1");
  location.reload();
}

// ---------- 同步 ----------

export function setOnline(online: boolean) {
  setState({ online });
  log(online ? "网络已恢复" : "已进入断网模式，数据只写本地", online ? "ok" : "warn");
  if (online) void syncNow();
}

function mergeIncoming(kind: EntityKind, remote: unknown): boolean {
  const entity = remote as { id: string; version: number };
  const lists = {
    records: state.records,
    tickets: state.tickets,
    calibrations: state.calibrations,
    resolutions: state.resolutions,
    handovers: state.handovers,
  } as Record<EntityKind, { id: string; version: number }[]>;
  const list = lists[kind];
  const idx = list.findIndex((x) => x.id === entity.id);
  if (idx < 0) {
    const nextList = [...list, entity as never];
    state = { ...state, [kind]: nextList };
    void persist(kind as StoreName, entity as never);
    return true;
  }
  const local = list[idx];
  let merged: unknown;
  if (kind === "records") merged = mergeRecord(local as unknown as InspectionRecord, entity as unknown as InspectionRecord);
  else if (kind === "tickets") merged = mergeTicket(local as unknown as ExceptionTicket, entity as unknown as ExceptionTicket);
  else merged = mergeByVersion(local, entity);
  if (merged !== local) {
    const nextList = [...list];
    nextList[idx] = merged as never;
    state = { ...state, [kind]: nextList };
    void persist(kind as StoreName, merged as never);
    return true;
  }
  return false;
}

export async function syncNow(): Promise<void> {
  if (!state.online || state.syncing) return;
  setState({ syncing: true });
  const server = loadServerState();
  let applied = 0;
  let deduped = 0;

  // 1) 推送：逐条幂等提交；崩溃后重放同一操作不会重复落单
  const updatedOps: OutboxOp[] = [];
  for (const op of state.outbox) {
    if (op.status === "acked") {
      updatedOps.push(op);
      continue;
    }
    const next: OutboxOp = { ...op, tries: op.tries + 1 };
    const res: ApplyResult = serverApply(server, next);
    if (res.deduped) deduped += 1;
    else applied += 1;
    next.status = "acked";
    updatedOps.push(next);
    void persist("outbox", next);
  }

  // 2) 拉取增量：服务器版本合并；现场封条时间 sealedAt 不被到达时间覆盖
  const chunk: PullChunk = serverPull(server, state.cursor);
  let changed = 0;
  for (const change of chunk.changed) {
    if (mergeIncoming(change.kind, change.entity)) changed += 1;
  }

  setState({
    outbox: updatedOps,
    cursor: chunk.serverSeq,
    syncing: false,
  });

  // 3) 拉到新数据后本地对账（冲突/重算）
  reconcile();

  if (applied || deduped || changed) {
    log(
      `合并完成：上传 ${applied} 条${deduped ? `，幂等去重 ${deduped} 条` : ""}，接收 ${changed} 条`,
      deduped ? "warn" : "ok",
    );
  } else {
    log("同步完成：无增量", "info");
  }
}

// ---------- 启动 / 种子 / 恢复 ----------

function seedDemoData(now: number) {
  const cal1: CalibrationBatch = {
    id: "CAL-2026Q3",
    deviceId: DEVICE_ID,
    label: "2026 第三季度校准",
    issuedAt: now - 40 * 86400_000,
    thresholds: seedThresholds(),
    approved: true,
    version: 1,
    updatedAt: now,
  };

  const mk = (
    partial: Partial<InspectionRecord> & Pick<InspectionRecord, "id" | "roomId" | "isoClass" | "sealedAt" | "counts" | "origin" | "calibrationId" | "handoverBatchId">,
  ): InspectionRecord => ({
    periodKey: periodKeyOf(partial.sealedAt),
    inspector: partial.origin === "巡检端A" ? "夜班巡检员(甲)" : "夜班巡检员(乙)",
    capturedAt: partial.sealedAt + 60_000,
    version: 1,
    updatedAt: now,
    ...partial,
  });

  const hbOldId = "HB-20261003-E";
  const hbOld: HandoverBatch = {
    id: hbOldId,
    shiftLabel: "昨夜完整批次",
    openedAt: now - 3 * 3600_000,
    closedAt: now - 2 * 3600_000 - 50 * 60_000,
    checkpointAt: now - 2 * 3600_000 - 50 * 60_000,
    status: "complete",
    recordIds: ["seed-r1", "seed-r2", "seed-r3"],
    version: 1,
    updatedAt: now,
  };
  const hbOpenId = "HB-20261004-N";
  const hbOpen: HandoverBatch = {
    id: hbOpenId,
    shiftLabel: "今夜巡检批次（进行中）",
    openedAt: now - 50 * 60_000,
    closedAt: null,
    checkpointAt: null,
    status: "open",
    recordIds: ["seed-r4"],
    version: 1,
    updatedAt: now,
  };

  const r1 = mk({
    id: "seed-r1",
    roomId: "CR-1201",
    isoClass: "ISO 5",
    sealedAt: now - 2 * 3600_000 - 40 * 60_000,
    counts: { "0.5um": 4100, "5um": 21 },
    origin: "巡检端A",
    calibrationId: cal1.id,
    handoverBatchId: hbOldId,
  });
  const r2 = mk({
    id: "seed-r2",
    roomId: "CR-2107",
    isoClass: "ISO 6",
    sealedAt: now - 2 * 3600_000 - 35 * 60_000,
    counts: { "0.5um": 12000, "5um": 40 },
    origin: "巡检端A",
    calibrationId: cal1.id,
    handoverBatchId: hbOldId,
  });
  const r3 = mk({
    id: "seed-r3",
    roomId: "CR-3305",
    isoClass: "ISO 7",
    sealedAt: now - 2 * 3600_000 - 20 * 60_000,
    counts: { "0.5um": 400000, "5um": 1200 },
    origin: "巡检端A",
    calibrationId: null, // 旧记录缺校准编号 => 待核
    handoverBatchId: hbOldId,
  });
  const r4 = mk({
    id: "seed-r4",
    roomId: "CR-1201",
    isoClass: "ISO 5",
    sealedAt: now - 12 * 60_000,
    counts: { "0.5um": 3800, "5um": 18 },
    origin: "巡检端A",
    calibrationId: cal1.id,
    handoverBatchId: hbOpenId,
  });

  const records = [r1, r2, r3, r4];
  const handovers = [hbOld, hbOpen];

  // 先落服务器（无操作历史，相当于历史快照）
  const server = loadServerState();
  for (const c of [cal1]) serverSeedUpsert(server, "calibrations", c);
  for (const r of records) serverSeedUpsert(server, "records", r);
  for (const h of handovers) serverSeedUpsert(server, "handovers", h);
  saveServerState(server);

  // 本地落库（处理单由首次 reconcile 生成）
  void idbBulkPut("calibrations", [cal1]);
  void idbBulkPut("records", records);
  void idbBulkPut("handovers", handovers);

  localStorage.setItem(SEED_KEY, String(now));

  Object.assign(state, {
    calibrations: [cal1],
    records,
    handovers,
    openHandoverId: hbOpenId,
    cursor: server.seq,
  });

  // 生成初始处理单（T1 超限 pending、T3 待核、T4 超限 pending）并直接静默同步到服务器
  reconcile();
  const withTickets = loadServerState();
  for (const op of state.outbox) {
    serverApply(withTickets, op);
    const acked = { ...op, status: "acked" as const };
    void persist("outbox", acked);
  }
  saveServerState(withTickets);
  setState({ outbox: state.outbox.map((op) => ({ ...op, status: "acked" as const })), cursor: withTickets.seq });
  log("已载入演示基线：含一张缺校准编号的旧记录（待核）", "info");
}

export async function boot() {
  if (state.ready) return;
  const seeded = localStorage.getItem(SEED_KEY);
  const now = Date.now();
  if (!seeded) {
    seedDemoData(now);
  } else {
    const [records, tickets, calibrations, resolutions, handovers, outbox] = await Promise.all([
      idbGetAll<InspectionRecord>("records"),
      idbGetAll<ExceptionTicket>("tickets"),
      idbGetAll<CalibrationBatch>("calibrations"),
      idbGetAll<ConflictResolution>("resolutions"),
      idbGetAll<HandoverBatch>("handovers"),
      idbGetAll<OutboxOp>("outbox"),
    ]);
    const server = loadServerState();
    Object.assign(state, {
      records,
      tickets,
      calibrations,
      resolutions,
      handovers,
      outbox,
      cursor: server.seq,
      openHandoverId: handovers.find((h) => h.status === "open")?.id ?? null,
    });
    reconcile();
    log("已从本地 IndexedDB 恢复", "info");
  }

  // 崩溃恢复：从最近完整交接批次之后重放未 ack 的操作，只补未完成项
  let recovery: RecoveryReport | null = null;
  if (sessionStorage.getItem("cleanroom-crash") === "1") {
    sessionStorage.removeItem("cleanroom-crash");
    recovery = planRecovery(state.handovers, state.records, state.outbox, Date.now());
    log(
      `浏览器崩溃后重启：最近完整批次 ${recovery.lastCompleteHandoverId ?? "无"}，待重放操作 ${recovery.replayedOpIds.length} 条，未完成记录 ${recovery.unfinishedRecordIds.length} 条`,
      "warn",
    );
    if (state.online) await syncNow();
  }

  setState({ ready: true, recovery });
}

export async function resetDemo() {
  resetServerState();
  localStorage.removeItem(SEED_KEY);
  sessionStorage.removeItem("cleanroom-crash");
  const stores: StoreName[] = ["records", "tickets", "calibrations", "resolutions", "handovers", "outbox"];
  for (const s of stores) await idbClear(s);
  location.reload();
}

// 供 UI 使用的派生选择器
export { buildConflictViews, latestCalibration, DEVICE_ID };
