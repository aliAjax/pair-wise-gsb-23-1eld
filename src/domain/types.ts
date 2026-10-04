// 领域模型：洁净室巡检（断网续作 / 合并 / 校准重算 / 崩溃恢复）

export type IsoClass = "ISO 5" | "ISO 6" | "ISO 7" | "ISO 8";

/** 某洁净等级下的判定阈值（来自设备校准批次） */
export interface Thresholds {
  particle05: number; // ≥0.5µm 粒子上限（个/m³）
  tempMin: number;
  tempMax: number;
  humidityMin: number;
  humidityMax: number;
  pressureMin: number; // 压差下限 Pa
}

/** 设备校准批次：阈值随批次变化 */
export interface CalibrationBatch {
  id: string;
  deviceId: string;
  activatedAt: string;
  status: "active" | "superseded";
  thresholds: Record<IsoClass, Thresholds>;
}

/** 巡检记录：原始值一经录入永不覆盖 */
export interface InspectionRecord {
  id: string;
  roomId: string;
  isoClass: IsoClass;
  slot: string; // 时段，如 "2026-10-04 · 夜班"
  particle05: number;
  temperature: number;
  humidity: number;
  pressure: number;
  sealTime: string; // 现场封条时间（现场先后的唯一依据）
  createdAt: string; // 本地创建/上传时间，不参与现场先后判定
  origin: "local" | "remote";
  synced: boolean;
  calibrationId: string | null; // null = 旧记录缺校准编号 → 待核
  note: string;
  conflictGroupId: string | null;
  chosen: boolean; // 复核员选用的那份
  supersededBy: string | null; // 被哪份记录取代（原始值仍保留）
}

export type TicketStatus = "pending" | "confirmed" | "invalidated" | "pendingVerification";

/** 异常处理单：确认后冻结当时的阈值快照与校准编号 */
export interface AnomalyTicket {
  id: string; // 确定性 id：TKT-<记录id>@<校准批次>，重复提交/重放不会重复生成
  recordId: string;
  roomId: string;
  slot: string;
  violations: string[];
  thresholdSnapshot: Thresholds | null; // 待核旧记录无快照
  calibrationId: string | null;
  status: TicketStatus;
  createdAt: string;
  confirmedBy?: string;
  confirmedAt?: string;
  invalidatedReason?: string;
}

export type OpType =
  | "addRecord"
  | "mergeRemote"
  | "resolveConflict"
  | "approveTicket"
  | "activateCalibration";

/** 操作日志条目：幂等键保证重复提交/崩溃重放不产生重复结果 */
export interface Op {
  idemKey: string;
  batchId: string;
  type: OpType;
  summary: string;
  payload: unknown;
  appliedAt: string;
  applied: boolean; // false = 幂等去重被跳过
  result?: unknown;
}

/** 交接批次：崩溃恢复的完整性边界 */
export interface HandoffBatch {
  id: string;
  openedAt: string;
  sealedAt: string | null; // null = 进行中的批次
  opCount: number;
}

export interface AppState {
  records: InspectionRecord[];
  tickets: AnomalyTicket[];
  calibrations: CalibrationBatch[];
  appliedKeys: string[]; // 已应用操作的幂等键
  evaluated: Record<string, string>; // recordId -> 评估时使用的校准批次
  outbox: string[]; // 待同步记录 id
  lastSyncAt: string | null;
}

export interface Persisted {
  state: AppState;
  ops: Op[];
  batches: HandoffBatch[];
  lastSealedSnapshot: { batchId: string; state: AppState } | null;
}

export interface RecoveryReport {
  recoveredFromBatchId: string | null;
  replayedOps: number;
  skippedDuplicates: number;
  completedItems: string[];
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  openConflicts: number;
}

export interface CalibrationReport {
  batchId: string;
  invalidated: number; // 失效的未审批结论
  recomputed: number; // 重算后仍为异常
  cleared: number; // 重算后转为正常
  newDetected: number; // 新批次下新检出
  keptConfirmed: number; // 保留不动的已确认处理单
  pendingVerification: number; // 缺校准编号、被排除在审批外的旧记录
}
