import {
  applyOp,
  clone,
  completeIncomplete,
  conflictGroups,
  groupNeedsReview,
  nowIso,
  seedPersisted,
} from "./core";
import type {
  HandoffBatch,
  InspectionRecord,
  Op,
  OpType,
  Persisted,
  RecoveryReport,
  SyncReport,
} from "./types";

const PERSIST_KEY = "hxwl09:persisted:v1";
const SESSION_KEY = "hxwl09:session:v1";
const SERVER_KEY = "hxwl09:server:v1";
const SIM_CRASH_KEY = "hxwl09:simulate-crash";

type Listener = () => void;

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

// 模拟的对端/服务端存储：另一台终端上传的记录先落在这里
interface ServerDb {
  records: InspectionRecord[];
}

function loadServer(): ServerDb {
  try {
    const raw = localStorage.getItem(SERVER_KEY);
    return raw ? (JSON.parse(raw) as ServerDb) : { records: [] };
  } catch {
    return { records: [] };
  }
}

function saveServer(db: ServerDb): void {
  try {
    localStorage.setItem(SERVER_KEY, JSON.stringify(db));
  } catch {
    /* 演示环境忽略容量异常 */
  }
}

/** 模拟另一台终端直接上传（不经过本机状态），下次同步时合并进来 */
export function simulateRemoteUpload(rec: InspectionRecord): void {
  const db = loadServer();
  if (!db.records.some((r) => r.id === rec.id)) {
    db.records.push(rec);
    saveServer(db);
  }
}

export class Store {
  state: Persisted["state"];
  ops: Op[];
  batches: HandoffBatch[];
  lastSealedSnapshot: Persisted["lastSealedSnapshot"];
  recovery: RecoveryReport | null = null;
  private listeners = new Set<Listener>();

  private constructor(p: Persisted) {
    this.state = p.state;
    this.ops = p.ops;
    this.batches = p.batches;
    this.lastSealedSnapshot = p.lastSealedSnapshot;
  }

  static boot(): Store {
    const simCrash = sessionStorage.getItem(SIM_CRASH_KEY) === "1";
    sessionStorage.removeItem(SIM_CRASH_KEY);
    let crashed = simCrash;
    try {
      const prev = localStorage.getItem(SESSION_KEY);
      if (prev && (JSON.parse(prev) as { alive: boolean }).alive) crashed = true;
    } catch {
      /* 标记损坏按未崩溃处理 */
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify({ alive: true }));
    window.addEventListener("beforeunload", () => {
      // 模拟崩溃时故意保留“未正常退出”标记；正常离开则清除
      if (sessionStorage.getItem(SIM_CRASH_KEY) === "1") return;
      localStorage.setItem(SESSION_KEY, JSON.stringify({ alive: false }));
    });

    const persisted = loadPersisted() ?? seedPersisted();
    if (!crashed) return new Store(persisted);

    // 崩溃恢复：回到最近完整交接批次的快照，
    // 重放未封存批次中已提交的操作（幂等），再只补未完成项
    const store = new Store(persisted);
    const snap = persisted.lastSealedSnapshot;
    const base = snap ? clone(snap.state) : seedPersisted().state;
    const sealedIds = new Set(persisted.batches.filter((b) => b.sealedAt).map((b) => b.id));
    const pendingOps = persisted.ops.filter((o) => o.applied && !sealedIds.has(o.batchId));
    let replayed = 0;
    let skipped = 0;
    for (const op of pendingOps) {
      if (applyOp(base, op)) replayed += 1;
      else skipped += 1;
    }
    const completedItems = completeIncomplete(base, nowIso());
    store.state = base;
    store.recovery = {
      recoveredFromBatchId: snap?.batchId ?? null,
      replayedOps: replayed,
      skippedDuplicates: skipped,
      completedItems,
    };
    store.persist();
    return store;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((f) => f());
  }

  private persist(): void {
    const p: Persisted = {
      state: this.state,
      ops: this.ops,
      batches: this.batches,
      lastSealedSnapshot: this.lastSealedSnapshot,
    };
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(p));
    } catch {
      /* 演示环境忽略容量异常 */
    }
  }

  private currentBatch(): HandoffBatch {
    let open = this.batches.find((b) => !b.sealedAt);
    if (!open) {
      open = {
        id: `HB-${String(this.batches.length + 1).padStart(4, "0")}`,
        openedAt: nowIso(),
        sealedAt: null,
        opCount: 0,
      };
      this.batches.push(open);
    }
    return open;
  }

  /** 所有变更都走操作日志：断网时照常工作，恢复连接后随批次交接 */
  dispatch(type: OpType, payload: unknown, idemKey: string, summary: string): { applied: boolean; result?: unknown } {
    const batch = this.currentBatch();
    const op: Op = {
      idemKey,
      batchId: batch.id,
      type,
      summary,
      payload,
      appliedAt: nowIso(),
      applied: false,
    };
    op.applied = applyOp(this.state, op);
    if (op.applied) batch.opCount += 1;
    this.ops.push(op); // 被幂等去重的操作也留痕，便于审计“重复提交未生效”
    this.persist();
    this.emit();
    return { applied: op.applied, result: op.result };
  }

  /** 封存当前交接批次：打一个一致性快照，作为崩溃恢复的最近完整点 */
  sealHandoff(): HandoffBatch | null {
    const open = this.batches.find((b) => !b.sealedAt);
    if (!open) return null;
    open.sealedAt = nowIso();
    this.lastSealedSnapshot = { batchId: open.id, state: clone(this.state) };
    this.persist();
    this.emit();
    return open;
  }

  /** 恢复连接后合并：先推出待同步记录，再拉取对端记录归并（只增不覆盖） */
  sync(): SyncReport {
    const server = loadServer();
    let pushed = 0;
    for (const recId of [...this.state.outbox]) {
      const rec = this.state.records.find((r) => r.id === recId);
      if (!rec) continue;
      if (!server.records.some((r) => r.id === rec.id)) {
        server.records.push({ ...rec, synced: true });
        pushed += 1;
      }
      rec.synced = true;
    }
    this.state.outbox = [];

    const known = new Set(this.state.records.map((r) => r.id));
    const incoming = server.records.filter((r) => !known.has(r.id));
    if (incoming.length > 0) {
      this.dispatch(
        "mergeRemote",
        incoming,
        `op:merge:${incoming.map((r) => r.id).join("+")}`,
        `合并对端 ${incoming.length} 条记录`
      );
    }
    this.state.lastSyncAt = nowIso();
    saveServer(server);
    this.persist();
    this.emit();
    return {
      pushed,
      pulled: incoming.length,
      openConflicts: conflictGroups(this.state).filter(groupNeedsReview).length,
    };
  }

  /** 模拟浏览器崩溃：不清理会话标记直接刷新，启动时走崩溃恢复路径 */
  simulateCrash(): void {
    sessionStorage.setItem(SIM_CRASH_KEY, "1");
    window.location.reload();
  }
}

let instance: Store | null = null;

export function getStore(): Store {
  if (!instance) instance = Store.boot();
  return instance;
}
