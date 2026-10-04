// 模拟服务器（localStorage 持久化的实体包）。
// 关键承诺：
// 1) 按操作幂等键去重 —— 崩溃后重放/重复提交，同一操作只生效一次，处理单不会多出；
// 2) 按实体版本号合并，记录的 sealedAt 由各自实体携带，服务器从不用“到达时间”覆盖现场封条时间。

import type {
  CalibrationBatch,
  ConflictResolution,
  ExceptionTicket,
  HandoverBatch,
  InspectionRecord,
  OutboxOp,
} from "../domain/types";

export type EntityKind =
  | "records"
  | "tickets"
  | "calibrations"
  | "resolutions"
  | "handovers";

export interface ServerState {
  records: Record<string, InspectionRecord>;
  tickets: Record<string, ExceptionTicket>;
  calibrations: Record<string, CalibrationBatch>;
  resolutions: Record<string, ConflictResolution>;
  handovers: Record<string, HandoverBatch>;
  appliedOpIds: string[];
  seq: number;
  /** entityId -> 最后变更序号，pull 增量用 */
  mutSeq: Record<string, number>;
}

const KEY = "cleanroom-mock-server-v1";

export function loadServerState(): ServerState {
  const raw = localStorage.getItem(KEY);
  if (raw) return JSON.parse(raw) as ServerState;
  return {
    records: {},
    tickets: {},
    calibrations: {},
    resolutions: {},
    handovers: {},
    appliedOpIds: [],
    seq: 0,
    mutSeq: {},
  };
}

export function saveServerState(state: ServerState) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function resetServerState() {
  localStorage.removeItem(KEY);
}

function bucketOf(state: ServerState, kind: EntityKind): Record<string, unknown> {
  return state[kind];
}

export interface ApplyResult {
  deduped: boolean;
  entityId: string;
}

export function serverApply(state: ServerState, op: OutboxOp): ApplyResult {
  // 同一操作 ID 只生效一次 —— 崩溃重放、双击提交的防线
  if (state.appliedOpIds.includes(op.id)) {
    return { deduped: true, entityId: op.entityId };
  }
  const kind = op.type
    .replace("upsertRecord", "records")
    .replace("upsertTicket", "tickets")
    .replace("upsertCalibration", "calibrations")
    .replace("upsertResolution", "resolutions")
    .replace("upsertHandover", "handovers") as EntityKind;

  const bucket = bucketOf(state, kind) as Record<string, { id: string; version: number }>;
  const incoming = op.payload as { id: string; version: number };
  const existing = bucket[incoming.id];
  // 确定性实体编号（处理单 T|房间|时段）使重复提交指向同一实体；
  // 再叠加版本号，低版本（旧结论）不能盖掉高版本（已确认/重算）。
  if (!existing || incoming.version >= existing.version) {
    bucket[incoming.id] = incoming;
    state.seq += 1;
    state.mutSeq[incoming.id] = state.seq;
  }
  state.appliedOpIds.push(op.id);
  if (state.appliedOpIds.length > 500) state.appliedOpIds.splice(0, state.appliedOpIds.length - 500);
  saveServerState(state);
  return { deduped: false, entityId: incoming.id };
}

export interface PullChunk {
  changed: { kind: EntityKind; entity: unknown }[];
  serverSeq: number;
}

/** 拉取自 sinceSeq 之后变更过的实体 */
export function serverPull(state: ServerState, sinceSeq: number): PullChunk {
  const changed: PullChunk["changed"] = [];
  const kinds: EntityKind[] = ["records", "tickets", "calibrations", "resolutions", "handovers"];
  for (const kind of kinds) {
    const bucket = bucketOf(state, kind) as Record<string, unknown>;
    for (const [id, entity] of Object.entries(bucket)) {
      if ((state.mutSeq[id] ?? 0) > sinceSeq) {
        changed.push({ kind, entity });
      }
    }
  }
  return { changed, serverSeq: state.seq };
}

export function serverSeedUpsert(state: ServerState, kind: EntityKind, entity: unknown) {
  const bucket = bucketOf(state, kind) as Record<string, unknown>;
  const e = entity as { id: string };
  bucket[e.id] = entity;
  state.seq += 1;
  state.mutSeq[e.id] = state.seq;
}
