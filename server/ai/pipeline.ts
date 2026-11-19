// AI 分析流程：讀案件 → 讀相 → 攞鎖 → 扣每日額度 → 問 Gemini（觀察）→ Zod 驗證 → triage（程式決定等級）→ 寫結果 → 寫 private/aiRun
// 任何失敗都唔會阻止報案：案件維持 P1，相片維持模糊（fail-closed）
// /api/cases/:caseId/analyze（建立）同 /api/cases/:caseId/edit（修改）都經呢度
import { FieldValue } from "firebase-admin/firestore";
import type { AIAnalysisResult, AiStatus, UrgencyLevel } from "../../src/types";
import { casePhotoPaths, loadCasePhotos, type LoadedPhoto } from "../cases";
import { getAdminBucket, getAdminDb } from "../firebaseAdmin";
import { AiCallError, generateWithRetry, type AiCallResult, type AiUsage, type RetryOptions } from "./client";
import {
  AI_DAILY_LIMIT,
  AI_OBSERVE_TWICE,
  GEMINI_MODEL,
  MAX_RUNS_PER_CASE,
  SCHEMA_VERSION,
  getGeminiApiKey,
} from "./config";
import { ANALYZE_RESPONSE_JSON_SCHEMA, PROMPT_VERSION, buildAnalyzePrompt, type RawAnalysis } from "./prompts/analyze.v3";
import { consumeDailyAiQuota } from "./quota";
import { capRawText, writeRunRecord, type AiRunRecord, type ConsensusInfo } from "./runRecord";
import {
  caseFacts,
  checkCaseEligible,
  claimRun,
  finishRun,
  type AnalyzeTrigger,
  type ClaimRefusal,
} from "./runLock";
import { deriveMatching } from "./capabilities";
import { enqueueAnalyzeTask } from "./tasks";
import { mergeTriage, triage, type TriageResult } from "./triage";
import { SchemaError, buildAnalysis, parseRaw, toObservation } from "./validate";

export type { AnalyzeTrigger } from "./runLock";

// ---------- 純分析：唔讀寫 Firestore（評估腳本都會用） ----------

export interface RunAnalysisInput {
  images: LoadedPhoto[];
  /** 案件總共有幾多張相（包括讀唔到嘅） */
  totalPhotos: number;
  animalType: unknown;
  description: unknown;
  /** 報案人揀嘅標籤（唔信任；triage 最多升到 P1） */
  reporterTags: readonly string[];
  lang: string;
  caseId?: string;
}

export interface RunAnalysisOptions {
  retry?: RetryOptions;
  /** 分析兩次，比較結果（預設跟 AI_OBSERVE_TWICE） */
  observeTwice?: boolean;
}

export type RunAnalysisResult =
  | {
      ok: true;
      analysis: AIAnalysisResult;
      triage: TriageResult;
      /** 用嚟儲存觀察嗰次 */
      call: AiCallResult;
      /** 全部成功嘅 call（計 token 用） */
      calls: AiCallResult[];
      consensus: ConsensusInfo | null;
    }
  | { ok: false; error: AiCallError | SchemaError; call: AiCallResult | null };

type Observed = { ok: true; raw: RawAnalysis; call: AiCallResult } | { ok: false; error: AiCallError | SchemaError; call: AiCallResult | null };

async function observeOnce(input: RunAnalysisInput, prompt: string, retry?: RetryOptions): Promise<Observed> {
  let call: AiCallResult;
  try {
    call = await generateWithRetry(
      {
        model: GEMINI_MODEL,
        contents: {
          // 全部相放喺同一個 request，最後先放文字指示
          parts: [
            ...input.images.map((img) => ({ inlineData: { mimeType: "image/jpeg", data: img.data } })),
            { text: prompt },
          ],
        },
        config: { responseMimeType: "application/json", responseJsonSchema: ANALYZE_RESPONSE_JSON_SCHEMA },
      },
      { label: "analyze", caseId: input.caseId },
      retry
    );
  } catch (err) {
    const e = err instanceof AiCallError ? err : new AiCallError("unknown", (err as Error)?.message ?? String(err));
    return { ok: false, error: e, call: null };
  }
  try {
    return { ok: true, raw: parseRaw(call.text), call };
  } catch (err) {
    const e = err instanceof SchemaError ? err : new SchemaError((err as Error)?.message ?? String(err));
    return { ok: false, error: e, call };
  }
}

