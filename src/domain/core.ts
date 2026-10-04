import type {
  AnomalyTicket,
  AppState,
  CalibrationBatch,
  CalibrationReport,
  InspectionRecord,
  IsoClass,
  Op,
  Persisted,
  Thresholds,
} from "./types";

export const DEFAULT_THRESHOLDS: Record<IsoClass, Thresholds> = {
  "ISO 5": { particle05: 3520, tempMin: 20, tempMax: 24, humidityMin: 40, humidityMax: 60, pressureMin: 10 },
  "ISO 6": { particle05: 35200, tempMin: 20, tempMax: 24, humidityMin: 40, humidityMax: 60, pressureMin: 10 },
  "ISO 7": { particle05: 352000, tempMin: 20, tempMax: 24, humidityMin: 40, humidityMax: 60, pressureMin: 10 },
  "ISO 8": { particle05: 3520000, tempMin: 20, tempMax: 24, humidityMin: 40, humidityMax: 60, pressureMin: 10 },
};

export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export const fmtNum = (n: number): string => n.toLocaleString("zh-CN");

/** 冲突键：同一房间 + 同一时段 */
export function conflictKey(r: Pick<InspectionRecord, "roomId" | "slot">): string {
  return `${r.roomId}|${r.slot}`;
}

export function activeCalibration(state: AppState): CalibrationBatch {
  const found = state.calibrations.find((c) => c.status === "active");
  return found ?? state.calibrations[state.calibrations.length - 1];
}

/** 用阈值判定一份记录，返回违规描述列表（空 = 正常） */
export function evaluateRecord(rec: InspectionRecord, t: Thresholds): string[] {
  const v: string[] = [];
  if (rec.particle05 > t.particle05) {
    v.push(`0.5µm粒子 ${fmtNum(rec.particle05)} 超阈值 ${fmtNum(t.particle05)}`);
  }
  if (rec.temperature < t.tempMin || rec.temperature > t.tempMax) {
    v.push(`温度 ${rec.temperature}℃ 超出 ${t.tempMin}~${t.tempMax}℃`);
  }
  if (rec.humidity < t.humidityMin || rec.humidity > t.humidityMax) {
    v.push(`湿度 ${rec.humidity}% 超出 ${t.humidityMin}~${t.humidityMax}%`);
  }
  if (rec.pressure < t.pressureMin) {
    v.push(`压差 ${rec.pressure}Pa 低于 ${t.pressureMin}Pa`);
  }
  return v;
}

/** 旧记录缺校准编号：只挂待核单，不产生可审批结论 */
function ensureLegacyTicket(state: AppState, rec: InspectionRecord, now: string): AnomalyTicket {
  const id = `TKT-${rec.id}@legacy`;
  const existing = state.tickets.find((t) => t.id === id);
  if (existing) return existing;
  const t: AnomalyTicket = {
    id,
    recordId: rec.id,
    roomId: rec.roomId,
    slot: rec.slot,
    violations: ["缺少校准编号，按待核处理，不参加新审批"],
    thresholdSnapshot: null,
    calibrationId: null,
    status: "pendingVerification",
    createdAt: now,
  };
  state.tickets.push(t);
  return t;
}

/**
 * 评估一份记录并（如有异常）生成处理单。
 * 处理单 id 是确定性的（记录 + 校准批次），重复提交/崩溃重放幂等。
 */
export function evaluateOne(state: AppState, rec: InspectionRecord, now: string): AnomalyTicket | null {
  if (rec.supersededBy) return null; // 复核未选用的记录不再出结论
  if (rec.calibrationId == null) {
    ensureLegacyTicket(state, rec, now);
    return null;
  }
  const batch = activeCalibration(state);
  const violations = evaluateRecord(rec, batch.thresholds[rec.isoClass]);
  state.evaluated[rec.id] = batch.id;
  if (violations.length === 0) return null;
  const id = `TKT-${rec.id}@${batch.id}`;
  const existing = state.tickets.find((t) => t.id === id);
  if (existing) return existing;
  const t: AnomalyTicket = {
    id,
    recordId: rec.id,
    roomId: rec.roomId,
    slot: rec.slot,
    violations,
    thresholdSnapshot: clone(batch.thresholds[rec.isoClass]),
    calibrationId: batch.id,
    status: "pending",
    createdAt: now,
  };
  state.tickets.push(t);
  return t;
}

