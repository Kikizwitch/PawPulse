// 按 AI 觀察揀建議：程式由建議庫（src/config/adviceLibrary.ts）揀代碼，唔再用 AI 寫嘅建議文字
// 案件只儲存代碼，前端按目前語言顯示，轉語言會即時更新
//
// ======================= 揀建議規則表（非工程人員都可以審閱）=======================
// ⚠️ 待獸醫審核：邊個情況揀邊幾條建議，都係工程團隊草擬
// 次序 = 優先次序：清單有上限，排後面嘅一般建議會最先被略去
import { ADVICE_CATEGORIES, ADVICE_LIBRARY_VERSION, type AdviceCategory } from "../../src/config/adviceLibrary";
import type { AIAdvice, AIFindings, UrgencyLevel } from "../../src/types";
import type { Observation } from "./triage";

export interface AdviceRule {
  /** 幾時用：always = 一定用；其他條件全部要成立 */
  always?: true;
  level?: UrgencyLevel;
  /** Gate 唔通過（見唔到動物或者相片用唔到） */
  gateFailed?: true;
  species?: string;
  /** AI 觀察：field = value（woundTypes 係清單：包含 value 就算）；只喺 Gate 通過時先用 */
  field?: keyof AIFindings;
  value?: string;
  firstAid?: string[];
  equipment?: string[];
  precautions?: string[];
}

export const ADVICE_RULES: AdviceRule[] = [
  // 最重要嘅一般建議排最前
  { always: true, firstAid: ["keep_distance"], equipment: ["gloves"], precautions: ["bite_scratch_risk"] },
  { level: "P0", firstAid: ["urgent_contact_vet"] },
  { gateFailed: true, firstAid: ["add_clearer_photo"] },

  // 按觀察
  { field: "traumaVehicle", value: "yes", firstAid: ["avoid_moving_spine"], equipment: ["stretcher_board"], precautions: ["traffic_safety", "support_spine"] },
  { field: "mobility", value: "unable_to_stand", firstAid: ["avoid_moving_spine"], equipment: ["stretcher_board"], precautions: ["support_spine"] },
  { field: "traumaFall", value: "yes", firstAid: ["avoid_moving_spine"], precautions: ["support_spine"] },
  { field: "bleeding", value: "heavy", firstAid: ["gentle_pressure_bleeding", "keep_warm"], equipment: ["first_aid_kit"] },
  { field: "bleeding", value: "minor", firstAid: ["gentle_pressure_bleeding"], equipment: ["first_aid_kit"] },
  { field: "breathingDistress", value: "severe", firstAid: ["keep_airway_clear"] },
  { field: "breathingDistress", value: "mild", firstAid: ["keep_airway_clear"] },
  { field: "consciousness", value: "unresponsive", firstAid: ["do_not_shake_check_breathing", "keep_warm"] },
  { field: "consciousness", value: "appears_dead", firstAid: ["possibly_deceased_no_bare_hands"], precautions: ["deceased_handling"] },
  { field: "traumaEntrapment", value: "yes", firstAid: ["do_not_pull_free"], equipment: ["cutting_tools"] },
  { field: "woundTypes", value: "fracture_deformity", firstAid: ["do_not_splint"], equipment: ["stretcher_board"], precautions: ["protect_injured_limb"] },
  { field: "woundTypes", value: "open_wound", firstAid: ["no_home_remedies"], equipment: ["first_aid_kit"] },
  { field: "woundTypes", value: "burn", firstAid: ["no_home_remedies"], equipment: ["first_aid_kit"] },
  { field: "woundTypes", value: "eye_injury", firstAid: ["do_not_touch_eye"] },
  { field: "woundTypes", value: "maggots", firstAid: ["do_not_remove_maggots"], precautions: ["avoid_skin_contact"] },
  { field: "woundTypes", value: "skin_disease", precautions: ["avoid_skin_contact"] },
  { field: "ageClass", value: "neonate", firstAid: ["neonate_watch_for_mother", "neonate_keep_warm_no_milk"], equipment: ["heat_source"] },
  { field: "bodyCondition", value: "emaciated", firstAid: ["keep_warm"] },

  // 按物種（Gate 唔通過都用）
  { species: "cat", equipment: ["carrier"] },
  { species: "dog", equipment: ["slip_lead"] },
  { species: "bird", firstAid: ["bird_dark_box"], equipment: ["ventilated_box"], precautions: ["bird_minimal_handling"] },
  { species: "other", equipment: ["carrier"] },
  { species: "unknown", equipment: ["carrier"] },

  // 其餘一般建議排最後
  { always: true, firstAid: ["do_not_chase", "no_food_water_medicine", "keep_quiet", "stay_and_observe"], equipment: ["towel_blanket"], precautions: ["wash_hands"] },
];

/** 每類最多幾條（太多反而冇人睇） */
export const ADVICE_LIMITS: Record<AdviceCategory, number> = { firstAid: 6, equipment: 6, precautions: 4 };
// ===========================================================================

function ruleApplies(rule: AdviceRule, obs: Observation, level: UrgencyLevel): boolean {
  if (rule.always) return true;
  const gateOk = obs.gate.animalVisible && obs.gate.imageUsable;
  if (rule.gateFailed) return !gateOk;
  if (rule.level) return rule.level === level;
  if (rule.species) return rule.species === obs.gate.speciesCategory;
  if (rule.field) {
    if (!gateOk) return false; // 相唔可信，觀察唔用
    const v = obs.findings[rule.field];
    return Array.isArray(v) ? (v as string[]).includes(rule.value!) : v === rule.value;
  }
  return false;
}

/** 揀建議代碼（純函數）：按規則次序、去重、每類有上限 */
export function selectAdvice(obs: Observation, level: UrgencyLevel): AIAdvice {
  const out: Record<AdviceCategory, string[]> = { firstAid: [], equipment: [], precautions: [] };
  for (const rule of ADVICE_RULES) {
    if (!ruleApplies(rule, obs, level)) continue;
    for (const cat of ADVICE_CATEGORIES) {
      for (const code of rule[cat] ?? []) {
        if (!out[cat].includes(code) && out[cat].length < ADVICE_LIMITS[cat]) out[cat].push(code);
      }
    }
  }
  return { ...out, libraryVersion: ADVICE_LIBRARY_VERSION };
}

// ---------- AI 補充說明（每宗案件最多一句） ----------
export const AI_NOTE_MAX = 200;

/**
 * AI 可以補充一句關於現場情況嘅說明，但唔信任：
 * 壓成一行、截短；有網址、電郵或者似電話號碼（連續 6 個或以上數字）就成句唔用
 */
export function cleanAiNote(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (/https?:\/\/|www\.|@/i.test(s)) return "";
  if (/\d(?:[\s\-().]*\d){5,}/.test(s)) return "";
  return s.length > AI_NOTE_MAX ? `${s.slice(0, AI_NOTE_MAX - 1)}…` : s;
}
