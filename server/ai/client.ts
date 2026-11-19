// Gemini client：全個 server 共用一個實例
// generateWithRetry：每次請求有時限；只有暫時性錯誤（429、5xx、超時、網絡）先重試，
// 用指數退避 + 隨機抖動；每次請求都記錄延遲同 token 用量（唔記錄 AI 回應內容）
import {
  ApiError,
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";
import { AI_TIMEOUT_MS, MAX_HTTP_ATTEMPTS, RUN_DEADLINE_MS, getGeminiApiKey } from "./config";

export type AiErrorKind =
  | "timeout"    // 超過時限
  | "rate_limit" // 429
  | "server"     // 5xx
  | "network"    // 連唔到 Gemini
  | "client"     // 其他 4xx（request 格式錯、key 無效等），再試都冇用
  | "blocked"    // 安全過濾擋咗
  | "empty"      // 有回應但冇內容
  | "no_key"     // 未設定 API key
  | "unknown";

// 同一次分析入面即刻再試
const RETRY_IN_RUN = new Set<AiErrorKind>(["timeout", "rate_limit", "server", "network"]);
// 可以釋放鎖，留待之後再分析一次
const RETRY_LATER = new Set<AiErrorKind>([...RETRY_IN_RUN, "empty"]);

// 安全過濾導致嘅結束原因（其餘冇內容嘅情況當 empty）
const BLOCKED_FINISH_REASONS = new Set([
  "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
  "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION",
]);

// 剩低時間少過呢個就唔再開新請求
const MIN_ATTEMPT_MS = 3_000;

export interface AiUsage {
  promptTokens: number | null;
  candidatesTokens: number | null;
  thoughtsTokens: number | null;
  totalTokens: number | null;
}

export interface AiCallResult {
  text: string;
  usage: AiUsage | null;
  finishReason: string | null;
  modelVersion: string | null;
  attempts: number;
  /** 由第一次請求開始計，包括重試同等待 */
  latencyMs: number;
}

export class AiCallError extends Error {
  readonly kind: AiErrorKind;
  readonly status: number | null;
  attempts = 0;
  latencyMs = 0;
  // 冇內容／被擋都可能已經用咗 token，一樣要記錄
  usage: AiUsage | null = null;
  finishReason: string | null = null;

  constructor(kind: AiErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "AiCallError";
    this.kind = kind;
    this.status = status;
  }

  /** 可唔可以釋放鎖，等之後再分析 */
  get retryable(): boolean {
    return RETRY_LATER.has(this.kind);
  }
}

let aiClient: GoogleGenAI | null = null;
export function getGeminiClient(): GoogleGenAI {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new AiCallError("no_key", "GEMINI_API_KEY (或其他相容名稱) 未設定，無法初始化 Gemini client");
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey,
      // 強制用 Gemini Developer API（API key），避免喺 Cloud Run 自動切去 Vertex AI OAuth 模式
      vertexai: false,
      // 唔設定 retryOptions：SDK 冇呢個設定就唔會自己重試，重試全部由 generateWithRetry 負責，次數先數得準
      httpOptions: { headers: { "User-Agent": "pawpulse-server/1.0" } },
    });
  }
  return aiClient;
}

/** 將錯誤分類；timedOut = 係我哋自己嘅時限觸發 */
export function classifyError(err: unknown, timedOut = false): { kind: AiErrorKind; status: number | null } {
  if (err instanceof AiCallError) return { kind: err.kind, status: err.status };
  if (timedOut) return { kind: "timeout", status: null };

  const status =
    err instanceof ApiError
      ? err.status
      : typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : null;
  if (status !== null) {
    if (status === 429) return { kind: "rate_limit", status };
    if (status === 408) return { kind: "timeout", status };
    if (status >= 500) return { kind: "server", status };
    return { kind: "client", status };
  }

  const name = (err as { name?: unknown })?.name;
  if (name === "AbortError" || name === "TimeoutError") return { kind: "timeout", status: null };

  // Node fetch 連線失敗會係 TypeError("fetch failed")，真正原因喺 cause.code
  if (err instanceof TypeError) {
    const code = String((err as { cause?: { code?: unknown } }).cause?.code ?? "");
    if (/fetch failed|network|socket/i.test(err.message) || /^(E[A-Z]+|UND_ERR)/.test(code)) {
      return { kind: "network", status: null };
    }
  }
  return { kind: "unknown", status: null };
}

/** Gemini 429 有時會喺錯誤內容講幾耐之後再試（例如 "retryDelay": "12s"） */
export function retryHintMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : "";
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(msg);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/**
 * 第 n 次重試之前等幾耐：上限 1s、2s、4s…（最多 8s），
 * 喺上限嘅一半至全數之間隨機，避免多個 instance 同一時間一齊重試
 */
export function backoffMs(retryNumber: number, random: () => number = Math.random): number {
  const cap = Math.min(8_000, 1_000 * 2 ** Math.max(0, retryNumber - 1));
  return Math.round(cap / 2 + random() * (cap / 2));
}

