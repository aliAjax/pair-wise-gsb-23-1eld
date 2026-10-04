// 领域逻辑验证：冲突合并 / 校准重算 / 崩溃恢复 / 幂等去重 / 旧记录待核
import {
  activateCalibration,
  applyOp,
  completeIncomplete,
  conflictGroups,
  evaluateOne,
  groupNeedsReview,
  normalizeConflicts,
  seedPersisted,
  suggestedPick,
  clone,
} from "./src/domain/core";
import type { AppState, InspectionRecord, Op } from "./src/domain/types";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}

function op(type: Op["type"], payload: unknown, idemKey: string): Op {
  return { idemKey, batchId: "HB-T", type, summary: idemKey, payload, appliedAt: "2026-10-04T23:30", applied: false };
}

// --- 1. 冲突：两份原始值保留、按封条时间建议、后上传不盖现场先后 ---
console.log("1. 冲突合并");
{
  const { state } = seedPersisted();
  const groups = conflictGroups(state).filter(groupNeedsReview);
  check("种子中存在 1 组待复核冲突", groups.length === 1);
  const members = groups[0];
  check("两份原始值都保留", members.length === 2);
  const pick = suggestedPick(members);
  check("建议选用封条更早的 R-1005R（尽管它上传更晚）", pick.id === "R-1005R");
  const later = members.find((m) => m.id === "R-1005L")!;
  check("R-1005L 上传更早但不被建议", later.createdAt < pick.createdAt && pick.sealTime < later.sealTime);

  // 复核选用 R-1005R
  const ok = applyOp(state, op("resolveConflict", { groupId: "CG-CR-1201|2026-10-04 · 夜班", chosenId: "R-1005R", reviewer: "林岚" }, "op:resolve:1"));
  check("复核操作生效", ok);
  const loser = state.records.find((r) => r.id === "R-1005L")!;
  check("未选用记录原始值保留", loser.particle05 === 3600 && loser.supersededBy === "R-1005R");
  const loserTicket = state.tickets.find((t) => t.recordId === "R-1005L" && t.status !== "invalidated");
  check("未选用记录的待审批结论作废", !loserTicket);
  check("冲突组已了结", !groupNeedsReview(state.records.filter((r) => r.conflictGroupId === "CG-CR-1201|2026-10-04 · 夜班")));
  const dup = applyOp(state, op("resolveConflict", { groupId: "CG-CR-1201|2026-10-04 · 夜班", chosenId: "R-1005R", reviewer: "林岚" }, "op:resolve:1"));
  check("重复复核被幂等跳过", !dup);
}

// --- 2. 校准批次变更：未审批失效重算、已确认保留、旧记录待核 ---
console.log("2. 校准批次变更");
{
  const { state } = seedPersisted();
  const before = state.tickets.filter((t) => t.status === "pending").length;
  check("变更新前有待审批单", before === 2, before); // R-1001 + R-1005L
  const confirmedBefore = state.tickets.find((t) => t.status === "confirmed")!;
  const snapBefore = JSON.stringify(confirmedBefore.thresholdSnapshot);

  const batch = {
    id: "CAL-2026-10C", deviceId: "PC-3100", activatedAt: "2026-10-04T09:00",
    status: "active" as const,
    thresholds: clone(state.calibrations.find((c) => c.status === "active")!.thresholds),
  };
  batch.thresholds["ISO 5"].particle05 = 3000; // 收紧：R-1005R(2900) 仍正常，R-1001(4100) 仍异常
  const rep = activateCalibration(state, batch, "2026-10-04T09:01");
  check("未审批 2 单失效", rep.invalidated === 2, rep);
  check("R-1001 重算仍异常 → recomputed≥1", rep.recomputed >= 1, rep);
  check("已确认 1 单保留", rep.keptConfirmed === 1);
  check("缺校准编号旧记录 1 条待核除外", rep.pendingVerification === 1);
  const confirmedAfter = state.tickets.find((t) => t.status === "confirmed")!;
  check("已确认单阈值快照与校准编号不变", JSON.stringify(confirmedAfter.thresholdSnapshot) === snapBefore && confirmedAfter.calibrationId === "CAL-2026-03B");
  const legacy = state.tickets.find((t) => t.recordId === "R-1003")!;
  check("旧记录仍为待核、无快照", legacy.status === "pendingVerification" && legacy.thresholdSnapshot === null);
  const approveLegacy = applyOp(state, op("approveTicket", { ticketId: legacy.id, reviewer: "赵衡" }, "op:approve:legacy"));
  check("待核旧记录不能审批", !approveLegacy && legacy.status === "pendingVerification");
  const newPending = state.tickets.filter((t) => t.status === "pending");
  check("重算生成的新待审批单使用新校准编号", newPending.every((t) => t.calibrationId === "CAL-2026-10C"));
}