/** 冲突归组：同房间同时段 >1 份记录即为一组，两份原始值都保留 */
export function normalizeConflicts(state: AppState): void {
  const groups = new Map<string, InspectionRecord[]>();
  for (const r of state.records) {
    const k = conflictKey(r);
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }
  for (const [key, members] of groups) {
    if (members.length > 1) {
      const gid = `CG-${key}`;
      for (const m of members) m.conflictGroupId = gid;
    } else {
      members[0].conflictGroupId = null;
      members[0].chosen = false;
      members[0].supersededBy = null;
    }
  }
}

/** 组内是否还有待复核：存在既未被选用也未被取代的记录 */
export function groupNeedsReview(members: InspectionRecord[]): boolean {
  return members.length > 1 && members.some((m) => !m.chosen && !m.supersededBy);
}

export function conflictGroups(state: AppState): InspectionRecord[][] {
  const map = new Map<string, InspectionRecord[]>();
  for (const r of state.records) {
    if (!r.conflictGroupId) continue;
    const arr = map.get(r.conflictGroupId) ?? [];
    arr.push(r);
    map.set(r.conflictGroupId, arr);
  }
  return [...map.values()];
}

/**
 * 复核建议：只按现场封条时间排序。
 * 上传/到达时间（createdAt）再晚，也不能盖掉现场先后。
 */
export function suggestedPick(members: InspectionRecord[]): InspectionRecord {
  return [...members].sort((a, b) => a.sealTime.localeCompare(b.sealTime) || a.id.localeCompare(b.id))[0];
}

/**
 * 校准批次变更：未审批结论全部失效并按新批次重算；
 * 已确认处理单保留当时阈值快照与校准编号，不动；
 * 缺校准编号的旧记录保持待核，排除在新审批之外。
 */
export function activateCalibration(state: AppState, batch: CalibrationBatch, now: string): CalibrationReport {
  for (const c of state.calibrations) {
    if (c.status === "active") c.status = "superseded";
  }
  state.calibrations.push(batch);

  const report: CalibrationReport = {
    batchId: batch.id,
    invalidated: 0,
    recomputed: 0,
    cleared: 0,
    newDetected: 0,
    keptConfirmed: 0,
    pendingVerification: 0,
  };

  const affectedRecordIds = new Set<string>();
  for (const t of state.tickets) {
    if (t.status === "pending") {
      t.status = "invalidated";
      t.invalidatedReason = `校准批次变更为 ${batch.id}，未审批结论失效，按新批次重算`;
      affectedRecordIds.add(t.recordId);
      report.invalidated += 1;
    } else if (t.status === "confirmed") {
      report.keptConfirmed += 1;
    }
  }

  for (const rec of state.records) {
    if (rec.supersededBy) continue;
    if (rec.calibrationId == null) {
      ensureLegacyTicket(state, rec, now);
      report.pendingVerification += 1;
      continue;
    }
    const hadPending = affectedRecordIds.has(rec.id);
    const ticket = evaluateOne(state, rec, now);
    if (ticket && ticket.status === "pending") {
      if (hadPending) report.recomputed += 1;
      else report.newDetected += 1;
    } else if (!ticket && hadPending) {
      report.cleared += 1;
    }
  }
  return report;
}

/**
 * 崩溃恢复后的补做：只补未完成项。
 * 已应用的操作靠幂等键跳过，不会重复生成处理单。
 */
export function completeIncomplete(state: AppState, now: string): string[] {
  const done: string[] = [];
  normalizeConflicts(state);
  const active = activeCalibration(state);
  for (const rec of state.records) {
    if (!rec.synced && !state.outbox.includes(rec.id)) {
      state.outbox.push(rec.id);
      done.push(`补登记待同步记录 ${rec.id}（${rec.roomId} ${rec.slot}）`);
    }
    if (rec.supersededBy) continue;
    if (rec.calibrationId == null) {
      const before = state.tickets.length;
      ensureLegacyTicket(state, rec, now);
      if (state.tickets.length > before) {
        done.push(`旧记录 ${rec.id} 缺少校准编号，列为待核，不参加新审批`);
      }
      continue;
    }
    if (state.evaluated[rec.id] !== active.id) {
      const ticket = evaluateOne(state, rec, now);
      done.push(
        ticket
          ? `补评估 ${rec.roomId} ${rec.slot}：检出异常，生成处理单 ${ticket.id}`
          : `补评估 ${rec.roomId} ${rec.slot}：结论正常`
      );
    }
  }
  return done;
}

