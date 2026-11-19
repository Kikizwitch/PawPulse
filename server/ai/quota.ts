// AI 每日總上限：Firestore aiQuota/{UTC 日期}，所有 Cloud Run instance 共用同一個計數（以前係每個 instance 各自計）
// 用 transaction 加一，兩個 instance 同時扣都唔會超額
// 按案件計：只喺每宗案件第一次分析先扣，重試唔再扣
// aiQuota 唔喺 firestore.rules 嘅允許清單，前端完全讀寫唔到（最尾嘅 deny all）
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "../firebaseAdmin";
import { AI_DAILY_LIMIT } from "./config";

export const QUOTA_COLLECTION = "aiQuota";

/** UTC 日期，例如 2026-11-17（香港時間早上 8 點換日） */
export function quotaDocId(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** 純函數：目前計數（唔信型別）＋上限 → 可唔可以再用一次 */
export function decideQuota(count: unknown, limit: number): { allowed: boolean; next: number } {
  const n = Number.isInteger(count) && (count as number) >= 0 ? (count as number) : 0;
  return n >= limit ? { allowed: false, next: n } : { allowed: true, next: n + 1 };
}

/** 用一次額度；超出就回傳 false。Firestore 出錯會 throw（由 pipeline 釋放鎖，等之後再試） */
export async function consumeDailyAiQuota(now: Date = new Date()): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.collection(QUOTA_COLLECTION).doc(quotaDocId(now));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = decideQuota(snap.data()?.count, AI_DAILY_LIMIT);
    if (!d.allowed) return false;
    tx.set(ref, { count: d.next, limit: AI_DAILY_LIMIT, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
}
