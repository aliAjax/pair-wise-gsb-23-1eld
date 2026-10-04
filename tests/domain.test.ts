import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  CalibrationBatch,
  ConflictResolution,
  ExceptionTicket,
  HandoverBatch,
  InspectionRecord,
  OutboxOp,
} from "../src/domain/types";
import {
  activeCalibrationAt,
  buildBasis,
  buildConflictViews,
  confirmTicket,
  mergeRecord,
  periodKeyOf,
  planRecovery,
  refreshTicket,
  seedThresholds,
  ticketIdOf,
  ticketSig,
} from "../src/domain/logic";
import { loadServerState, serverApply } from "../src/store/mockServer";

const T = {
  sealed: Date.parse("2026-10-04T08:05:00+08:00"),
  later: Date.parse("2026-10-04T08:08:00+08:00"),
};

function cal(over: Partial<CalibrationBatch> = {}): CalibrationBatch {
  return {
    id: "CAL-Q3",
    deviceId: "LPC-A07",
    label: "Q3",
    issuedAt: Date.parse("2026-07-01T00:00:00+08:00"),
    thresholds: seedThresholds(),
    approved: true,
    version: 1,
    updatedAt: 0,
    ...over,
  };
}

function rec(over: Partial<InspectionRecord> = {}): InspectionRecord {
  const sealedAt = T.sealed;
  return {
    id: "r1",
    roomId: "CR-1201",
    isoClass: "ISO 5",
    periodKey: periodKeyOf(sealedAt),
    sealedAt,
    counts: { "0.5um": 4000, "5um": 20 },
    calibrationId: "CAL-Q3",
    inspector: "甲",
    origin: "巡检端A",
    handoverBatchId: null,
    capturedAt: sealedAt + 60_000,
    version: 1,
    updatedAt: 0,
    ...over,
  };
}

function ticket(basisCal: CalibrationBatch | null, r: InspectionRecord, over: Partial<ExceptionTicket> = {}): ExceptionTicket {
  const now = Date.now();
  return {
    id: ticketIdOf(r.roomId, r.periodKey),
    roomId: r.roomId,
    periodKey: r.periodKey,
    status: "pending",
    recordId: r.id,
    basis: buildBasis(r, basisCal),
    conclusion: null,
    handler: null,
    confirmedAt: null,
    history: [],
    sig: null,
    version: 1,
    updatedAt: now,
    ...over,
  };
}

// ---------- 规则1：同房间同时段两份原始记录保留 + 封条时间定先后 ----------

test("同房间同时段两份记录归为冲突，差异被标出，建议选封条更早的一份", () => {
  const rA = rec({ id: "rA", origin: "巡检端A", counts: { "0.5um": 3800, "5um": 20 }, sealedAt: T.sealed, capturedAt: T.sealed + 60_000 });
  // B 封条更早 3 分钟，但上传（capturedAt）更晚
  const rB = rec({ id: "rB", origin: "巡检端B", counts: { "0.5um": 4250, "5um": 24 }, sealedAt: T.sealed - 3 * 60_000, capturedAt: T.later + 30 * 60_000 });
  const views = buildConflictViews([rA, rB], []);
  assert.equal(views.length, 1);
  const v = views[0];
  assert.deepEqual(v.records.map((r) => r.id), ["rB", "rA"], "按封条时间排序，与上传时间无关");
  assert.equal(v.suggestedRecordId, "rB");
  assert.ok(v.differences.find((d) => d.field.includes("0.5"))?.divergent);
  assert.ok(v.differences.find((d) => d.field.includes("5µm"))?.divergent);
  assert.equal(v.chosenRecordId, null);

  // 复核员选用 A；之后顺序仍以封条展示，且选择被记录
  const resolution: ConflictResolution = {
    id: v.id,
    roomId: v.roomId,
    periodKey: v.periodKey,
    chosenRecordId: "rA",
    suggestedRecordId: "rB",
    resolvedBy: "复核员",
    sealTimeBasis: rA.sealedAt,
    version: 1,
    updatedAt: Date.now(),
  };
  const after = buildConflictViews([rA, rB], [resolution]);
  assert.equal(after[0].chosenRecordId, "rA");
});

test("合并实体时后上传不能盖掉现场封条时间", () => {
  const local = rec({ id: "rA", version: 1, sealedAt: T.sealed, capturedAt: T.sealed + 60_000 });
  const remote = rec({ id: "rA", version: 2, sealedAt: T.sealed, capturedAt: T.later + 30 * 60_000 });
  const merged = mergeRecord(local, remote);
  assert.equal(merged.version, 2, "版本取新");
  assert.equal(merged.sealedAt, T.sealed, "封条时间保持现场原值");
});

// ---------- 规则2：校准换批，未审批失效重算，已确认冻结 ----------

test("换批后未审批单失效并按新阈值重算为合格", () => {
  const q3 = cal();
  const r = rec({ counts: { "0.5um": 4000 } }); // 3520 超限
  const t0 = ticket(q3, r);
  assert.ok(t0.basis?.exceeded);

  const now = Date.parse("2026-10-04T09:00:00+08:00");
  const q4 = cal({
    id: "CAL-Q4",
    issuedAt: now - 1000,
    thresholds: { ...seedThresholds(), "ISO 5": { "0.5um": 4200, "5um": 35 } },
  });
  const t1 = refreshTicket(t0, [r], [q3, q4], [], "LPC-A07", now);
  assert.equal(t1.status, "pending");
  assert.equal(t1.basis?.calibrationId, "CAL-Q4");
  assert.equal(t1.basis?.exceeded, false, "4000 < 新阈值4200 => 合格");
  assert.ok(t1.history.some((e) => e.type === "invalidated"));
  assert.ok(t1.history.some((e) => e.type === "recomputed"));
});