// --- 3. 崩溃恢复：从最近完整交接批次恢复，只补未完成项，重复不多单 ---
console.log("3. 崩溃恢复");
{
  const persisted = seedPersisted();
  const snapState = persisted.lastSealedSnapshot!.state;
  // 崩溃前在未封存批次里提交了 1 条新记录（已落库）+ 1 次重复提交（未生效）
  const rec: InspectionRecord = {
    id: "R-2001", roomId: "CR-2107", isoClass: "ISO 6", slot: "2026-10-04 · 夜班",
    particle05: 40000, temperature: 22, humidity: 45, pressure: 12,
    sealTime: "2026-10-04T23:10", createdAt: "2026-10-04T23:12",
    origin: "local", synced: false, calibrationId: "CAL-2026-03B",
    note: "", conflictGroupId: null, chosen: false, supersededBy: null,
  };
  const o1 = op("addRecord", rec, "op:addRecord:R-2001");
  const appliedOnce = applyOp(persisted.state, o1);
  o1.applied = appliedOnce; // Store.dispatch 会在应用后回写该标记
  const appliedTwice = applyOp(persisted.state, op("addRecord", rec, "op:addRecord:R-2001"));
  check("崩溃前提交生效一次", appliedOnce);
  check("崩溃前重复提交被去重", !appliedTwice);
  persisted.ops.push(o1, { ...op("addRecord", rec, "op:addRecord:R-2001"), applied: false });
  persisted.batches.push({ id: "HB-0002", openedAt: "2026-10-04T22:00", sealedAt: null, opCount: 1 });

  // 模拟恢复：从快照 + 重放未封存批次
  const base = clone(snapState);
  const sealedIds = new Set(persisted.batches.filter((b) => b.sealedAt).map((b) => b.id));
  const pending = persisted.ops.filter((o) => o.applied && !sealedIds.has(o.batchId));
  let replayed = 0, skipped = 0;
  for (const o of pending) (applyOp(base, o) ? replayed++ : skipped++);
  const completed = completeIncomplete(base, "2026-10-04T23:59");
  check("重放了 1 项已提交操作", replayed === 1, replayed);
  check("恢复后记录不重复", base.records.filter((r) => r.id === "R-2001").length === 1);
  const tickets = base.tickets.filter((t) => t.recordId === "R-2001");
  check("恢复后处理单只有 1 张（40000>35200 超限）", tickets.length === 1, tickets.map((t) => t.id));
  check("待同步项被补齐", base.outbox.includes("R-2001"));
  // 再跑一遍恢复：完全幂等
  const completed2 = completeIncomplete(base, "2026-10-05T00:10");
  check("二次恢复无新增补做项", completed2.length === 0, completed2);
  check("二次恢复处理单仍只有 1 张", base.tickets.filter((t) => t.recordId === "R-2001").length === 1);
}

// --- 4. 合并只增不覆盖 + 评估幂等 ---
console.log("4. 合并与评估幂等");
{
  const { state } = seedPersisted();
  const rec: InspectionRecord = {
    id: "R-1005L", roomId: "CR-1201", isoClass: "ISO 5", slot: "2026-10-04 · 夜班",
    particle05: 9999, temperature: 22, humidity: 45, pressure: 12,
    sealTime: "2026-10-04T22:15", createdAt: "2026-10-04T23:50",
    origin: "remote", synced: true, calibrationId: "CAL-2026-03B",
    note: "对端重复推送", conflictGroupId: null, chosen: false, supersededBy: null,
  };
  const merged = applyOp(state, op("mergeRemote", [rec], "op:merge:dup"));
  check("对端重复推送同 id 记录被整体跳过", !merged);
  const local = state.records.find((r) => r.id === "R-1005L")!;
  check("本地原始值未被覆盖", local.particle05 === 3600);

  const r1001 = state.records.find((r) => r.id === "R-1001")!;
  const t1 = evaluateOne(state, r1001, "2026-10-05T00:00");
  const count = state.tickets.filter((t) => t.recordId === "R-1001").length;
  check("重复评估返回既有处理单，不新增", t1 !== null && count === 1, count);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
