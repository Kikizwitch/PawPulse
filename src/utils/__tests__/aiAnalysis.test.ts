// 顯示 AI 結果：新舊格式都要識顯示；資料壞咗都唔可以 crash
import { beforeAll, describe, expect, it } from 'vitest';
import i18next, { type TFunction } from 'i18next';
import en from '../../locales/en.json';
import type { AIAnalysisResult } from '../../types';
import { adviceView, injurySummary, isAiPending, isStructured, notableFindings, reasonLabels, speciesLabel, unknownFindings } from '../aiAnalysis';

let t: TFunction;
beforeAll(async () => {
  const i = i18next.createInstance();
  await i.init({ lng: 'en', resources: { en: { translation: en } } });
  t = i.t;
});

const LEGACY: AIAnalysisResult = {
  identifiedSpecies: 'Cat',
  estimatedBreed: 'Tabby',
  appearanceDescription: '',
  apparentInjuries: ['Cut on leg'],
  urgencyLevel: 'P1',
  urgencyReason: 'Visible cut',
  rescueEquipment: [],
  firstAidAdvice: [],
  handlingPrecautions: [],
  confidenceScore: 0.9,
  analyzedAt: '2025-01-01T00:00:00Z',
};

const V3: AIAnalysisResult = {
  schemaVersion: 3,
  estimatedBreed: 'Tabby',
  appearanceDescription: '',
  urgencyLevel: 'P0',
  rescueEquipment: [],
  firstAidAdvice: [],
  handlingPrecautions: [],
  analyzedAt: '2026-11-17T00:00:00Z',
  gate: { animalVisible: true, imageUsable: true, speciesCategory: 'dog' },
  findings: {
    ageClass: 'adult',
    consciousness: 'alert',
    mobility: 'unknown',
    bleeding: 'heavy',
    breathingDistress: 'none',
    traumaVehicle: 'yes',
    traumaFall: 'no',
    traumaBite: 'no',
    traumaEntrapment: 'unknown',
    wounds: 'present',
    woundTypes: ['open_wound'],
    bodyCondition: 'thin',
  },
  evidence: [{ finding: 'bleeding', photo: 0 }],
  triage: { reasonCodes: ['heavy_bleeding', 'mobility_unknown'], needsHumanReview: false, rulesVersion: 'triage.v1', modelSuggestion: 'P1' },
  uncertainty: { unknownFindings: 2, totalFindings: 11, animalVisible: true, imageUsable: true },
};

describe('舊格式（第 1、2 版）', () => {
  it('用 AI 寫嘅文字', () => {
    expect(isStructured(LEGACY)).toBe(false);
    expect(reasonLabels(LEGACY, t)).toEqual(['Visible cut']);
    expect(injurySummary(LEGACY, t)).toEqual(['Cut on leg']);
    expect(speciesLabel(LEGACY, t)).toBe('Cat');
  });

  it('第 2 版（schemaVersion 2）都係舊格式', () => {
    expect(isStructured({ ...LEGACY, schemaVersion: 2 })).toBe(false);
  });
});

describe('第 3 版', () => {
  it('原因代碼翻譯', () => {
    expect(reasonLabels(V3, t)).toEqual(['Heavy bleeding', 'Mobility could not be determined from the photos']);
  });

  it('異常觀察（唔包括正常值同 unknown；有 woundTypes 就唔重複 wounds）', () => {
    expect(notableFindings(V3, t)).toEqual(['Bleeding: Heavy', 'Suspected vehicle collision', 'Open wound']);
    expect(injurySummary(V3, t)).toEqual(notableFindings(V3, t));
  });

  it('睇唔清嘅欄位', () => {
    expect(unknownFindings(V3, t)).toEqual(['Mobility', 'Trapped or entangled']);
  });

  it('物種用 gate', () => {
    expect(speciesLabel(V3, t)).toBe('Dog');
  });

  it('唔認得嘅原因代碼顯示代碼本身，唔會 crash', () => {
    expect(reasonLabels({ ...V3, triage: { ...V3.triage!, reasonCodes: ['future_code'] } }, t)).toEqual(['future_code']);
  });
});