export async function runAnalysis(input: RunAnalysisInput, opts: RunAnalysisOptions = {}): Promise<RunAnalysisResult> {
  const prompt = buildAnalyzePrompt({
    photoCount: input.images.length,
    animalType: input.animalType,
    description: input.description,
    lang: input.lang,
  });
  const twice = opts.observeTwice ?? AI_OBSERVE_TWICE;

  // 兩次分析同時進行（延遲同一次差唔多）
  const runs = await Promise.all(Array.from({ length: twice ? 2 : 1 }, () => observeOnce(input, prompt, opts.retry)));
  const good = runs.filter((r): r is Extract<Observed, { ok: true }> => r.ok === true);
  if (good.length === 0) {
    const first = runs[0] as Extract<Observed, { ok: false }>;
    return { ok: false, error: first.error, call: first.call };
  }

  const triaged = good.map((g) => {
    const { obs, evidence } = toObservation(g.raw, input.images);
    return { ...g, obs, evidence, t: triage(obs, g.raw.suggestedUrgency, input.reporterTags) };
  });

  let pick = triaged[0];
  let t = pick.t;
  let raw = pick.raw;
  let consensus: ConsensusInfo | null = twice ? { runs: runs.length, succeeded: good.length, levels: [pick.t.level], agreed: null } : null;
  if (triaged.length === 2) {
    const { merged, primary } = mergeTriage(triaged[0].t, triaged[1].t);
    pick = triaged[primary];
    t = merged;
    // 敏感相片：任何一次標記咗都模糊（fail-closed）
    raw = {
      ...pick.raw,
      sensitivePhotoNumbers: Array.from(new Set([...triaged[0].raw.sensitivePhotoNumbers, ...triaged[1].raw.sensitivePhotoNumbers])),
    };
    consensus = {
      runs: 2,
      succeeded: 2,
      levels: triaged.map((x) => x.t.level),
      agreed: triaged[0].t.level === triaged[1].t.level,
    };
  }

  const analysis = buildAnalysis(raw, pick.obs, pick.evidence, t, input.images, input.totalPhotos);
  // 配對需要（第 5 版）：需要嘅 NGO 能力、AI 物種同報案人揀嘅係咪一樣
  analysis.matching = deriveMatching(analysis, input.animalType, t.level);
  return { ok: true, analysis, triage: t, call: pick.call, calls: good.map((g) => g.call), consensus };
}

