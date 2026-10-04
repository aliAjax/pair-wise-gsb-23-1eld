// 端到端：用模拟服务器 + 纯逻辑复刻同步引擎主流程（不依赖浏览器/IndexedDB）。
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
  buildConflictViews,
  confirmTicket,
  periodKeyOf,
  planRecovery,
  refreshTicket,
  resolutionIdOf,
  seedThresholds,
} from "../src/domain/logic";
import { loadServerState, serverApply, serverPull } from "../src/store/mockServer";

const DEVICE = "LPC-A07";
const now0 = Date.parse("2026-10-04T08:00:00+08:00");
let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function makeCal(id: string, issuedAt: number, iso5: { "0.5um": number; "5um": number }): CalibrationBatch {
  return {
    id,
    deviceId: DEVICE,
    label: id,
    issuedAt,
    thresholds: { ...seedThresholds(), "ISO 5": iso5 },
    approved: true,
    version: 1,
    updatedAt: issuedAt,
  };
}

function makeRecord(part: {
  id: string;
  roomId: string;
  isoClass: InspectionRecord["isoClass"];
  sealedAt: number;
  counts: InspectionRecord["counts"];
  origin: InspectionRecord["origin"];
  calibrationId: string | null;
  handoverBatchId: string | null;
}): InspectionRecord {
  return {
    inspector: part.origin === "巡检端A" ? "甲" : "乙",
    capturedAt: part.sealedAt + 120_000,
    periodKey: periodKeyOf(part.sealedAt),
    version: 1,
    updatedAt: part.sealedAt,
    ...part,
  };
}

function opFor(entity: { id: string }, type: OutboxOp["type"], at: number, id = uid("op")): OutboxOp {
  return { id, type, entityId: entity.id, payload: clone(entity), createdAt: at, status: "queued", tries: 0 };
}

function sync(outbox: OutboxOp[], local: {
  records: InspectionRecord[];
  tickets: ExceptionTicket[];
  calibrations: CalibrationBatch[];
  resolutions: ConflictResolution[];
  handovers: HandoverBatch[];
}, cursor: number, at: number): { cursor: number; deduped: number } {
  const server = loadServerState();
  let deduped = 0;
  for (const op of outbox) {
    if (op.status === "acked") continue;
    const r = serverApply(server, op);
    if (r.deduped) deduped++;
    op.status = "acked";
  }
  const chunk = serverPull(server, cursor);
  for (const ch of chunk.changed) {
    const map = {
      records: local.records,
      tickets: local.tickets,
      calibrations: local.calibrations,
      resolutions: local.resolutions,
      handovers: local.handovers,
    }[ch.kind] as { id: string; version: number }[];
    const idx = map.findIndex((x) => x.id === (ch.entity as { id: string }).id);
    if (idx < 0) map.push(ch.entity as never);
    else if ((ch.entity as { version: number }).version > map[idx].version) map[idx] = ch.entity as never;
  }
  // pull 后重算所有未审批单
  local.tickets = local.tickets.map((t) =>
    refreshTicket(t, local.records, local.calibrations, local.resolutions, DEVICE, at) ?? t,
  );
  return { cursor: chunk.serverSeq, deduped };
}

