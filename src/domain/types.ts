// 领域模型：巡检记录 / 异常处理单 / 校准批次 / 交接批次 / 同步出站操作
// 所有时间戳为 epoch ms。现场先后只认 sealedAt（现场封条时间），不认上传时间。

export type ISOClass = "ISO 5" | "ISO 6" | "ISO 7" | "黄光区";
export type ParticleKind = "0.5um" | "5um";
export type ParticleCounts = Partial<Record<ParticleKind, number>>;
export type ThresholdTable = Record<string, Partial<Record<ParticleKind, number>>>;
export type DeviceOrigin = "巡检端A" | "巡检端B";

export interface CalibrationBatch {
  id: string; // 校准编号，如 CAL-2026Q3
  deviceId: string; // 粒子计数器编号
  label: string;
  issuedAt: number; // 生效时间
  thresholds: ThresholdTable; // 各洁净等级阈值（粒/m³）
  approved: boolean;
  version: number;
  updatedAt: number;
}

export interface InspectionRecord {
  id: string; // 本机生成的 uuid，两条重复记录各自保留
  roomId: string;
  isoClass: ISOClass;
  periodKey: string; // 巡检时段，如 2026-10-04 08:00
  sealedAt: number; // 现场封条时间 —— 现场先后的唯一依据
  counts: ParticleCounts;
  calibrationId: string | null; // 旧记录可能缺失 => 待核
  inspector: string;
  origin: DeviceOrigin;
  handoverBatchId: string | null; // 所属交接批次（崩溃恢复用）
  capturedAt: number; // 本机录入/上传时间，仅作展示，不参与现场排序
  version: number;
  updatedAt: number;
  deleted?: boolean;
}

export type TicketStatus = "pending" | "confirmed";

export interface TicketEvent {
  at: number;
  type: "created" | "recomputed" | "invalidated" | "pending-verify" | "confirmed" | "note";
  message: string;
  calibrationId?: string | null;
}

/** 判定依据快照：确认那一刻的阈值与校准编号被永久冻结 */
export interface TicketBasis {
  calibrationId: string;
  sealedAt: number;
  counts: ParticleCounts;
  thresholds: Partial<Record<ParticleKind, number>>;
  violations: { kind: ParticleKind; value: number; limit: number }[];
  exceeded: boolean;
}

export interface ExceptionTicket {
  id: string; // 确定性编号 T|房间|时段，重复提交不会产生第二张
  roomId: string;
  periodKey: string;
  status: TicketStatus;
  recordId: string | null; // 冲突解决后指向被选用记录
  basis: TicketBasis | null; // 已确认单永久保留当时阈值/校准编号
  conclusion: string | null;
  handler: string | null;
  confirmedAt: number | null;
  history: TicketEvent[];
  sig: string | null; // 结论内容签名，内容不变不重算、不重发
  version: number;
  updatedAt: number;
}

export interface ConflictResolution {
  id: string; // C|房间|时段
  roomId: string;
  periodKey: string;
  chosenRecordId: string;
  suggestedRecordId: string; // 按封条时间的建议项
  resolvedBy: string;
  sealTimeBasis: number; // 被选记录的封条时间
  version: number;
  updatedAt: number;
}

export interface HandoverBatch {
  id: string;
  shiftLabel: string;
  openedAt: number;
  closedAt: number | null; // 完整交接时间
  checkpointAt: number | null; // 本地持久化检查点时间
  status: "open" | "complete";
  recordIds: string[];
  version: number;
  updatedAt: number;
}

export type OpType =
  | "upsertRecord"
  | "upsertTicket"
  | "upsertCalibration"
  | "upsertResolution"
  | "upsertHandover";

export interface OutboxOp {
  id: string; // 操作幂等键，重发同一操作服务器只生效一次
  type: OpType;
  entityId: string;
  payload: unknown;
  createdAt: number;
  status: "queued" | "sent" | "acked" | "stale";
  tries: number;
}

export interface SyncLogEntry {
  at: number;
  level: "info" | "ok" | "warn";
  message: string;
}

export interface RecoveryReport {
  at: number;
  lastCompleteHandoverId: string | null;
  lastCompleteAt: number | null;
  replayedOpIds: string[];
  unfinishedRecordIds: string[];
  openHandoverId: string | null;
}

export interface ConflictView {
  id: string;
  roomId: string;
  periodKey: string;
  records: InspectionRecord[];
  suggestedRecordId: string;
  chosenRecordId: string | null;
  differences: {
    field: string;
    values: { recordId: string; value: string; raw: string | number }[];
    divergent: boolean;
  }[];
}