/** 多次 call：attempts 同 token 加埋，延遲用最長嗰次（同時進行） */
function combineCalls(calls: AiCallResult[]): { attempts: number; latencyMs: number; usage: AiUsage | null } {
  if (calls.length <= 1) return { attempts: calls[0]?.attempts ?? 0, latencyMs: calls[0]?.latencyMs ?? 0, usage: calls[0]?.usage ?? null };
  const sum = (k: keyof AiUsage) => {
    const vals = calls.map((c) => c.usage?.[k]).filter((v): v is number => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  return {
    attempts: calls.reduce((a, c) => a + c.attempts, 0),
    latencyMs: Math.max(...calls.map((c) => c.latencyMs)),
    usage: {
      promptTokens: sum("promptTokens"),
      candidatesTokens: sum("candidatesTokens"),
      thoughtsTokens: sum("thoughtsTokens"),
      totalTokens: sum("totalTokens"),
    },
  };
}

// ---------- 案件分析：讀寫 Firestore ----------

export type SkipReason =
  | ClaimRefusal
  | "not_found"
  | "storage_not_configured"
  | "no_api_key"
  | "no_photos"
  | "daily_quota"
  | "superseded";

export type AnalyzeOutcome =
  | { status: "done"; analysis: AIAnalysisResult; urgency: UrgencyLevel }
  | { status: "skipped"; reason: SkipReason }
  | { status: "failed"; retryable: boolean; errorKind: string };

const skipped = (reason: SkipReason): AnalyzeOutcome => ({ status: "skipped", reason });

// 由 Gemini 回應或者錯誤抽出 aiRun 要記錄嘅欄位
function callFields(call: AiCallResult | null, err: AiCallError | SchemaError | null) {
  const aiErr = err instanceof AiCallError ? err : null;
  return {
    attempts: call?.attempts ?? aiErr?.attempts ?? 0,
    latencyMs: call?.latencyMs ?? aiErr?.latencyMs ?? 0,
    usage: call?.usage ?? aiErr?.usage ?? null,
    finishReason: call?.finishReason ?? aiErr?.finishReason ?? null,
    modelVersion: call?.modelVersion ?? null,
    ...capRawText(call?.text ?? null),
    error: err ? { kind: err.kind, status: aiErr?.status ?? null, message: err.message.slice(0, 500) } : null,
  };
}

// 寫 aiRun 失敗唔影響分析結果，只記 log
async function saveRunRecord(caseId: string, record: AiRunRecord): Promise<void> {
  try {
    await writeRunRecord(caseId, record);
  } catch (err) {
    console.warn(`[Analyze] 寫入 private/aiRun 失敗 ${caseId}:`, (err as Error)?.message);
  }
}

// ---------- aiStatus（Phase 4）：前端用 onSnapshot 睇住呢個欄位 ----------
// queued → running → done / failed / skipped；只有 server 寫（rules 唔准前端寫非 null 值）

const ACTIVE_STATUSES = new Set<AiStatus>(["queued", "running"]);

/**
 * 純函數：分析結果 → 案件應該變成乜嘢 aiStatus；null = 唔使改（由另一個流程負責，例如重複嘅 task）
 * willRetry = 失敗之後會唔會有人再試（Cloud Tasks 會；request 入面直接分析唔會）
 */
export function aiStatusAfter(outcome: AnalyzeOutcome, willRetry: boolean): AiStatus | null {
  if (outcome.status === "done") return "done";
  if (outcome.status === "failed") return outcome.retryable && willRetry ? "queued" : "failed";
  switch (outcome.reason) {
    case "no_api_key":
    case "daily_quota":
    case "no_photos":
    case "storage_not_configured":
      return "skipped";
    case "outside_window":
    case "max_runs":
      return "failed";
    default:
      return null;
  }
}

/**
 * 改 aiStatus：只會改由 server 負責緊（queued / running）嘅案件，而且案件冇被修改、未有結果
 * ——唔會因為有人亂 call API 而喺舊案件寫狀態，亦唔會蓋過較新嘅修改
 */
async function updateAiStatus(caseId: string, status: AiStatus, expectedEditCount: number): Promise<void> {
  const db = getAdminDb();
  const ref = db.collection("case").doc(caseId);
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (!cur.exists) return;
    const d = cur.data();
    const f = caseFacts(d);
    if (f.hasAnalysis || f.editCount !== expectedEditCount || !ACTIVE_STATUSES.has(d?.aiStatus)) return;
    tx.update(ref, { aiStatus: status, updatedAt: FieldValue.serverTimestamp() });
  });
}

export interface AnalyzeCaseOptions {
  lang: string;
  /** 失敗之後會唔會有人再試（Cloud Tasks handler = true） */
  willRetry?: boolean;
  /**
   * 呢次分析之前已經有人將 aiStatus 設為 queued（排隊、修改案件）
   * true 先會喺「冇 Storage／API key」呢類即刻跳過嘅情況都更新狀態；否則唔使讀 Firestore，即刻回應
   */
  statusOwned?: boolean;
}