test("E2E：断网双端记录→合并选用→换批重算→确认冻结→崩溃重放，全程不多单", () => {
  localStorage.clear();
  const q3 = makeCal("CAL-Q3", now0 - 30 * 86400_000, { "0.5um": 3520, "5um": 29 });
  let cursor = 0;

  // ---- 初始状态：校准批次已在服务器 ----
  {
    const server = loadServerState();
    serverApply(server, opFor(q3, "upsertCalibration", now0 - 1000));
    cursor = server.seq;
  }

  // ---- 断网：巡检端A、B 分别在洁净室记录同一房间同一时段 ----
  const hb = "HB-NIGHT";
  const recA = makeRecord({
    id: "rec-A", roomId: "CR-1201", isoClass: "ISO 5",
    sealedAt: now0 + 5 * 60_000, counts: { "0.5um": 3800, "5um": 20 },
    origin: "巡检端A", calibrationId: "CAL-Q3", handoverBatchId: hb,
  });
  // B 的封条早 3 分钟，但回办公区整理时才上传
  const recB = makeRecord({
    id: "rec-B", roomId: "CR-1201", isoClass: "ISO 5",
    sealedAt: now0 + 2 * 60_000, counts: { "0.5um": 4250, "5um": 24 },
    origin: "巡检端B", calibrationId: "CAL-Q3", handoverBatchId: hb,
  });
  recA.capturedAt = now0 + 40 * 60_000;
  recB.capturedAt = now0 + 55 * 60_000;

  const local = {
    records: [recA, recB],
    tickets: [] as ExceptionTicket[],
    calibrations: [q3],
    resolutions: [] as ConflictResolution[],
    handovers: [] as HandoverBatch[],
  };

  // 初始对账：未选用时按封条建议（B 更早），Q3 下 4250>3520 超限，建一张 pending 单
  const t0 = refreshTicket(
    {
      id: "T|CR-1201|" + periodKeyOf(recA.sealedAt),
      roomId: "CR-1201", periodKey: recA.periodKey, status: "pending",
      recordId: null, basis: null, conclusion: null, handler: null, confirmedAt: null,
      history: [], sig: null, version: 1, updatedAt: now0,
    },
    local.records, local.calibrations, [], DEVICE, now0,
  )!;
  local.tickets = [t0];
  assert.equal(t0.recordId, "rec-B", "默认建议封条更早的 B");
  assert.equal(t0.basis?.exceeded, true);

  // ---- 回办公区恢复网络：合并。重复投递一次，幂等不多单 ----
  const outbox1 = [
    opFor(recA, "upsertRecord", recA.capturedAt),
    opFor(recB, "upsertRecord", recB.capturedAt),
    opFor(t0, "upsertTicket", now0),
  ];
  const dup = clone(outbox1[2]); // 崩溃后重放同一操作
  dup.id = outbox1[2].id;
  const r1 = sync([...outbox1, dup], local, cursor, now0 + 60 * 60_000);
  cursor = r1.cursor;
  assert.equal(r1.deduped, 1);
  const server = loadServerState();
  assert.equal(Object.keys(server.records).length, 2);
  assert.equal(Object.keys(server.tickets).length, 1);

  // 冲突视图：两份原始值都在、差异标出、建议 B
  const views = buildConflictViews(local.records, local.resolutions);
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].records.map((x) => x.id), ["rec-B", "rec-A"]);
  assert.ok(views[0].differences.every((d) => d.divergent));

  // ---- 复核员按现场封条时间选用（选用 A：演示选择权在复核员，依据封条） ----
  const resolution: ConflictResolution = {
    id: resolutionIdOf("CR-1201", recA.periodKey),
    roomId: "CR-1201", periodKey: recA.periodKey,
    chosenRecordId: "rec-A", suggestedRecordId: "rec-B",
    resolvedBy: "复核员", sealTimeBasis: recA.sealedAt, version: 1, updatedAt: now0,
  };
  local.resolutions = [resolution];
  let t1 = refreshTicket(local.tickets[0], local.records, local.calibrations, local.resolutions, DEVICE, now0)!;
  assert.equal(t1.recordId, "rec-A");
  assert.equal(t1.basis?.exceeded, true, "A 的 3800 在 Q3 下仍超限");
  t1 = { ...t1, version: 2, updatedAt: now0 };
  local.tickets = [t1];

  // ---- 校准换批 Q4：ISO5 0.5µm 阈值 3520→4200；未审批单失效重算为合格 ----
  const q4 = makeCal("CAL-Q4", now0 + 2 * 3600_000, { "0.5um": 4200, "5um": 35 });
  local.calibrations.push(q4);
  const outbox2 = [opFor(resolution, "upsertResolution", now0), opFor(t1, "upsertTicket", now0), opFor(q4, "upsertCalibration", q4.issuedAt)];
  sync(outbox2, local, cursor, q4.issuedAt + 1000);
  cursor = loadServerState().seq;
  const t2 = local.tickets[0];
  assert.equal(t2.basis?.calibrationId, "CAL-Q4");
  assert.equal(t2.basis?.exceeded, false);
  assert.ok(t2.history.some((h) => h.type === "invalidated"));

  // ---- 复核确认：冻结当时（Q4）依据 ----
  let confirmed = confirmTicket(t2, "复核员", "已复测合格，结案", q4.issuedAt + 3600_000);
  confirmed = { ...confirmed, version: 3, updatedAt: q4.issuedAt + 3600_000 };
  local.tickets = [confirmed];
  sync([opFor(confirmed, "upsertTicket", confirmed.updatedAt)], local, cursor, confirmed.updatedAt);

  // ---- 再来 Q5（阈值又收紧）：已确认单必须冻结 Q4 ----
  const q5 = makeCal("CAL-Q5", q4.issuedAt + 7200_000, { "0.5um": 3000, "5um": 25 });
  local.calibrations.push(q5);
  const frozen = refreshTicket(local.tickets[0], local.records, local.calibrations, local.resolutions, DEVICE, q5.issuedAt)!;
  assert.strictEqual(frozen, local.tickets[0]);
  assert.equal(frozen.basis?.calibrationId, "CAL-Q4");
  assert.equal(frozen.basis?.thresholds["0.5um"], 4200);

  // ---- 浏览器崩溃：未 ack 操作不重放已完成项，只补未完成交接批次 ----
  const completeHb: HandoverBatch = {
    id: "HB-OLD", shiftLabel: "昨批", openedAt: now0 - 3600_000,
    closedAt: now0 - 1800_000, checkpointAt: now0 - 1800_000, status: "complete",
    recordIds: [], version: 1, updatedAt: now0 - 1800_000,
  };
  const nightHb: HandoverBatch = {
    id: hb, shiftLabel: "今夜", openedAt: now0, closedAt: null, checkpointAt: null,
    status: "open", recordIds: ["rec-A", "rec-B"], version: 1, updatedAt: now0,
  };
  const oldOp: OutboxOp = { id: "old", type: "upsertRecord", entityId: "x", payload: {}, createdAt: now0 - 2000_000, status: "queued", tries: 0 };
  const pendingOp: OutboxOp = { id: "pending", type: "upsertTicket", entityId: t0.id, payload: {}, createdAt: now0 + 100_000, status: "queued", tries: 0 };
  const report = planRecovery([completeHb, nightHb], local.records, [oldOp, pendingOp], Date.now());
  assert.equal(report.lastCompleteHandoverId, "HB-OLD");
  assert.deepEqual(report.replayedOpIds, ["pending"]);
  assert.deepEqual(report.unfinishedRecordIds.sort(), ["rec-A", "rec-B"]);

  // 重放 pendingOp：服务器按操作 id 或实体 id 都不会产生第二张单
  const before = Object.keys(loadServerState().tickets).length;
  const s2 = loadServerState();
  serverApply(s2, { ...pendingOp, payload: clone(confirmed) });
  assert.equal(Object.keys(s2.tickets).length, before);
});
