// 緊急程度由程式決定（唔係 AI 決定）：AI 只負責觀察（findings），呢度按規則表計出 P0 / P1 / P2
//
// ======================= 規則表（非工程人員都可以審閱）=======================
// ⚠️ 待獸醫審核：以下每一條「觀察 → 等級」規則都係工程團隊草擬，未經獸醫確認。
//
// 等級：P0 = 有生命危險，即刻處理；P1 = 幾個鐘內要睇醫生；P2 = 穩定
// 每條規則：如果 AI 觀察到 field = value，緊急程度最少係 level，原因代碼係 code
// 原因代碼嘅中英文顯示文字喺 src/locales/zh.json 同 en.json 嘅 triage.reason.*
import type { AIEvidence, AIFindings, AIGate, AITriage, UrgencyLevel } from "../../src/types";

export const RULES_VERSION = "triage.v1";

export interface FindingRule {
  field: keyof AIFindings;
  /** woundTypes 係清單：包含呢個值就算 */
  value: string;
  level: "P0" | "P1";
  code: string;
  /** true = 要人手覆核（例如可能已經死亡） */
  review?: boolean;
}

/**
 * P0 紅旗：任何一項成立就係 P0
 * 但係一定要有相片證據（evidence 有呢個 field），否則只算 P1 並要人手覆核
 * ——防止報案描述或者相入面嘅文字令 AI 憑空報告紅旗
 */
export const RED_FLAG_RULES: FindingRule[] = [
  { field: "consciousness", value: "unresponsive", level: "P0", code: "unresponsive" },
  { field: "bleeding", value: "heavy", level: "P0", code: "heavy_bleeding" },
  { field: "breathingDistress", value: "severe", level: "P0", code: "severe_breathing_distress" },
  { field: "traumaVehicle", value: "yes", level: "P0", code: "vehicle_trauma" },
  { field: "mobility", value: "unable_to_stand", level: "P0", code: "unable_to_stand" },
];

/** P1：要盡快睇醫生（唔使相片證據，因為只會令案件更緊急） */
export const AMBER_RULES: FindingRule[] = [
  { field: "consciousness", value: "dull", level: "P1", code: "dull_consciousness" },
  { field: "consciousness", value: "appears_dead", level: "P1", code: "possibly_deceased", review: true },
  { field: "bleeding", value: "minor", level: "P1", code: "minor_bleeding" },
  { field: "breathingDistress", value: "mild", level: "P1", code: "mild_breathing_distress" },
  { field: "mobility", value: "limping", level: "P1", code: "limping" },
  { field: "traumaFall", value: "yes", level: "P1", code: "fall_trauma" },
  { field: "traumaBite", value: "yes", level: "P1", code: "bite_wound" },
  { field: "traumaEntrapment", value: "yes", level: "P1", code: "entrapment" },
  { field: "wounds", value: "present", level: "P1", code: "visible_wound" },
  { field: "woundTypes", value: "open_wound", level: "P1", code: "open_wound" },
  { field: "woundTypes", value: "fracture_deformity", level: "P1", code: "fracture_deformity" },
  { field: "woundTypes", value: "burn", level: "P1", code: "burn" },
  { field: "woundTypes", value: "eye_injury", level: "P1", code: "eye_injury" },
  { field: "woundTypes", value: "skin_disease", level: "P1", code: "skin_disease" },
  { field: "woundTypes", value: "maggots", level: "P1", code: "maggots" },
  { field: "woundTypes", value: "other", level: "P1", code: "other_injury" },
  { field: "bodyCondition", value: "emaciated", level: "P1", code: "emaciated" },
  { field: "ageClass", value: "neonate", level: "P1", code: "neonate" },
];

/** 關鍵觀察：睇唔清（unknown）就最少係 P1，唔可以當冇事 */
export const CRITICAL_FIELDS: (keyof AIFindings)[] = ["consciousness", "bleeding", "breathingDistress", "mobility"];

/** 報案人揀嘅標籤：最多只可以令案件升到 P1，唔可以升到 P0，亦唔可以降低 */
export const TAG_RULES: Record<string, string> = {
  injured: "reporter_tag_injured",
  trapped: "reporter_tag_trapped",
  juvenile: "reporter_tag_juvenile",
};

// 其他原因代碼
export const GATE_CODES = { noAnimal: "no_animal_visible", unusable: "image_unusable" } as const;
export const OTHER_CODES = {
  redFlagUnconfirmed: "red_flag_unconfirmed", // 紅旗冇相片證據
  modelRaised: "model_raised",                 // AI 建議 P1，規則計到 P2
  modelP0Unconfirmed: "model_p0_unconfirmed",  // AI 建議 P0，但冇紅旗觀察支持
  runsDisagree: "runs_disagree",               // 兩次分析結果唔同（AI_OBSERVE_TWICE）
  stable: "no_urgent_findings",                // 冇任何需要緊急處理嘅觀察
} as const;
// ===========================================================================

const RANK: Record<UrgencyLevel, number> = { P2: 0, P1: 1, P0: 2 };
export const maxLevel = (a: UrgencyLevel, b: UrgencyLevel): UrgencyLevel => (RANK[a] >= RANK[b] ? a : b);