/** 应用一条操作；幂等键已应用则跳过。返回是否真正生效 */
export function applyOp(state: AppState, op: Op): boolean {
  if (state.appliedKeys.includes(op.idemKey)) return false;
  let ok = false;
  switch (op.type) {
    case "addRecord":
      ok = applyAddRecord(state, op);
      break;
    case "mergeRemote":
      ok = applyMergeRemote(state, op);
      break;
    case "resolveConflict":
      ok = applyResolveConflict(state, op);
      break;
    case "approveTicket":
      ok = applyApproveTicket(state, op);
      break;
    case "activateCalibration":
      ok = applyActivateCalibration(state, op);
      break;
  }
  if (ok) state.appliedKeys.push(op.idemKey);
  return ok;
}

function applyAddRecord(state: AppState, op: Op): boolean {
  const rec = op.payload as InspectionRecord;
  if (state.records.some((r) => r.id === rec.id)) return false; // 重复提交去重
  state.records.push(rec);
  if (!rec.synced && !state.outbox.includes(rec.id)) state.outbox.push(rec.id);
  normalizeConflicts(state);
  const ticket = evaluateOne(state, rec, op.appliedAt);
  op.result = { ticketId: ticket?.id ?? null };
  return true;
}

function applyMergeRemote(state: AppState, op: Op): boolean {
  const incoming = (op.payload as InspectionRecord[]).filter(
    (r) => !state.records.some((x) => x.id === r.id)
  );
  if (incoming.length === 0) return false; // 全部已存在，重复合并跳过
  for (const r of incoming) {
    // 合并只新增，绝不覆盖本地原始值
    const rec: InspectionRecord = {
      ...clone(r),
      origin: "remote",
      synced: true,
      conflictGroupId: null,
      chosen: false,
      supersededBy: null,
    };
    state.records.push(rec);
  }
  normalizeConflicts(state);
  for (const r of incoming) {
    const rec = state.records.find((x) => x.id === r.id);
    if (rec) evaluateOne(state, rec, op.appliedAt);
  }
  op.result = { merged: incoming.map((r) => r.id) };
  return true;
}

function applyResolveConflict(state: AppState, op: Op): boolean {
  const p = op.payload as { groupId: string; chosenId: string; reviewer: string };
  const members = state.records.filter((r) => r.conflictGroupId === p.groupId);
  const chosen = members.find((m) => m.id === p.chosenId);
  if (!chosen || members.length < 2) return false;
  if (chosen.chosen) return false; // 已按该记录复核过，重复提交跳过
  for (const m of members) {
    if (m.id === p.chosenId) {
      m.chosen = true;
      m.supersededBy = null;
    } else {
      m.chosen = false;
      m.supersededBy = p.chosenId;
    }
  }
  // 未选用记录的待审批结论作废（原始值保留）
  for (const m of members) {
    if (m.id === p.chosenId) continue;
    for (const t of state.tickets) {
      if (t.recordId === m.id && t.status === "pending") {
        t.status = "invalidated";
        t.invalidatedReason = `复核员 ${p.reviewer} 按现场封条时间选用了 ${p.chosenId}，本记录结论作废`;
      }
    }
  }
  const ticket = evaluateOne(state, chosen, op.appliedAt);
  op.result = { chosenId: p.chosenId, ticketId: ticket?.id ?? null };
  return true;
}

function applyApproveTicket(state: AppState, op: Op): boolean {
  const p = op.payload as { ticketId: string; reviewer: string };
  const t = state.tickets.find((x) => x.id === p.ticketId);
  // 只有待审批单可确认：待核旧记录、已失效、已确认都不能重复审批
  if (!t || t.status !== "pending") return false;
  t.status = "confirmed";
  t.confirmedBy = p.reviewer;
  t.confirmedAt = op.appliedAt;
  op.result = { ticketId: t.id };
  return true;
}

function applyActivateCalibration(state: AppState, op: Op): boolean {
  const p = op.payload as { batch: CalibrationBatch };
  if (state.calibrations.some((c) => c.id === p.batch.id)) return false;
  op.result = activateCalibration(state, p.batch, op.appliedAt);
  return true;
}

// ---------------------------------------------------------------------------
// 种子数据：覆盖演示所需的全部场景
// ---------------------------------------------------------------------------

