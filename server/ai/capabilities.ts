// 由 AI 觀察推算案件需要邊啲 NGO 能力，同埋 AI 判斷嘅物種同報案人揀嘅係咪一樣
// 結果存喺 aiAnalysis.matching（第 5 版）；舊案件（第 3、4 版有 findings）配對時即場用同一個函數計
//
// ======================= 能力規則表（非工程人員都可以審閱）=======================
// ⚠️ 待救援團隊審核：邊個情況需要邊種能力，係工程團隊草擬
import type { NgoCapability } from "../../src/config/ngoCapabilities";
import type { AIAnalysisResult, AIFindings, AIMatching, AnimalType, UrgencyLevel } from "../../src/types";

export const MATCHING_RULES_VERSION = "matching.v1";

export interface CapabilityRule {
  /** 案件等級（triage 結果） */
  level?: UrgencyLevel;
  /** AI 觀察 field = value（woundTypes 係清單：包含就算）；只喺相片可信（Gate 通過）時用 */
  field?: keyof AIFindings;
  value?: string;
  capability: NgoCapability;
}

export const CAPABILITY_RULES: CapabilityRule[] = [
  { level: "P0", capability: "emergency_vet" },
  { level: "P0", capability: "transport" },
  { field: "mobility", value: "unable_to_stand", capability: "transport" },
  { field: "traumaVehicle", value: "yes", capability: "surgery" },
  { field: "woundTypes", value: "fracture_deformity", capability: "surgery" },
  { field: "ageClass", value: "neonate", capability: "neonate_care" },
  { field: "traumaEntrapment", value: "yes", capability: "trapping" },
  { field: "woundTypes", value: "skin_disease", capability: "skin_parasite" },
  { field: "woundTypes", value: "maggots", capability: "skin_parasite" },
  // 穩定嘅流浪動物：主要需要收容
  { level: "P2", capability: "shelter" },
];
// ===========================================================================

const ANIMALS: AnimalType[] = ["cat", "dog", "bird", "other"];

/**
 * 物種唔一致時點配對：報案人揀嘅同 AI 判斷嘅兩個都考慮（接收其中一種就算接收）
 * 理由：兩邊都可能錯——報案人可能揀錯，AI 亦可能認錯；唔可以因為其中一邊錯咗而排走啱嘅機構
 * AI 答 unknown、或者相片唔可信（Gate 唔通過）就只用報案人揀嘅
 */
export function deriveMatching(
  analysis: AIAnalysisResult | null | undefined,
  reportedAnimal: unknown,
  level: UrgencyLevel
): AIMatching {
  const reported: AnimalType = ANIMALS.includes(reportedAnimal as AnimalType) ? (reportedAnimal as AnimalType) : "other";
  const gate = analysis?.gate;
  const gateOk = !!gate && gate.animalVisible === true && gate.imageUsable === true;
  const aiSpecies = gateOk && ANIMALS.includes(gate!.speciesCategory as AnimalType) ? (gate!.speciesCategory as AnimalType) : null;
  const speciesMismatch = aiSpecies !== null && aiSpecies !== reported;

  const findings = gateOk && analysis?.findings && typeof analysis.findings === "object" ? analysis.findings : null;
  const required = new Set<NgoCapability>();
  for (const rule of CAPABILITY_RULES) {
    if (rule.level) {
      if (rule.level === level) required.add(rule.capability);
      continue;
    }
    if (!findings || !rule.field) continue;
    const v = findings[rule.field];
    if (Array.isArray(v) ? (v as string[]).includes(rule.value!) : v === rule.value) required.add(rule.capability);
  }

  return {
    requiredCapabilities: Array.from(required),
    speciesMismatch,
    species: speciesMismatch ? [reported, aiSpecies!] : [reported],
    rulesVersion: MATCHING_RULES_VERSION,
  };
}