describe('壞資料唔會 crash', () => {
  it('null / undefined', () => {
    expect(injurySummary(null, t)).toEqual([]);
    expect(injurySummary(undefined, t)).toEqual([]);
  });

  it('欄位型別唔啱', () => {
    const bad = {
      ...V3,
      findings: { woundTypes: 'burn', bleeding: 42, mobility: null },
      triage: { reasonCodes: 'heavy_bleeding' },
      gate: null,
    } as unknown as AIAnalysisResult;
    expect(notableFindings(bad, t)).toEqual([]);
    expect(reasonLabels(bad, t)).toEqual([]);
    expect(speciesLabel(bad, t)).toBe('');
    expect(injurySummary({ ...LEGACY, apparentInjuries: 'oops' } as unknown as AIAnalysisResult, t)).toEqual([]);
  });

  it('寫咗 schemaVersion 3 但冇 findings → 當舊格式', () => {
    expect(isStructured({ ...LEGACY, schemaVersion: 3 })).toBe(false);
  });
});

describe('adviceView', () => {
  const V4: AIAnalysisResult = {
    ...V3,
    schemaVersion: 4,
    advice: {
      firstAid: ['keep_distance', 'no_such_code', 'gentle_pressure_bleeding'],
      equipment: ['gloves'],
      precautions: ['wash_hands'],
      libraryVersion: 'advice.v1',
    },
    aiNote: 'The dog is behind a fence.',
  };

  it('第 4 版：建議庫代碼翻譯，唔認得嘅代碼唔顯示，全部標「待獸醫審核」', () => {
    const v = adviceView(V4, t);
    expect(v.source).toBe('library');
    expect(v.firstAid.map((i) => i.text)).toEqual([
      'Keep a safe distance and watch the animal. Injured or frightened animals may bite or scratch.',
      "If the animal is calm and you can approach safely, press a clean cloth gently on the bleeding area. If blood soaks through, don't remove it; add another layer.",
    ]);
    expect(v.equipment.map((i) => i.text)).toEqual(['Thick protective gloves']);
    expect([...v.firstAid, ...v.equipment, ...v.precautions].every((i) => i.pendingReview)).toBe(true);
    expect(v.aiNote).toBe('The dog is behind a fence.');
  });

  it('舊版：用 AI 寫嘅文字，一律未審核，冇 AI 補充說明', () => {
    const v = adviceView({ ...LEGACY, firstAidAdvice: ['Stay calm', 5 as unknown as string] }, t);
    expect(v.source).toBe('ai');
    expect(v.firstAid).toEqual([{ text: 'Stay calm', pendingReview: true }]);
    expect(v.aiNote).toBe('');
  });

  it('第 3 版（AI 建議文字）都係舊版處理', () => {
    expect(adviceView({ ...V3, firstAidAdvice: ['x'] }, t).source).toBe('ai');
  });

  it('壞資料唔會 crash', () => {
    const v = adviceView({ ...V4, advice: { firstAid: 'keep_distance' } as never, aiNote: 42 as never }, t);
    expect(v.firstAid).toEqual([]);
    expect(v.aiNote).toBe('');
  });
});

describe('isAiPending', () => {
  const now = Date.parse('2026-11-17T10:00:00Z');
  const base = { aiAnalysis: null, createdAt: '2026-11-17T09:59:00Z', editedAt: null };

  it('queued / running 而且未太耐 → 分析中', () => {
    expect(isAiPending({ ...base, aiStatus: 'queued' }, now)).toBe(true);
    expect(isAiPending({ ...base, aiStatus: 'running' }, now)).toBe(true);
  });

  it('其他狀態、或者已經有結果 → 唔係分析中', () => {
    for (const s of ['done', 'failed', 'skipped', null, undefined] as const) {
      expect(isAiPending({ ...base, aiStatus: s }, now)).toBe(false);
    }
    expect(isAiPending({ ...base, aiStatus: 'queued', aiAnalysis: {} as never }, now)).toBe(false);
  });

  it('超過 20 分鐘仍然 queued（例如重試用晒）→ 當冇回應', () => {
    expect(isAiPending({ ...base, aiStatus: 'queued', createdAt: '2026-11-17T09:39:00Z' }, now)).toBe(false);
  });

  it('修改過：由修改時間計', () => {
    expect(
      isAiPending({ ...base, aiStatus: 'queued', createdAt: '2026-11-16T09:00:00Z', editedAt: '2026-11-17T09:58:00Z' }, now)
    ).toBe(true);
  });

  it('時間壞咗 → 唔係分析中', () => {
    expect(isAiPending({ ...base, aiStatus: 'queued', createdAt: 'not a date' }, now)).toBe(false);
  });
});
