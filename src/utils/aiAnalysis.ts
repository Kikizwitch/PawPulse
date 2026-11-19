// AI 分析結果顯示：同一套函數處理所有版本（舊版 1、2 係 AI 寫嘅文字；第 3 版係觀察 + 原因代碼）
// firestore.rules 冇驗證 aiAnalysis 入面嘅結構，所以每個欄位都要檢查型別，唔可以假設一定啱
// 用呢度嘅元件一定要 call useTranslation()，再將 t 傳入嚟，轉語言先會即時更新
import type { TFunction } from 'i18next';
import type { AIAnalysisResult, AIFindings, StrayReport } from '../types';
import { ADVICE_LIBRARY, isPendingReview, type AdviceCategory } from '../config/adviceLibrary';

type Field = keyof AIFindings;

// 顯示次序
const FIELD_ORDER: Field[] = [
  'consciousness', 'breathingDistress', 'bleeding', 'mobility',
  'traumaVehicle', 'traumaFall', 'traumaBite', 'traumaEntrapment',
  'wounds', 'woundTypes', 'bodyCondition', 'ageClass',
];

// 正常值（唔使顯示做「異常」）；unknown 另外處理
const NORMAL: Record<Exclude<Field, 'woundTypes'>, string[]> = {
  ageClass: ['juvenile', 'adult', 'senior'],
  consciousness: ['alert'],
  mobility: ['normal'],
  bleeding: ['none'],
  breathingDistress: ['none'],
  traumaVehicle: ['no'],
  traumaFall: ['no'],
  traumaBite: ['no'],
  traumaEntrapment: ['no'],
  wounds: ['none'],
  bodyCondition: ['normal', 'thin', 'overweight'],
};

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** 第 3 版（有觀察同 triage）先當結構化 */
export function isStructured(a: AIAnalysisResult | null | undefined): boolean {
  return !!a && (a.schemaVersion ?? 1) >= 3 && !!a.findings && typeof a.findings === 'object' && !!a.triage;
}

const valueGroup = (field: Field) => (field.startsWith('trauma') ? 'trauma' : field);

function valueLabel(t: TFunction, field: Field, value: string): string {
  return t(`aiFindings.value.${valueGroup(field)}.${value}`, { defaultValue: value });
}

function fieldLabel(t: TFunction, field: Field): string {
  return t(`aiFindings.field.${field}`, { defaultValue: field });
}

/** 異常觀察（顯示做傷勢清單） */
export function notableFindings(a: AIAnalysisResult, t: TFunction): string[] {
  const f = a.findings as Partial<Record<Field, unknown>>;
  const out: string[] = [];
  for (const field of FIELD_ORDER) {
    const v = f[field];
    if (field === 'woundTypes') {
      for (const w of asStrings(v)) out.push(valueLabel(t, field, w));
      continue;
    }
    if (typeof v !== 'string' || v === 'unknown' || NORMAL[field].includes(v)) continue;
    // 「wounds: present」已經由 woundTypes 講清楚，有類型就唔重複
    if (field === 'wounds' && asStrings(f.woundTypes).length > 0) continue;
    // trauma「有跡象」：直接用欄位名（例如「疑似遭車輛撞擊」）
    out.push(
      field.startsWith('trauma')
        ? fieldLabel(t, field)
        : t('aiFindings.pair', { field: fieldLabel(t, field), value: valueLabel(t, field, v) })
    );
  }
  return out;
}

/** 睇唔清（unknown）嘅觀察欄位名 */
export function unknownFindings(a: AIAnalysisResult, t: TFunction): string[] {
  const f = a.findings as Partial<Record<Field, unknown>>;
  return FIELD_ORDER.filter((field) => f[field] === 'unknown').map((field) => fieldLabel(t, field));
}

/** 緊急度原因：第 3 版用原因代碼翻譯；舊版用 AI 寫嘅文字 */
export function reasonLabels(a: AIAnalysisResult, t: TFunction): string[] {
  if (isStructured(a)) {
    return asStrings(a.triage?.reasonCodes).map((code) => t(`triage.reason.${code}`, { defaultValue: code }));
  }
  return typeof a.urgencyReason === 'string' && a.urgencyReason ? [a.urgencyReason] : [];
}