test("已确认处理单在换批后冻结：保留当时阈值和校准编号", () => {
  const q3 = cal();
  const r = rec({ counts: { "0.5um": 4000 } });
  const confirmed = confirmTicket(ticket(q3, r), "复核员", "已处理", Date.now());
  const now = Date.parse("2026-10-04T10:00:00+08:00");
  const q4 = cal({ id: "CAL-Q4", issuedAt: now - 1000, thresholds: { ...seedThresholds(), "ISO 5": { "0.5um": 4200, "5um": 35 } } });
  const after = refreshTicket(confirmed, [r], [q3, q4], [], "LPC-A07", now);
  assert.strictEqual(after, confirmed);
  assert.equal(after.basis?.calibrationId, "CAL-Q3");
  assert.equal(after.basis?.thresholds["0.5um"], 3520, "旧阈值随确认单保留");
  assert.equal(after.status, "confirmed");
});

// ---------- 规则3：崩溃恢复从最近完整交接批次，只补未完成项 ----------

test("恢复只重放最近完整检查点之后未 ack 的操作", () => {
  const t0 = Date.parse("2026-10-03T22:00:00+08:00");
  const hbComplete: HandoverBatch = {
    id: "HB-OLD",
    shiftLabel: "昨夜",
    openedAt: t0,
    closedAt: t0 + 3600_000,
    checkpointAt: t0 + 3600_000,
    status: "complete",
    recordIds: ["r1"],
    version: 1,
    updatedAt: t0 + 3600_000,
  };
  const hbOpen: HandoverBatch = {
    id: "HB-NEW",
    shiftLabel: "今夜",
    openedAt: t0 + 4 * 3600_000,
    closedAt: null,
    checkpointAt: null,
    status: "open",
    recordIds: [],
    version: 1,
    updatedAt: t0 + 4 * 3600_000,
  };
  const rDone = rec({ id: "r1", handoverBatchId: "HB-OLD" });
  const rOpen = rec({ id: "r2", handoverBatchId: "HB-NEW", sealedAt: t0 + 5 * 3600_000 });
  const opAcked: OutboxOp = { id: "op1", type: "upsertRecord", entityId: "r1", payload: {}, createdAt: t0 + 3000_000, status: "acked", tries: 1 };
  const opPending: OutboxOp = { id: "op2", type: "upsertRecord", entityId: "r2", payload: {}, createdAt: t0 + 5 * 3600_000, status: "queued", tries: 0 };
  const report = planRecovery([hbComplete, hbOpen], [rDone, rOpen], [opAcked, opPending], t0 + 6 * 3600_000);
  assert.equal(report.lastCompleteHandoverId, "HB-OLD");
  assert.deepEqual(report.replayedOpIds, ["op2"], "检查点前的 ack 操作不重放");
  assert.deepEqual(report.unfinishedRecordIds, ["r2"]);
  assert.equal(report.openHandoverId, "HB-NEW");
});

// ---------- 规则4：重复提交幂等，不多出处理单 ----------

test("相同幂等操作重复应用被服务器去重；确定性编号下单据只有一张", () => {
  globalThis.localStorage?.clear?.();
  const state = loadServerState();
  const r = rec();
  const t = ticket(cal(), r);
  const mkOp = (id: string, entity: unknown): OutboxOp => ({
    id,
    type: "upsertTicket",
    entityId: t.id,
    payload: entity,
    createdAt: Date.now(),
    status: "queued",
    tries: 0,
  });
  const op1 = mkOp("op-fixed", t);
  assert.equal(serverApply(state, op1).deduped, false);
  const op2 = mkOp("op-fixed", t); // 崩溃后重放同一操作
  assert.equal(serverApply(state, op2).deduped, true);
  assert.equal(Object.keys(state.tickets).length, 1, "处理单没有多出");

  // 双击重复提交：即使操作 id 不同，实体编号 T|房间|时段 相同，仍然只一张
  const op3 = mkOp("op-second-click", t);
  assert.equal(serverApply(state, op3).deduped, false);
  assert.equal(Object.keys(state.tickets).length, 1);
});

// ---------- 规则5：旧记录缺校准编号 => 待核，不参加审批 ----------

test("缺校准编号的记录其处理单进入待核且无判定依据", () => {
  const q3 = cal();
  const r = rec({ calibrationId: null, counts: { "0.5um": 999_999 } });
  const t0 = ticket(null, r, { basis: null });
  const out = refreshTicket(t0, [r], [q3], [], "LPC-A07", Date.now());
  assert.ok(out, "仍需保留处理单以待核");
  assert.equal(out.basis, null);
  assert.ok(out.history.some((e) => e.type === "pending-verify"));
});

test("测量时未生效的批次不会被选用", () => {
  const q3 = cal({ issuedAt: Date.parse("2026-10-04T09:00:00+08:00") });
  const picked = activeCalibrationAt([q3], "LPC-A07", T.sealed);
  assert.equal(picked, null);
});

test("处理单签名在结论不变时稳定", () => {
  const t = ticket(cal(), rec());
  assert.equal(ticketSig(t), ticketSig({ ...t }));
});
