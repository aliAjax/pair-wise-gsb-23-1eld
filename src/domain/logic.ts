import type {
  CalibrationBatch,
  ConflictResolution,
  ConflictView,
  ExceptionTicket,
  HandoverBatch,
  InspectionRecord,
  OutboxOp,
  ParticleCounts,
  ParticleKind,
  RecoveryReport,
  TicketBasis,
  TicketEvent,
  ThresholdTable,
} from "./types";

// ---------- 时间与编号 ----------

export const pad = (n: number) => String(n).padStart(2, "0");

export function fmtClock(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 巡检时段：整点归段（夜班跨天按自然日时段处理，足够演示） */
export function periodKeyOf(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
}

export const ticketIdOf = (roomId: string, periodKey: string) => `T|${roomId}|${periodKey}`;
export const conflictIdOf = (roomId: string, periodKey: string) => `C|${roomId}|${periodKey}`;
export const resolutionIdOf = conflictIdOf;

// ---------- 校准批次 ----------

/** 取测量发生时已生效的最新批次（即使后来换批，已确认单仍冻结当时编号） */
export function activeCalibrationAt(
  calibrations: CalibrationBatch[],
  deviceId: string,
  at: number,
): CalibrationBatch | null {
  return (
    calibrations
      .filter((c) => c.approved && c.deviceId === deviceId && c.issuedAt <= at)
      .sort((a, b) => b.issuedAt - a.issuedAt)[0] ?? null
  );
}

export function latestCalibration(
  calibrations: CalibrationBatch[],
  deviceId: string,
  at: number,
): CalibrationBatch | null {
  return (
    calibrations
      .filter((c) => c.approved && c.deviceId === deviceId)
      .filter((c) => c.issuedAt <= at)
      .sort((a, b) => b.issuedAt - a.issuedAt)[0] ?? null
  );
}

export function getThreshold(cal: CalibrationBatch | null, isoClass: string) {
  return cal?.thresholds[isoClass] ?? {};
}

export function evaluateViolations(
  counts: ParticleCounts,
  thresholds: Partial<Record<ParticleKind, number>>,
) {
  return (Object.keys(counts) as ParticleKind[]).flatMap((kind) => {
    const value = counts[kind];
    const limit = thresholds[kind];
    if (value == null || limit == null) return [];
    return value > limit ? [{ kind, value, limit }] : [];
  });
}

export function buildBasis(
  record: InspectionRecord,
  cal: CalibrationBatch | null,
): TicketBasis | null {
  if (!cal) return null;
  const thresholds = getThreshold(cal, record.isoClass);
  const violations = evaluateViolations(record.counts, thresholds);
  return {
    calibrationId: cal.id,
    sealedAt: record.sealedAt,
    counts: record.counts,
    thresholds,
    violations,
    exceeded: violations.length > 0,
  };
}

// ---------- 冲突：同房间同时段两份原始记录都保留 ----------

/** 现场先后：封条时间早的在前；建议复核员选封条更早的一份（上传时间不参与） */
export function orderRecordsBySeal(records: InspectionRecord[]): InspectionRecord[] {
  return [...records].sort((a, b) =>
    a.sealedAt !== b.sealedAt ? a.sealedAt - b.sealedAt : a.id.localeCompare(b.id),
  );
}

export function suggestedRecord(records: InspectionRecord[]): InspectionRecord {
  return orderRecordsBySeal(records)[0];
}

/** 把同一房间、同一巡检时段且未删除的记录归为一组；仅 2 份及以上才构成冲突 */
export function groupConflicts(records: InspectionRecord[]): Map<string, InspectionRecord[]> {
  const groups = new Map<string, InspectionRecord[]>();
  for (const r of records) {
    if (r.deleted) continue;
    const key = `${r.roomId}__${r.periodKey}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    if (list.length < 2) groups.delete(key);
  }
  return groups;
}

const PARTICLE_LABEL: Record<string, string> = {
  "0.5um": "0.5µm 计数",
  "5um": "5µm 计数",
};

function countValue(counts: ParticleCounts, kind: ParticleKind): string {
  const v = counts[kind];
  return v == null ? "—" : String(v);
}

/** 两份原始值并排展示并标出差异字段 */
export function buildConflictViews(
  records: InspectionRecord[],
  resolutions: ConflictResolution[],
): ConflictView[] {
  const resolutionByKey = new Map(resolutions.map((r) => [r.id, r]));
  const views: ConflictView[] = [];
  for (const [groupKey, groupRecords] of groupConflicts(records)) {
    const ordered = orderRecordsBySeal(groupRecords);
    const roomId = ordered[0].roomId;
    const periodKey = ordered[0].periodKey;
    const id = conflictIdOf(roomId, periodKey);
    const resolution = resolutionByKey.get(id);
    const kinds: ParticleKind[] = ["0.5um", "5um"];
    const differences = kinds.map((kind) => {
      const values = ordered.map((r) => ({
        recordId: r.id,
        value: countValue(r.counts, kind),
        raw: r.counts[kind] ?? NaN,
      }));
      const present = values.filter((v) => Number.isFinite(v.raw));
      const divergent = present.length > 1 && new Set(present.map((v) => v.raw)).size > 1;
      return { field: PARTICLE_LABEL[kind], values, divergent };
    });
    views.push({
      id,
      roomId,
      periodKey,
      records: ordered,
      suggestedRecordId: ordered[0].id,
      chosenRecordId: resolution?.chosenRecordId ?? null,
      differences,
    });
  }
  return views.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- 异常处理单：换批失效重算 / 确认单冻结 ----------

export function makeTicketEvent(
  type: TicketEvent["type"],
  message: string,
  calibrationId?: string | null,
  at = Date.now(),
): TicketEvent {
  return { at, type, message, calibrationId };
}

function cloneTicket(t: ExceptionTicket): ExceptionTicket {
  return {
    ...t,
    basis: t.basis ? { ...t.basis, counts: { ...t.basis.counts }, violations: [...t.basis.violations] } : null,
    history: t.history.map((e) => ({ ...e })),
  };
}

/**
 * 依据当前数据刷新一张处理单：
 * - 已确认：冻结，永不再算，保留当时阈值和校准编号；
 * - 缺校准编号（记录或批次缺失）：置待核，不参加审批；
 * - 未审批：按“当前最新已审批批次”重算；结论依据变化才落一条失效重算历史。
 */
export function refreshTicket(
  ticket: ExceptionTicket,
  records: InspectionRecord[],
  calibrations: CalibrationBatch[],
  resolutions: ConflictResolution[],
  deviceId: string,
  now: number,
): ExceptionTicket | null {
  if (ticket.status === "confirmed") return ticket; // 已确认冻结

  const resolution = resolutions.find(
    (r) => r.id === resolutionIdOf(ticket.roomId, ticket.periodKey),
  );
  const candidates = records.filter(
    (r) =>
      !r.deleted &&
      r.roomId === ticket.roomId &&
      r.periodKey === ticket.periodKey,
  );
  if (candidates.length === 0) return null;

  const chosen =
    candidates.find((r) => r.id === resolution?.chosenRecordId) ??
    (candidates.length === 1 ? candidates[0] : suggestedRecord(candidates));
  const next = cloneTicket(ticket);
  next.recordId = chosen.id;
  next.updatedAt = now;

  // 记录自带的 calibrationId 是采集时刻溯源：缺失 => 待核，不参加审批。
  if (chosen.calibrationId == null) {
    const pendingNote = `记录 ${chosen.id.slice(0, 8)} 缺少校准编号，先待核，补核前不参加审批`;
    if (!next.history.some((e) => e.type === "pending-verify")) {
      next.history.push(makeTicketEvent("pending-verify", pendingNote, null, now));
    }
    return next;
  }
  // 未审批单随校准批次变化失效重算：一律按当前最新已审批批次取依据
  // （已确认单在函数开头直接返回，其当时阈值与编号永久冻结）。
  const cal = latestCalibration(calibrations, deviceId, now);
  if (!cal) {
    if (!next.history.some((e) => e.type === "pending-verify")) {
      next.history.push(makeTicketEvent("pending-verify", "当前无可用已审批校准批次，先待核", null, now));
    }
    return next;
  }

  const basis = buildBasis(chosen, cal);
  if (!basis) return next;

  const basisChanged =
    ticket.basis == null ||
    ticket.basis.calibrationId !== basis.calibrationId ||
    JSON.stringify(ticket.basis.counts) !== JSON.stringify(basis.counts) ||
    JSON.stringify(ticket.basis.thresholds) !== JSON.stringify(basis.thresholds);

  if (basisChanged) {
    if (ticket.basis == null) {
      next.history.push(
        makeTicketEvent(
          "created",
          basis.exceeded ? "粒子计数超限，自动建立异常处理单" : "当前批次判定合格",
          cal.id,
          now,
        ),
      );
    } else {
      next.history.push(
        makeTicketEvent("invalidated", `原结论失效（原依据 ${ticket.basis.calibrationId}）`, ticket.basis.calibrationId, now),
      );
      next.history.push(
        makeTicketEvent(
          "recomputed",
          `按新校准批次 ${cal.id} 重算：${basis.exceeded ? basis.violations.map((v) => `${v.kind} ${v.value}/${v.limit}`).join("，") : "判定合格"}`,
          cal.id,
          now,
        ),
      );
    }
  }
  next.basis = basis;
  return next;
}

/** 处理单结论内容签名：内容不变时同步不重发 */
export function ticketSig(t: ExceptionTicket): string {
  return JSON.stringify({
    s: t.status,
    r: t.recordId,
    b: t.basis,
    c: t.conclusion,
    h: t.handler,
  });
}

export function confirmTicket(
  ticket: ExceptionTicket,
  handler: string,
  conclusion: string,
  now: number,
): ExceptionTicket {
  if (ticket.status === "confirmed") return ticket;
  const next = cloneTicket(ticket);
  next.status = "confirmed";
  next.handler = handler;
  next.conclusion = conclusion;
  next.confirmedAt = now;
  // 审批即冻结：basis 已是当前计算结果，从此不再参与重算
  next.history.push(
    makeTicketEvent(
      "confirmed",
      `复核员确认，冻结依据 ${next.basis?.calibrationId ?? "?"} 的阈值与校准编号`,
      next.basis?.calibrationId ?? null,
      now,
    ),
  );
  next.updatedAt = now;
  return next;
}

// ---------- 交接批次 / 崩溃恢复 ----------

/** 最近一个完整交接批次 */
export function lastCompleteHandover(
  handovers: HandoverBatch[],
): HandoverBatch | null {
  return handovers
    .filter((h) => h.status === "complete" && h.checkpointAt != null)
    .sort((a, b) => (b.checkpointAt ?? 0) - (a.checkpointAt ?? 0))[0] ?? null;
}

/**
 * 从最近完整交接批次恢复：
 * - 检查点之后、未拿到服务器 ack 的操作才重放（幂等键保证不会多出处理单）；
 * - 未完成项 = 仍处于 open 的交接批次与其记录。
 */
export function planRecovery(
  handovers: HandoverBatch[],
  records: InspectionRecord[],
  outbox: OutboxOp[],
  now: number,
): RecoveryReport {
  const last = lastCompleteHandover(handovers);
  const checkpoint = last?.checkpointAt ?? 0;
  const replayed = outbox.filter(
    (op) => op.createdAt > checkpoint && op.status !== "acked",
  );
  const open = handovers.find((h) => h.status === "open");
  const unfinished = records
    .filter((r) => r.handoverBatchId === open?.id)
    .map((r) => r.id);
  return {
    at: now,
    lastCompleteHandoverId: last?.id ?? null,
    lastCompleteAt: last?.checkpointAt ?? null,
    replayedOpIds: replayed.map((op) => op.id),
    unfinishedRecordIds: unfinished,
    openHandoverId: open?.id ?? null,
  };
}

// ---------- 实体合并（服务器为准；封条时间不被上传时间覆盖） ----------

export function mergeRecord(local: InspectionRecord, remote: InspectionRecord): InspectionRecord {
  const winner = remote.version >= local.version ? remote : local;
  // sealedAt 是现场事实：永远保留原始封条时间，任何一方都不能改写
  return { ...winner, sealedAt: local.sealedAt ?? remote.sealedAt, capturedAt: winner.capturedAt };
}

export function mergeTicket(local: ExceptionTicket, remote: ExceptionTicket): ExceptionTicket {
  // 任一侧已确认则以确认方为准（确认后冻结）
  if (local.status === "confirmed") return local;
  if (remote.status === "confirmed") return remote;
  return remote.version >= local.version ? remote : local;
}

export function mergeByVersion<T extends { id: string; version: number }>(
  local: T,
  remote: T,
): T {
  return remote.version >= local.version ? remote : local;
}

// ---------- 阈值表（种子/演示用） ----------

export const DEVICE_ID = "LPC-A07";

export function seedThresholds(): ThresholdTable {
  return {
    "ISO 5": { "0.5um": 3520, "5um": 29 },
    "ISO 6": { "0.5um": 35200, "5um": 293 },
    "ISO 7": { "0.5um": 352000, "5um": 2930 },
    黄光区: { "0.5um": 35200, "5um": 293 },
  };
}
