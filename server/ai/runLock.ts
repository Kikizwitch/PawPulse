// 分析鎖：取代舊嘅 claimOnce("analyze")
// 舊做法喺 call Gemini 之前已經用咗唯一一次機會，一次暫時性錯誤就令案件永遠停喺 P1、相片全部模糊
// 新做法：serverLocks/{analyze|analyzeEdit}_{caseId} 記錄狀態同次數
//   running  = 分析緊（有租期；instance 中途死咗，過期後可以再試）
//   released = 上次暫時性失敗，可以再試
//   done     = 完成（成功、永久失敗、超出每日額度）
// 每宗案件每種觸發（建立／修改）最多分析 MAX_RUNS_PER_CASE 次，而且一定要喺 15 分鐘時限內
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { FRESH_CASE_WINDOW_MS } from "../cases";
import { getAdminDb } from "../firebaseAdmin";
import { MAX_RUNS_PER_CASE, RUN_LEASE_MS } from "./config";

export type AnalyzeTrigger = "create" | "edit";

/** serverLocks 文件內容（由 Firestore 讀出嚟，唔信型別） */
export interface LockSnapshot {
  state?: unknown;
  runs?: unknown;
  leaseUntil?: unknown;
}

/** 判斷可唔可以分析要用嘅案件資料 */
export interface CaseFacts {
  createdAtMs: number | null;
  editedAtMs: number | null;
  editCount: number;
  hasAnalysis: boolean;
}

export type ClaimRefusal =
  | "already_analyzed" // 已經有分析結果
  | "outside_window"   // 超過 15 分鐘
  | "not_edited"       // 修改觸發，但案件未改過
  | "done"             // 鎖已經完成（包括舊 claimOnce 嘅文件）
  | "in_progress"      // 另一次分析進行緊
  | "max_runs"         // 已經試夠次數
  | "changed";         // 讀相之後案件被修改咗

export type ClaimDecision =
  | { ok: true; runNumber: number; firstRun: boolean }
  | { ok: false; reason: ClaimRefusal };

export function lockId(trigger: AnalyzeTrigger, caseId: string): string {
  return `${trigger === "create" ? "analyze" : "analyzeEdit"}_${caseId}`;
}

export function caseFacts(data: Record<string, any> | undefined): CaseFacts {
  const edited = typeof data?.editedAt === "string" ? Date.parse(data.editedAt) : NaN;
  return {
    createdAtMs: data?.createdAt instanceof Timestamp ? data.createdAt.toMillis() : null,
    editedAtMs: Number.isFinite(edited) ? edited : null,
    editCount: Number(data?.editCount) || 0,
    hasAnalysis: data?.aiAnalysis != null,
  };
}

/** 案件本身可唔可以分析（未睇鎖）；可以就回傳 null */
export function checkCaseEligible(
  c: CaseFacts,
  trigger: AnalyzeTrigger,
  now: number,
  windowMs = FRESH_CASE_WINDOW_MS
): ClaimRefusal | null {
  if (c.hasAnalysis) return "already_analyzed";
  if (trigger === "create") {
    if (c.createdAtMs === null || now - c.createdAtMs >= windowMs) return "outside_window";
  } else {
    if (c.editCount < 1) return "not_edited";
    // 修改觸發：時限由修改時間起計
    if (c.editedAtMs === null || now - c.editedAtMs >= windowMs) return "outside_window";
  }
  return null;
}

/** 純函數：根據鎖同案件狀態決定可唔可以開始新一次分析 */
export function decideClaim(
  lock: LockSnapshot | undefined,
  c: CaseFacts,
  trigger: AnalyzeTrigger,
  now: number,
  maxRuns = MAX_RUNS_PER_CASE,
  windowMs = FRESH_CASE_WINDOW_MS
): ClaimDecision {
  const refusal = checkCaseEligible(c, trigger, now, windowMs);
  if (refusal) return { ok: false, reason: refusal };
  if (!lock) return { ok: true, runNumber: 1, firstRun: true };

  // 舊 claimOnce 文件冇 state，或者 state 唔認得：當已經做過（fail-closed）
  if (lock.state !== "running" && lock.state !== "released") return { ok: false, reason: "done" };
  if (lock.state === "running" && Number(lock.leaseUntil) > now) return { ok: false, reason: "in_progress" };

  // runs 唔係正整數：當已經用晒次數（fail-closed）
  const runs = Number.isInteger(lock.runs) && (lock.runs as number) >= 0 ? (lock.runs as number) : maxRuns;
  if (runs >= maxRuns) return { ok: false, reason: "max_runs" };
  return { ok: true, runNumber: runs + 1, firstRun: false };
}

export interface ClaimedRun {
  runNumber: number;
  firstRun: boolean;
  editCount: number;
}

export type ClaimResult = { ok: true; run: ClaimedRun } | { ok: false; reason: ClaimRefusal | "not_found" };

/**
 * 用 transaction 同時讀案件同鎖，決定之後即刻寫 running（兩個 request 同時嚟只有一個成功）
 * expectedEditCount：讀相嗰陣案件嘅 editCount，唔同即係中途被修改，啲相已經過時
 */
export async function claimRun(caseId: string, trigger: AnalyzeTrigger, expectedEditCount: number): Promise<ClaimResult> {
  const db = getAdminDb();
  const caseRef = db.collection("case").doc(caseId);
  const lockRef = db.collection("serverLocks").doc(lockId(trigger, caseId));

  return db.runTransaction(async (tx): Promise<ClaimResult> => {
    const [caseSnap, lockSnap] = await tx.getAll(caseRef, lockRef);
    if (!caseSnap.exists) return { ok: false, reason: "not_found" };
    const facts = caseFacts(caseSnap.data());
    if (facts.editCount !== expectedEditCount) return { ok: false, reason: "changed" };

    const now = Date.now();
    const d = decideClaim(lockSnap.exists ? (lockSnap.data() as LockSnapshot) : undefined, facts, trigger, now);
    // tsconfig 冇開 strictNullChecks，要用 === false 先收窄到 union 嘅其中一款
    if (d.ok === false) return d;

    tx.set(
      lockRef,
      {
        state: "running",
        runs: d.runNumber,
        leaseUntil: now + RUN_LEASE_MS,
        updatedAt: FieldValue.serverTimestamp(),
        ...(d.firstRun ? { createdAt: FieldValue.serverTimestamp() } : {}),
      },
      { merge: true }
    );
    // 前端用 onSnapshot 睇 aiStatus，顯示「分析中」
    tx.update(caseRef, { aiStatus: "running" });
    return { ok: true, run: { runNumber: d.runNumber, firstRun: d.firstRun, editCount: facts.editCount } };
  });
}

/** 分析完：released = 可以再試；done = 唔再分析 */
export async function finishRun(
  caseId: string,
  trigger: AnalyzeTrigger,
  runNumber: number,
  state: "released" | "done",
  errorKind: string | null
): Promise<void> {
  const db = getAdminDb();
  const lockRef = db.collection("serverLocks").doc(lockId(trigger, caseId));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    // 租期過咗之後另一次分析已經接手：唔好蓋過佢嘅狀態
    if (!snap.exists || snap.data()?.runs !== runNumber) return;
    tx.update(lockRef, {
      state,
      leaseUntil: 0,
      lastErrorKind: errorKind,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}
