// AI 設定：model、時限、重試次數。改 model 或者 prompt 之前，要用評估（Phase 6）對比結果
import "../env";

export const GEMINI_MODEL = "gemini-3.8-flash";

/**
 * aiAnalysis 結構版本：冇呢個欄位 = 1（舊格式，有 confidenceScore）；2 = Phase 1；
 * 3 = Phase 2（gate / findings / evidence / triage / uncertainty，緊急程度由程式決定）；
 * 4 = Phase 3（建議改用建議庫代碼 advice，AI 最多補充一句 aiNote）；
 * 5 = Phase 5 起（加 matching：需要嘅 NGO 能力、物種唔一致）
 */
export const SCHEMA_VERSION = 5;

/** true = 每宗案件分析兩次，兩次唔一致就用較高等級並要人手覆核（token 成本加倍；每日額度仍然按案件計） */
export const AI_OBSERVE_TWICE = process.env.AI_OBSERVE_TWICE === "1";

export function getGeminiApiKey(): string | undefined {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENAI_API_KEY
  );
}

// 讀整數環境變數，超出範圍就用預設值
function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** 每次 Gemini HTTP 請求嘅時限 */
export const AI_TIMEOUT_MS = envInt("AI_TIMEOUT_MS", 30_000, 5_000, 120_000);
/** 每次分析最多試幾次 HTTP 請求（包括第一次） */
export const MAX_HTTP_ATTEMPTS = 3;
/** 每次分析（包括重試同等待）嘅總時限；超過就唔再開新嘅請求 */
export const RUN_DEADLINE_MS = Math.round(AI_TIMEOUT_MS * 2.5);
/** 每宗案件每種觸發（建立／修改）最多分析幾次；暫時性錯誤先會再試 */
export const MAX_RUNS_PER_CASE = 3;
/** 分析進行中嘅鎖有效期：要長過總時限 + 讀相 + 寫入；instance 中途死咗，過期後可以再試 */
export const RUN_LEASE_MS = RUN_DEADLINE_MS + 45_000;

/** 全部 instance 合計每日 AI 分析上限（Firestore aiQuota/{UTC 日期}，按案件計，重試唔再扣） */
export const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 500;

// ---------- Cloud Tasks（Phase 4）----------
// 三個都設定咗先會用 Cloud Tasks；否則喺 request 入面直接分析（本機開發用，production 一定要設定）
const QUEUE_RE = /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/queues\/[A-Za-z0-9-]+$/;
const rawQueue = (process.env.AI_TASKS_QUEUE || "").trim();
/** projects/{project}/locations/{region}/queues/{queue} */
export const AI_TASKS_QUEUE = QUEUE_RE.test(rawQueue) ? rawQueue : "";
/** Cloud Tasks 用嚟簽 OIDC token 嘅服務帳戶（handler 會核對 token 嘅 email 係咪佢） */
export const AI_TASKS_SERVICE_ACCOUNT = (process.env.AI_TASKS_SERVICE_ACCOUNT || "").trim();
const publicBase = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
/** Cloud Tasks 會 POST 去呢個網址；亦係 OIDC token 嘅 audience。預設 = PUBLIC_BASE_URL + handler 路徑 */
export const AI_TASKS_HANDLER_URL = (
  process.env.AI_TASKS_HANDLER_URL || (publicBase ? `${publicBase}/api/internal/tasks/analyze` : "")
).trim();
export const TASKS_ENABLED =
  !!AI_TASKS_QUEUE && !!AI_TASKS_SERVICE_ACCOUNT && /^https:\/\//.test(AI_TASKS_HANDLER_URL);
/** Cloud Tasks 等 handler 回應嘅時限：要長過一次分析（總時限 + 讀相 + 寫入） */
export const TASK_DISPATCH_DEADLINE_S = Math.ceil((RUN_DEADLINE_MS + 60_000) / 1000);