function usageOf(r: GenerateContentResponse | undefined): AiUsage | null {
  const u = r?.usageMetadata;
  if (!u) return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    promptTokens: n(u.promptTokenCount),
    candidatesTokens: n(u.candidatesTokenCount),
    thoughtsTokens: n(u.thoughtsTokenCount),
    totalTokens: n(u.totalTokenCount),
  };
}

// Cloud Run 會將 stdout 嘅 JSON 行當結構化 log（severity 欄位決定等級）
function logJson(entry: Record<string, unknown>): void {
  const line = JSON.stringify(entry);
  if (entry.severity === "WARNING") console.warn(line);
  else console.log(line);
}

type GenerateFn = (params: GenerateContentParameters) => Promise<GenerateContentResponse>;

// 自己控制時限：時間到就 abort SDK 嘅 fetch，同時唔等 SDK 回應（就算佢唔理 abort 都唔會卡住）
async function callWithTimeout(
  call: GenerateFn,
  params: GenerateContentParameters,
  ms: number
): Promise<GenerateContentResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AiCallError("timeout", `Gemini 請求超過 ${ms}ms`));
      controller.abort();
    }, ms);
  });
  const request = call({ ...params, config: { ...params.config, abortSignal: controller.signal } });
  // 超時之後 SDK 會 reject（AbortError）；已經用咗 timeout 嘅結果，唔好變成 unhandled rejection
  request.catch(() => undefined);
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface CallMeta {
  /** log 用嘅標籤，例如 "analyze" */
  label: string;
  caseId?: string;
}

/** 測試用：可以換走真正嘅 Gemini 呼叫、等待、時鐘同隨機數 */
export interface RetryOptions {
  call?: GenerateFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  maxAttempts?: number;
  timeoutMs?: number;
  deadlineMs?: number;
}

export async function generateWithRetry(
  params: GenerateContentParameters,
  meta: CallMeta,
  opts: RetryOptions = {}
): Promise<AiCallResult> {
  const call: GenerateFn = opts.call ?? ((p) => getGeminiClient().models.generateContent(p));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const log = opts.log ?? logJson;
  const maxAttempts = opts.maxAttempts ?? MAX_HTTP_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? AI_TIMEOUT_MS;
  const deadlineMs = opts.deadlineMs ?? RUN_DEADLINE_MS;

  const start = now();
  const deadlineAt = start + deadlineMs;
  let lastError: AiCallError | null = null;
  let attempts = 0;

  const baseLog = { event: "gemini_attempt", label: meta.label, caseId: meta.caseId ?? null, model: params.model };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = deadlineAt - now();
    if (attempt > 1 && remaining < MIN_ATTEMPT_MS) break;
    attempts = attempt;
    const t0 = now();

    let response: GenerateContentResponse;
    try {
      response = await callWithTimeout(call, params, Math.max(1, Math.min(timeoutMs, remaining)));
    } catch (err) {
      const { kind, status } = classifyError(err);
      const e = err instanceof AiCallError ? err : new AiCallError(kind, (err as Error)?.message ?? String(err), status);
      lastError = e;
      log({
        ...baseLog,
        severity: "WARNING",
        message: `[Gemini] ${meta.label} attempt ${attempt} failed: ${kind}`,
        attempt,
        ok: false,
        latencyMs: now() - t0,
        httpStatus: status,
        errorKind: kind,
        error: e.message.slice(0, 300),
      });

      if (!RETRY_IN_RUN.has(kind) || attempt === maxAttempts) break;
      const wait = Math.max(backoffMs(attempt, random), retryHintMs(err) ?? 0);
      // 等完都唔夠時間再試一次，就唔好再等
      if (now() + wait + MIN_ATTEMPT_MS > deadlineAt) break;
      await sleep(wait);
      continue;
    }

    const usage = usageOf(response);
    const finishReason = response.candidates?.[0]?.finishReason ?? null;
    const text = response.text ?? "";
    const latencyMs = now() - start;
    log({
      ...baseLog,
      severity: "INFO",
      message: `[Gemini] ${meta.label} attempt ${attempt} ok ${now() - t0}ms`,
      attempt,
      ok: true,
      latencyMs: now() - t0,
      finishReason,
      ...usage,
    });

    if (!text.trim()) {
      const blockReason = response.promptFeedback?.blockReason ?? null;
      const blocked = !!blockReason || BLOCKED_FINISH_REASONS.has(String(finishReason));
      const e = new AiCallError(
        blocked ? "blocked" : "empty",
        blocked ? `Gemini 擋咗呢個請求：${blockReason ?? finishReason}` : `Gemini 回應冇內容（${finishReason ?? "冇結束原因"}）`
      );
      e.attempts = attempt;
      e.latencyMs = latencyMs;
      e.usage = usage;
      e.finishReason = finishReason;
      throw e;
    }

    return { text, usage, finishReason, modelVersion: response.modelVersion ?? null, attempts: attempt, latencyMs };
  }

  const e = lastError ?? new AiCallError("timeout", "已超過分析總時限");
  e.attempts = attempts;
  e.latencyMs = now() - start;
  throw e;
}
