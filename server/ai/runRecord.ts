// case/{id}/private/aiRun：每次分析嘅技術紀錄（model、prompt 版本、延遲、token、原始回應或者錯誤）
// 只有 server（Admin SDK）寫；firestore.rules 只俾 admin 讀，前端唔可以建立或者修改
// 文件保留最近一次嘅完整紀錄，history 只留最近 10 次嘅摘要（唔留原始回應），控制文件大小
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "../firebaseAdmin";
import type { AiUsage } from "./client";
import type { AnalyzeTrigger } from "./runLock";

export const AI_RUN_DOC_ID = "aiRun";
export const RAW_TEXT_MAX = 20_000;
const HISTORY_MAX = 10;

export type RunOutcome =
  | "done"        // 成功寫入案件
  | "failed"      // Gemini 失敗或者回應唔合格式
  | "skipped"     // 冇 call Gemini（例如超出每日額度）
  | "superseded"; // 分析完先發現案件已經被修改或者已有結果，冇寫入

/** 兩次分析嘅比較（AI_OBSERVE_TWICE） */
export interface ConsensusInfo {
  runs: number;
  succeeded: number;
  levels: string[];
  /** 兩次都成功先有 true / false；只有一次成功係 null */
  agreed: boolean | null;
}

export interface AiRunRecord {
  trigger: AnalyzeTrigger;
  runNumber: number;
  outcome: RunOutcome;
  skipReason: string | null;
  model: string;
  promptVersion: string;
  schemaVersion: number;
  startedAt: string;
  photosSent: number;
  attempts: number;
  latencyMs: number;
  usage: AiUsage | null;
  finishReason: string | null;
  modelVersion: string | null;
  /** 寫入案件嘅緊急等級；冇寫入就係 null */
  urgency: string | null;
  /** triage 結果（評估用）；冇分析成功就係 null */
  triage: {
    level: string;
    reasonCodes: string[];
    needsHumanReview: boolean;
    rulesVersion: string;
    modelSuggestion: string | null;
  } | null;
  /** AI_OBSERVE_TWICE 開咗先有 */
  consensus: ConsensusInfo | null;
  rawText: string | null;
  rawTextTruncated: boolean;
  error: { kind: string; status: number | null; message: string } | null;
}

export function capRawText(text: string | null): { rawText: string | null; rawTextTruncated: boolean } {
  if (text === null) return { rawText: null, rawTextTruncated: false };
  return { rawText: text.slice(0, RAW_TEXT_MAX), rawTextTruncated: text.length > RAW_TEXT_MAX };
}

function summary(r: AiRunRecord) {
  return {
    trigger: r.trigger,
    runNumber: r.runNumber,
    outcome: r.outcome,
    skipReason: r.skipReason,
    promptVersion: r.promptVersion,
    startedAt: r.startedAt,
    attempts: r.attempts,
    latencyMs: r.latencyMs,
    totalTokens: r.usage?.totalTokens ?? null,
    urgency: r.urgency,
    needsHumanReview: r.triage?.needsHumanReview ?? null,
    errorKind: r.error?.kind ?? null,
  };
}

export async function writeRunRecord(caseId: string, record: AiRunRecord): Promise<void> {
  const db = getAdminDb();
  const ref = db.collection("case").doc(caseId).collection("private").doc(AI_RUN_DOC_ID);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.data()?.history;
    const history = [...(Array.isArray(prev) ? prev : []), summary(record)].slice(-HISTORY_MAX);
    tx.set(ref, { ...record, history, finishedAt: FieldValue.serverTimestamp() });
  });
}
