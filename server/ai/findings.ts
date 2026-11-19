// AI 觀察結果（Gate + Observe）嘅唯一定義：Gemini response schema、執行時驗證、triage 都由呢度嚟
// 每個觀察欄位都可以答 unknown：相睇唔清就答 unknown，唔好估
// 對外儲存嘅型別喺 src/types.ts（AIGate / AIFindings），下面有編譯時檢查，兩邊唔一致 lint 會失敗
import { z } from "zod";
import type { AIFindings, AIGate } from "../../src/types";

const triState = z.enum(["yes", "no", "unknown"]);

// ---------- Gate：張相用唔用得 ----------
export const GateSchema = z.object({
  animalVisible: z.boolean(),
  imageUsable: z.boolean(),
  speciesCategory: z.enum(["cat", "dog", "bird", "other", "unknown"]),
});

// ---------- Observe：睇到啲乜（只係觀察，唔係判斷緊急程度） ----------
export const FindingsSchema = z.object({
  ageClass: z.enum(["neonate", "juvenile", "adult", "senior", "unknown"]),
  consciousness: z.enum(["alert", "dull", "unresponsive", "appears_dead", "unknown"]),
  mobility: z.enum(["normal", "limping", "unable_to_stand", "unknown"]),
  bleeding: z.enum(["none", "minor", "heavy", "unknown"]),
  breathingDistress: z.enum(["none", "mild", "severe", "unknown"]),
  traumaVehicle: triState,
  traumaFall: triState,
  traumaBite: triState,
  traumaEntrapment: triState,
  wounds: z.enum(["none", "present", "unknown"]),
  woundTypes: z.array(
    z.enum(["open_wound", "fracture_deformity", "burn", "eye_injury", "skin_disease", "maggots", "other"])
  ),
  bodyCondition: z.enum(["emaciated", "thin", "normal", "overweight", "unknown"]),
});

export type Gate = z.infer<typeof GateSchema>;
export type Findings = z.infer<typeof FindingsSchema>;
export type FindingField = keyof Findings;

export const FINDING_FIELDS = Object.keys(FindingsSchema.shape) as FindingField[];
/** 單一值嘅欄位（woundTypes 係清單，唔計入 unknown 數目） */
export const SCALAR_FINDING_FIELDS = FINDING_FIELDS.filter((f) => f !== "woundTypes") as Exclude<
  FindingField,
  "woundTypes"
>[];

/** 證據：邊個觀察喺第幾張相睇到（1..n，AI 嘅編號） */
export const EvidenceSchema = z.object({
  finding: z.enum(FINDING_FIELDS as [FindingField, ...FindingField[]]),
  photo: z.int().min(1).max(10),
});

// ---------- 編譯時檢查：Zod 定義同 src/types.ts 一致 ----------
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const findingsMatch: Equals<Findings, AIFindings> = true;
const gateMatch: Equals<Gate, AIGate> = true;
void findingsMatch;
void gateMatch;
