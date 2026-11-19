// NGO 對 AI 結果嘅回饋（Phase 6）：接手後記低實際物種、實際緊急程度、建議有冇用
// 存喺 case/{id}/private/aiFeedback，只可以經 server 寫；admin 同接手咗嘅 NGO 讀到
// 同時記低當時 AI 嘅預測（快照），之後評估可以直接比較，唔使再估邊個版本
import { cleanStr } from "./sanitize";

export const FEEDBACK_SPECIES = ["cat", "dog", "bird", "other", "unknown"] as const;
export const FEEDBACK_URGENCY = ["P0", "P1", "P2"] as const;
export const FEEDBACK_ADVICE = ["yes", "partly", "no", "not_applicable"] as const;
export const FEEDBACK_NOTE_MAX = 500;

export interface FeedbackInput {
  actualSpecies: (typeof FEEDBACK_SPECIES)[number];
  actualUrgency: (typeof FEEDBACK_URGENCY)[number];
  adviceUseful: (typeof FEEDBACK_ADVICE)[number];
  note: string;
}

const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] =>
  typeof v === "string" && (list as readonly string[]).includes(v);

/** 驗證前端送嚟嘅回饋；唔啱就回傳 null */
export function parseFeedback(body: unknown): FeedbackInput | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return null;
  if (!oneOf(FEEDBACK_SPECIES, b.actualSpecies)) return null;
  if (!oneOf(FEEDBACK_URGENCY, b.actualUrgency)) return null;
  if (!oneOf(FEEDBACK_ADVICE, b.adviceUseful)) return null;
  if (b.note !== undefined && typeof b.note !== "string") return null;
  return {
    actualSpecies: b.actualSpecies,
    actualUrgency: b.actualUrgency,
    adviceUseful: b.adviceUseful,
    // 保留換行以外嘅控制字元都刪走
    note: cleanStr(typeof b.note === "string" ? b.note.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "") : "", FEEDBACK_NOTE_MAX),
  };
}

/** 回饋嗰陣 AI 預測咗乜（由案件文件同 private/aiRun 抽出） */
export interface AiPredictionSnapshot {
  urgency: string | null;
  species: string | null;
  needsHumanReview: boolean | null;
  schemaVersion: number | null;
  rulesVersion: string | null;
  promptVersion: string | null;
  model: string | null;
  analyzedAt: string | null;
}

export function predictionSnapshot(
  caseData: Record<string, any> | undefined,
  aiRun: Record<string, any> | undefined
): AiPredictionSnapshot {
  const a = caseData?.aiAnalysis ?? caseData?.geminiResponse ?? null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    // 冇 AI 結果嘅案件，urgency 係 P1 預設值（AI 失敗時嘅後備），一樣要記低
    urgency: str(caseData?.urgency),
    species: str(a?.gate?.speciesCategory) ?? str(a?.identifiedSpecies),
    needsHumanReview: typeof a?.triage?.needsHumanReview === "boolean" ? a.triage.needsHumanReview : null,
    schemaVersion: a ? (Number.isInteger(a.schemaVersion) ? a.schemaVersion : 1) : null,
    rulesVersion: str(a?.triage?.rulesVersion),
    promptVersion: str(aiRun?.promptVersion),
    model: str(aiRun?.model),
    analyzedAt: str(a?.analyzedAt),
  };
}