function seedRecords(): InspectionRecord[] {
  const base = { conflictGroupId: null, chosen: false, supersededBy: null, origin: "local" as const };
  return [
    {
      ...base, id: "R-1001", roomId: "CR-1201", isoClass: "ISO 5", slot: "2026-10-03 · 夜班",
      particle05: 4100, temperature: 22.4, humidity: 47, pressure: 14,
      sealTime: "2026-10-03T23:40", createdAt: "2026-10-04T08:10", synced: true,
      calibrationId: "CAL-2026-03B", note: "0.5µm粒子超限，已通知厂务",
    },
    {
      ...base, id: "R-1002", roomId: "CR-2107", isoClass: "ISO 6", slot: "2026-10-03 · 夜班",
      particle05: 21400, temperature: 22.0, humidity: 45, pressure: 15,
      sealTime: "2026-10-03T23:55", createdAt: "2026-10-04T08:12", synced: true,
      calibrationId: "CAL-2026-03B", note: "压差15Pa，温湿度正常",
    },
    {
      ...base, id: "R-1003", roomId: "Y-0302", isoClass: "ISO 7", slot: "2026-10-03 · 夜班",
      particle05: 331000, temperature: 22.8, humidity: 58, pressure: 12,
      sealTime: "2026-10-04T00:20", createdAt: "2026-10-04T08:15", synced: true,
      calibrationId: null, note: "旧系统导入，缺少校准编号",
    },
    {
      ...base, id: "R-1004", roomId: "CR-3305", isoClass: "ISO 7", slot: "2026-10-02 · 夜班",
      particle05: 402000, temperature: 23.1, humidity: 55, pressure: 11,
      sealTime: "2026-10-03T00:10", createdAt: "2026-10-03T08:30", synced: true,
      calibrationId: "CAL-2026-03B", note: "粒子超限，已确认并整改",
    },
    // 冲突对：同房间同时段两份。R-1005R 封条更早但上传更晚 —— 现场先后不能被上传时间盖掉
    {
      ...base, id: "R-1005L", roomId: "CR-1201", isoClass: "ISO 5", slot: "2026-10-04 · 夜班",
      particle05: 3600, temperature: 22.2, humidity: 46, pressure: 13,
      sealTime: "2026-10-04T22:15", createdAt: "2026-10-04T22:20", synced: false,
      calibrationId: "CAL-2026-03B", note: "夜班巡检员手持终端离线录入",
    },
    {
      ...base, id: "R-1005R", roomId: "CR-1201", isoClass: "ISO 5", slot: "2026-10-04 · 夜班",
      particle05: 2900, temperature: 22.6, humidity: 48, pressure: 13,
      sealTime: "2026-10-04T22:05", createdAt: "2026-10-04T23:05", origin: "remote", synced: true,
      calibrationId: "CAL-2026-03B", note: "复核员在办公区补录",
    },
  ];
}

export function seedPersisted(): Persisted {
  const state: AppState = {
    records: [],
    tickets: [],
    calibrations: [
      {
        id: "CAL-2025-09A", deviceId: "PC-3100", activatedAt: "2025-09-01T08:00",
        status: "superseded", thresholds: clone(DEFAULT_THRESHOLDS),
      },
      {
        id: "CAL-2026-03B", deviceId: "PC-3100", activatedAt: "2026-03-02T08:00",
        status: "active", thresholds: clone(DEFAULT_THRESHOLDS),
      },
    ],
    appliedKeys: [],
    evaluated: {},
    outbox: [],
    lastSyncAt: null,
  };
  for (const r of seedRecords()) {
    state.records.push(r);
    if (!r.synced) state.outbox.push(r.id);
    evaluateOne(state, r, r.createdAt);
  }
  normalizeConflicts(state);
  // R-1004 的处理单置为已确认：保留当时阈值快照与校准编号
  const t4 = state.tickets.find((t) => t.recordId === "R-1004");
  if (t4) {
    t4.status = "confirmed";
    t4.confirmedBy = "赵衡 · 班组长";
    t4.confirmedAt = "2026-10-03T08:20";
  }
  const batch = {
    id: "HB-0001",
    openedAt: "2026-10-03T08:00",
    sealedAt: "2026-10-04T08:05",
    opCount: state.records.length,
  };
  return {
    state,
    ops: [],
    batches: [batch],
    lastSealedSnapshot: { batchId: batch.id, state: clone(state) },
  };
}