export interface Observation {
  gate: AIGate;
  findings: AIFindings;
  evidence: AIEvidence[];
}

export interface TriageResult extends AITriage {
  level: UrgencyLevel;
}

function matches(f: AIFindings, rule: FindingRule): boolean {
  const v = f[rule.field];
  return Array.isArray(v) ? (v as string[]).includes(rule.value) : v === rule.value;
}

/** 每條規則對應嘅所有原因代碼（測試同 i18n 檢查用） */
export function allReasonCodes(): string[] {
  return [
    ...RED_FLAG_RULES.map((r) => r.code),
    ...AMBER_RULES.map((r) => r.code),
    ...CRITICAL_FIELDS.map((f) => `${f}_unknown`),
    ...Object.values(TAG_RULES),
    ...Object.values(GATE_CODES),
    ...Object.values(OTHER_CODES),
  ];
}

/**
 * obs：AI 嘅觀察（已經過 Zod 驗證）
 * modelSuggestion：AI 自己建議嘅等級，只可以提高（最多到 P1；P0 一定要有紅旗觀察）
 * reporterTags：報案人揀嘅標籤，最多升到 P1
 * 報案描述唔係輸入：描述只會令 AI 嘅觀察有偏差，所以 P0 一定要有相片證據
 */
export function triage(
  obs: Observation,
  modelSuggestion: UrgencyLevel | null,
  reporterTags: readonly string[] = []
): TriageResult {
  const codes: string[] = [];
  // 用 object 保存：raise() 喺 closure 入面改，TypeScript 先唔會當佢永遠係 P2
  const st: { level: UrgencyLevel; review: boolean } = { level: "P2", review: false };
  const raise = (to: UrgencyLevel, code: string) => {
    st.level = maxLevel(st.level, to);
    if (!codes.includes(code)) codes.push(code);
  };
  const result = (): TriageResult => ({
    level: st.level,
    reasonCodes: codes,
    needsHumanReview: st.review,
    rulesVersion: RULES_VERSION,
    modelSuggestion,
  });

  // 1. Gate：見唔到動物或者張相用唔到，觀察唔可信，一律 P1 + 人手覆核
  if (!obs.gate.animalVisible || !obs.gate.imageUsable) {
    if (!obs.gate.animalVisible) raise("P1", GATE_CODES.noAnimal);
    if (!obs.gate.imageUsable) raise("P1", GATE_CODES.unusable);
    st.review = true;
    return result();
  }

  const f = obs.findings;
  const hasEvidence = (field: keyof AIFindings) => obs.evidence.some((e) => e.finding === field);

  // 2. 紅旗 → P0（要有相片證據）
  for (const rule of RED_FLAG_RULES) {
    if (!matches(f, rule)) continue;
    if (hasEvidence(rule.field)) {
      raise("P0", rule.code);
    } else {
      raise("P1", OTHER_CODES.redFlagUnconfirmed);
      st.review = true;
    }
  }

  // 3. P1 觀察
  for (const rule of AMBER_RULES) {
    if (!matches(f, rule)) continue;
    raise(rule.level, rule.code);
    if (rule.review) st.review = true;
  }

  // 4. 關鍵觀察睇唔清 → 最少 P1
  for (const field of CRITICAL_FIELDS) {
    if (f[field] === "unknown") raise("P1", `${field}_unknown`);
  }

  // 5. AI 自己嘅建議：只可以提高，而且單靠建議最多去到 P1
  if (modelSuggestion === "P0" && st.level !== "P0") {
    raise("P1", OTHER_CODES.modelP0Unconfirmed);
    st.review = true;
  } else if (modelSuggestion === "P1" && st.level === "P2") {
    raise("P1", OTHER_CODES.modelRaised);
  }

  // 6. 報案人標籤：只可以由 P2 升到 P1
  if (st.level === "P2") {
    for (const tag of reporterTags) {
      const code = TAG_RULES[tag];
      if (code) raise("P1", code);
    }
  }

  if (codes.length === 0) codes.push(OTHER_CODES.stable);
  // P0 原因排最前
  const p0 = new Set(RED_FLAG_RULES.map((r) => r.code));
  codes.sort((a, b) => Number(p0.has(b)) - Number(p0.has(a)));
  return result();
}

/**
 * 兩次獨立分析（AI_OBSERVE_TWICE）：用較高嘅等級；唔一致就要人手覆核
 * 回傳 primary = 等級較高嗰次（儲存佢嘅觀察）
 */
export function mergeTriage(a: TriageResult, b: TriageResult): { merged: TriageResult; primary: 0 | 1 } {
  const primary: 0 | 1 = RANK[b.level] > RANK[a.level] ? 1 : 0;
  const hi = primary === 0 ? a : b;
  const disagree = a.level !== b.level;
  const codes = [...hi.reasonCodes];
  if (disagree) codes.push(OTHER_CODES.runsDisagree);
  return {
    primary,
    merged: {
      ...hi,
      reasonCodes: codes,
      needsHumanReview: a.needsHumanReview || b.needsHumanReview || disagree,
    },
  };
}