/** 傷勢清單（案件列表、地圖用）：第 3 版用觀察；舊版用 AI 寫嘅文字 */
export function injurySummary(a: AIAnalysisResult | null | undefined, t: TFunction): string[] {
  if (!a) return [];
  return isStructured(a) ? notableFindings(a, t) : asStrings(a.apparentInjuries);
}

/** 物種：第 3 版用 gate.speciesCategory；舊版用 AI 寫嘅文字；冇就回傳空字串 */
export function speciesLabel(a: AIAnalysisResult, t: TFunction): string {
  if (isStructured(a)) {
    const s = a.gate?.speciesCategory;
    return typeof s === 'string' ? t(`aiFindings.species.${s}`, { defaultValue: s }) : '';
  }
  return typeof a.identifiedSpecies === 'string' ? a.identifiedSpecies : '';
}

// ---------- 建議（第 4 版起用建議庫代碼；舊版係 AI 寫嘅文字） ----------

export interface AdviceItem {
  text: string;
  /** 未經獸醫審核（AI 寫嘅文字一律當未審核） */
  pendingReview: boolean;
}

export interface AdviceView {
  /** library = 建議庫（PawPulse 擬定）；ai = 舊版 AI 寫嘅文字 */
  source: 'library' | 'ai';
  firstAid: AdviceItem[];
  equipment: AdviceItem[];
  precautions: AdviceItem[];
  /** 第 4 版：AI 補充嘅一句（要標明係 AI 生成）；冇就係空字串 */
  aiNote: string;
}

function libraryItems(t: TFunction, category: AdviceCategory, codes: unknown): AdviceItem[] {
  return asStrings(codes)
    // 唔喺建議庫嘅代碼唔顯示（例如資料被改過、或者已刪除嘅條目）
    .filter((code) => Object.prototype.hasOwnProperty.call(ADVICE_LIBRARY[category], code))
    .map((code) => ({ text: t(`advice.${category}.${code}`, { defaultValue: '' }), pendingReview: isPendingReview(category, code) }))
    .filter((item) => item.text !== '');
}

const aiItems = (v: unknown): AdviceItem[] => asStrings(v).map((text) => ({ text, pendingReview: true }));

export function adviceView(a: AIAnalysisResult, t: TFunction): AdviceView {
  const adv = a.advice;
  if ((a.schemaVersion ?? 1) >= 4 && adv && typeof adv === 'object') {
    return {
      source: 'library',
      firstAid: libraryItems(t, 'firstAid', adv.firstAid),
      equipment: libraryItems(t, 'equipment', adv.equipment),
      precautions: libraryItems(t, 'precautions', adv.precautions),
      aiNote: typeof a.aiNote === 'string' ? a.aiNote : '',
    };
  }
  return {
    source: 'ai',
    firstAid: aiItems(a.firstAidAdvice),
    equipment: aiItems(a.rescueEquipment),
    precautions: aiItems(a.handlingPrecautions),
    aiNote: '',
  };
}

// ---------- AI 分析進度（Phase 4：Cloud Tasks 排隊） ----------

/** 建立／修改後超過 20 分鐘仍然 queued / running，當冇回應（AI 只喺 15 分鐘內分析，加埋重試時間） */
export const AI_PENDING_MAX_MS = 20 * 60 * 1000;

/** 應唔應該顯示「AI 分析中」：未有結果、狀態係 queued / running，而且未太耐 */
export function isAiPending(
  report: Pick<StrayReport, 'aiStatus' | 'aiAnalysis' | 'createdAt' | 'editedAt'>,
  now: number = Date.now(),
  maxAgeMs: number = AI_PENDING_MAX_MS
): boolean {
  if (report.aiAnalysis) return false;
  if (report.aiStatus !== 'queued' && report.aiStatus !== 'running') return false;
  const since = Date.parse(report.editedAt || report.createdAt);
  return Number.isFinite(since) && now - since >= 0 && now - since < maxAgeMs;
}