export async function analyzeCase(caseId: string, trigger: AnalyzeTrigger, opts: AnalyzeCaseOptions): Promise<AnalyzeOutcome> {
  // 冇 Storage／API key：唔使讀案件同問 Gemini（本機冇設定時都即刻回應）
  const preflight: SkipReason | null = !getAdminBucket()
    ? "storage_not_configured"
    : !getGeminiApiKey()
      ? "no_api_key"
      : null;
  if (preflight) {
    if (preflight === "no_api_key") console.error("[Gemini] No API key available — skipping Gemini call");
    if (opts.statusOwned) {
      await getAdminDb()
        .collection("case")
        .doc(caseId)
        .get()
        .then((snap) => (snap.exists ? updateAiStatus(caseId, "skipped", caseFacts(snap.data()).editCount) : undefined))
        .catch((err) => console.warn(`[Analyze] 更新 aiStatus 失敗 ${caseId}:`, (err as Error)?.message));
    }
    return skipped(preflight);
  }

  const caseRef = getAdminDb().collection("case").doc(caseId);
  const snap = await caseRef.get();
  if (!snap.exists) return skipped("not_found");
  const editCount = caseFacts(snap.data()).editCount;

  const outcome = await analyzeLoadedCase(caseId, trigger, opts.lang, snap.data());
  const status = aiStatusAfter(outcome, opts.willRetry === true);
  // done 已經同結果喺同一個 transaction 寫咗
  if (status && status !== "done") {
    await updateAiStatus(caseId, status, editCount).catch((err) =>
      console.warn(`[Analyze] 更新 aiStatus 失敗 ${caseId}:`, (err as Error)?.message)
    );
  }
  return outcome;
}

