// 唔直接信 AI 輸出：用 Zod（analyze.v3 嘅 RawAnalysisSchema）逐個欄位驗證，先至寫入資料庫
import type { AIAnalysisResult, AIEvidence, AIUncertainty } from "../../src/types";
import type { LoadedPhoto } from "../cases";
import { cleanStr } from "../sanitize";
import { cleanAiNote, selectAdvice } from "./advice";
import { SCHEMA_VERSION } from "./config";
import { SCALAR_FINDING_FIELDS } from "./findings";
import { RawAnalysisSchema, type RawAnalysis } from "./prompts/analyze.v3";
import type { Observation, TriageResult } from "./triage";

const MAX_EVIDENCE = 30;

/** AI 回應唔符合格式（JSON 錯、enum 值唔啱、欠欄位等）；案件維持 P1，可以留待之後再分析 */
export class SchemaError extends Error {
  readonly kind = "schema" as const;
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

/** JSON + Zod 驗證；任何唔啱都成個結果唔用（唔會自己估一個值） */
export function parseRaw(rawText: string): RawAnalysis {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new SchemaError("AI 回應唔係有效 JSON");
  }
  const r = RawAnalysisSchema.safeParse(json);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new SchemaError(`AI 回應唔符合 schema：${first?.path.join(".") || "(root)"} ${first?.message ?? ""}`.trim());
  }
  return r.data;
}

/**
 * 整理觀察結果；證據嘅相片編號（AI 用 1..n）轉返案件 photos[] 位置
 * 編號超出實際送出嘅相就刪走（咁紅旗就冇證據，triage 唔會當 P0）
 */
export function toObservation(raw: RawAnalysis, images: LoadedPhoto[]): { obs: Observation; evidence: AIEvidence[] } {
  const seen = new Set<string>();
  const evidence: AIEvidence[] = [];
  for (const e of raw.evidence) {
    if (e.photo < 1 || e.photo > images.length) continue;
    const pos = images[e.photo - 1].pos;
    const key = `${e.finding}:${pos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({ finding: e.finding, photo: pos });
    if (evidence.length >= MAX_EVIDENCE) break;
  }
  const obs: Observation = {
    gate: { animalVisible: raw.animalVisible, imageUsable: raw.imageUsable, speciesCategory: raw.speciesCategory },
    findings: {
      ageClass: raw.ageClass,
      consciousness: raw.consciousness,
      mobility: raw.mobility,
      bleeding: raw.bleeding,
      breathingDistress: raw.breathingDistress,
      traumaVehicle: raw.traumaVehicle,
      traumaFall: raw.traumaFall,
      traumaBite: raw.traumaBite,
      traumaEntrapment: raw.traumaEntrapment,
      wounds: raw.wounds,
      woundTypes: Array.from(new Set(raw.woundTypes)),
      bodyCondition: raw.bodyCondition,
    },
    evidence,
  };
  return { obs, evidence };
}

/** 取代舊嘅信心分數：有幾多項觀察睇唔清、張相用唔用得 */
export function uncertaintyOf(obs: Observation): AIUncertainty {
  return {
    unknownFindings: SCALAR_FINDING_FIELDS.filter((f) => obs.findings[f] === "unknown").length,
    totalFindings: SCALAR_FINDING_FIELDS.length,
    animalVisible: obs.gate.animalVisible,
    imageUsable: obs.gate.imageUsable,
  };
}

/**
 * 敏感相片：AI 用 1..n 計，轉返案件 photos[] 位置（0 = 封面）
 * 讀唔到嘅相 AI 冇睇過，一律當敏感（fail-closed）
 */
export function sensitivePositions(numbers: number[], images: LoadedPhoto[], totalPhotos: number): number[] {
  const sensitive = new Set<number>();
  for (const k of numbers) {
    if (Number.isInteger(k) && k >= 1 && k <= images.length) sensitive.add(images[k - 1].pos);
  }
  const seen = new Set(images.map((img) => img.pos));
  for (let i = 0; i < totalPhotos; i++) if (!seen.has(i)) sensitive.add(i);
  return Array.from(sensitive).sort((a, b) => a - b);
}

/**
 * 組合儲存喺 case.aiAnalysis 嘅結果（schemaVersion 4）
 * 緊急程度用 triage 結果，唔用 AI 建議；建議用建議庫代碼，唔用 AI 文字
 */
export function buildAnalysis(
  raw: RawAnalysis,
  obs: Observation,
  evidence: AIEvidence[],
  t: TriageResult,
  images: LoadedPhoto[],
  totalPhotos: number,
  analyzedAt: Date = new Date()
): AIAnalysisResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    urgencyLevel: t.level,
    gate: obs.gate,
    findings: obs.findings,
    evidence,
    triage: {
      reasonCodes: t.reasonCodes,
      needsHumanReview: t.needsHumanReview,
      rulesVersion: t.rulesVersion,
      modelSuggestion: t.modelSuggestion,
    },
    uncertainty: uncertaintyOf(obs),
    // 建議：程式按觀察同等級由建議庫揀代碼
    advice: selectAdvice(obs, t.level),
    // 以下係 AI 寫嘅文字（唔信任，清洗截短；前端要標明係 AI 生成）
    aiNote: cleanAiNote(raw.situationNote),
    estimatedBreed: cleanStr(raw.estimatedBreed, 100),
    appearanceDescription: cleanStr(raw.appearanceDescription, 500),
    sensitivePhotos: sensitivePositions(raw.sensitivePhotoNumbers, images, totalPhotos),
    analyzedAt: analyzedAt.toISOString(),
  };
}