async function analyzeLoadedCase(
  caseId: string,
  trigger: AnalyzeTrigger,
  lang: string,
  data: Record<string, any> | undefined
): Promise<AnalyzeOutcome> {
  // analyzeCase 已經檢查過 Storage 同 API key
  const bucket = getAdminBucket()!;
  const db = getAdminDb();
  const caseRef = db.collection("case").doc(caseId);

  // 先睇案件同讀相（唔使 transaction）：唔合資格或者冇相就唔攞鎖，唔會用咗分析次數
  const facts = caseFacts(data);
  const refusal = checkCaseEligible(facts, trigger, Date.now());
  if (refusal) return skipped(refusal);

  // 由 Storage 讀相，唔接受前端傳圖
  const paths = casePhotoPaths(caseId, data);
  const images = await loadCasePhotos(bucket, paths);
  if (images.length === 0) return skipped("no_photos");

  // 攞鎖嘅同一個 transaction 會將 aiStatus 改做 running
  const claim = await claimRun(caseId, trigger, facts.editCount);
  // tsconfig 冇開 strictNullChecks，要用 === false 先收窄到 union 嘅其中一款
  if (claim.ok === false) return skipped(claim.reason);
  const { runNumber, firstRun, editCount } = claim.run;

  const base = {
    trigger,
    runNumber,
    model: GEMINI_MODEL,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
    photosSent: images.length,
  };

  let finished = false;
  const finish = async (state: "released" | "done", errorKind: string | null) => {
    finished = true;
    await finishRun(caseId, trigger, runNumber, state, errorKind);
  };

  try {
    // 每日額度按案件計：只係第一次分析先扣；超出就唔再試，案件維持 P1
    if (firstRun && !(await consumeDailyAiQuota())) {
      console.warn(`[Gemini] 已達每日上限 ${AI_DAILY_LIMIT}，案件 ${caseId} 跳過 AI 分析`);
      await finish("done", "daily_quota");
      await saveRunRecord(caseId, {
        ...base,
        outcome: "skipped",
        skipReason: "daily_quota",
        urgency: null,
        triage: null,
        consensus: null,
        ...callFields(null, null),
      });
      return skipped("daily_quota");
    }

    const result = await runAnalysis({
      images,
      totalPhotos: paths.length,
      animalType: data?.animalType,
      description: data?.description,
      reporterTags: Array.isArray(data?.tags) ? data!.tags.filter((x: unknown): x is string => typeof x === "string") : [],
      lang,
      caseId,
    });

    if (result.ok === false) {
      // 暫時性錯誤而且未用晒次數：釋放鎖，等之後可以再試
      const retryable = result.error.retryable && runNumber < MAX_RUNS_PER_CASE;
      console.warn(
        `[Analyze] case ${caseId} (${trigger}) run ${runNumber} failed: ${result.error.kind}` +
          (retryable ? "，可以再試" : "")
      );
      await finish(retryable ? "released" : "done", result.error.kind);
      await saveRunRecord(caseId, {
        ...base,
        outcome: "failed",
        skipReason: null,
        urgency: null,
        triage: null,
        consensus: null,
        ...callFields(result.call, result.error),
      });
      return { status: "failed", retryable, errorKind: result.error.kind };
    }

    // 寫入之前再確認：分析期間案件冇被修改，亦未有其他分析結果
    const analysis = result.analysis;
    const written = await db.runTransaction(async (tx) => {
      const cur = await tx.get(caseRef);
      if (!cur.exists) return false;
      const f = caseFacts(cur.data());
      if (f.hasAnalysis || f.editCount !== editCount) return false;
      // 唔再寫 geminiResponse（以前同 aiAnalysis 重複）
      tx.update(caseRef, {
        aiAnalysis: analysis,
        urgency: analysis.urgencyLevel,
        aiStatus: "done",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });

    await finish("done", written ? null : "superseded");
    await saveRunRecord(caseId, {
      ...base,
      outcome: written ? "done" : "superseded",
      skipReason: null,
      urgency: written ? analysis.urgencyLevel : null,
      triage: {
        level: result.triage.level,
        reasonCodes: result.triage.reasonCodes,
        needsHumanReview: result.triage.needsHumanReview,
        rulesVersion: result.triage.rulesVersion,
        modelSuggestion: result.triage.modelSuggestion,
      },
      consensus: result.consensus,
      ...callFields(result.call, null),
      // 兩次分析：attempts、token 加埋；延遲用最長嗰次
      ...combineCalls(result.calls),
    });
    if (!written) return skipped("superseded");
    return { status: "done", analysis, urgency: analysis.urgencyLevel };
  } finally {
    // 中途出 exception（例如 Firestore 寫入失敗）：釋放鎖，等之後可以再試
    if (!finished) {
      await finishRun(caseId, trigger, runNumber, "released", "exception").catch((err) =>
        console.warn(`[Analyze] 釋放鎖失敗 ${caseId}:`, (err as Error)?.message)
      );
    }
  }
}

// ---------- 排隊（Cloud Tasks）----------

export type QueueOutcome =
  | { status: "queued"; duplicate: boolean }
  | { status: "skipped"; reason: SkipReason }
  /** 排唔到隊（Cloud Tasks API 出錯）：由 route 改為喺 request 入面直接分析 */
  | { status: "enqueue_failed" };

/**
 * 檢查案件可以分析之後，將 aiStatus 設為 queued 並排一個 Cloud Task
 * 已經 queued / running 都照排（task 名防重複），咁上次排隊失敗都可以補返
 */
export async function queueAnalysis(caseId: string, trigger: AnalyzeTrigger, lang: string): Promise<QueueOutcome> {
  const db = getAdminDb();
  const caseRef = db.collection("case").doc(caseId);
  const snap = await caseRef.get();
  if (!snap.exists) return { status: "skipped", reason: "not_found" };
  const data = snap.data();
  const facts = caseFacts(data);
  const refusal = checkCaseEligible(facts, trigger, Date.now());
  if (refusal) return { status: "skipped", reason: refusal };
  // 只係睇有冇相嘅路徑；真正讀相喺 task 入面做
  if (casePhotoPaths(caseId, data).length === 0) return { status: "skipped", reason: "no_photos" };

  const marked = await db.runTransaction(async (tx) => {
    const cur = await tx.get(caseRef);
    const f = caseFacts(cur.data());
    if (!cur.exists || f.hasAnalysis || f.editCount !== facts.editCount) return false;
    if (!ACTIVE_STATUSES.has(cur.data()?.aiStatus)) {
      tx.update(caseRef, { aiStatus: "queued", updatedAt: FieldValue.serverTimestamp() });
    }
    return true;
  });
  if (!marked) return { status: "skipped", reason: "changed" };

  try {
    const r = await enqueueAnalyzeTask({ caseId, trigger, lang }, facts.editCount);
    console.log(`[Analyze] case ${caseId} (${trigger}) ${r === "duplicate" ? "已經排咗隊" : "已排隊"}`);
    return { status: "queued", duplicate: r === "duplicate" };
  } catch (err) {
    console.error(`[Analyze] Cloud Tasks 排隊失敗 ${caseId}:`, (err as Error)?.message);
    return { status: "enqueue_failed" };
  }
}
