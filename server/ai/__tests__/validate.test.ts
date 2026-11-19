// AI 輸出驗證（analyze.v2 + Zod）：唔可以直接信 Gemini
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../config';
import { triage } from '../triage';
import { SchemaError, buildAnalysis, parseRaw, sensitivePositions, toObservation, uncertaintyOf } from '../validate';
import { VALID_RAW } from './fixtures';

const TWO = [
  { pos: 0, data: '' },
  { pos: 1, data: '' },
];


const text = (o: unknown) => JSON.stringify(o);

describe('parseRaw', () => {
  it('有效輸出', () => {
    expect(parseRaw(text(VALID_RAW)).mobility).toBe('limping');
  });

  it('唔係 JSON / 唔係 object → SchemaError', () => {
    for (const bad of ['not json', '```json\n{}\n```', '[1]', 'null', '"P0"']) {
      expect(() => parseRaw(bad)).toThrow(SchemaError);
    }
  });

  it.each([
    ['bleeding', 'gushing'],
    ['consciousness', 'Unresponsive'],
    ['speciesCategory', 'lion'],
    ['suggestedUrgency', 'P3'],
    ['animalVisible', 'yes'],
    ['woundTypes', ['open_wound', 'gunshot']],
    ['evidence', [{ finding: 'notAField', photo: 1 }]],
    ['evidence', [{ finding: 'bleeding', photo: 0 }]],
    ['sensitivePhotoNumbers', [1.5]],
  ])('%s = %j → SchemaError（唔會自己估）', (field, value) => {
    expect(() => parseRaw(text({ ...VALID_RAW, [field]: value }))).toThrow(SchemaError);
  });

  it('欠任何一個欄位 → SchemaError', () => {
    for (const k of Object.keys(VALID_RAW)) {
      const copy: Record<string, unknown> = { ...VALID_RAW };
      delete copy[k];
      expect(() => parseRaw(text(copy)), k).toThrow(SchemaError);
    }
  });

  it('多出嚟嘅欄位（例如 confidenceScore、status）會被刪走', () => {
    const r = parseRaw(text({ ...VALID_RAW, confidenceScore: 0.99, status: 'closed', urgency: 'P0' })) as Record<string, unknown>;
    expect('confidenceScore' in r).toBe(false);
    expect('status' in r).toBe(false);
    expect('urgency' in r).toBe(false);
  });

  it('SchemaError 可以留待之後再試', () => {
    let caught: unknown = null;
    try {
      parseRaw('{}');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaError);
    expect((caught as SchemaError).retryable).toBe(true);
  });
});

describe('toObservation', () => {
  it('證據相片編號轉返案件位置；超出範圍嘅刪走；重複嘅合併', () => {
    const images = [
      { pos: 0, data: '' },
      { pos: 3, data: '' },
    ];
    const raw = parseRaw(
      text({
        ...VALID_RAW,
        evidence: [
          { finding: 'bleeding', photo: 2 },
          { finding: 'bleeding', photo: 2 },
          { finding: 'mobility', photo: 5 },
        ],
      })
    );
    const { evidence } = toObservation(raw, images);
    expect(evidence).toEqual([{ finding: 'bleeding', photo: 3 }]);
  });

  it('紅旗證據指向唔存在嘅相 → triage 唔會當 P0', () => {
    const raw = parseRaw(text({ ...VALID_RAW, bleeding: 'heavy', evidence: [{ finding: 'bleeding', photo: 9 }] }));
    const { obs } = toObservation(raw, TWO);
    expect(triage(obs, 'P0').level).toBe('P1');
  });

  it('woundTypes 去重', () => {
    const raw = parseRaw(text({ ...VALID_RAW, woundTypes: ['burn', 'burn'] }));
    expect(toObservation(raw, TWO).obs.findings.woundTypes).toEqual(['burn']);
  });
});

describe('uncertaintyOf', () => {
  it('數 unknown（唔計 woundTypes 清單）', () => {
    const { obs } = toObservation(parseRaw(text(VALID_RAW)), TWO);
    expect(uncertaintyOf(obs)).toEqual({ unknownFindings: 1, totalFindings: 11, animalVisible: true, imageUsable: true });
  });
});

describe('sensitivePositions', () => {
  it('範圍外、非整數略過', () => {
    expect(sensitivePositions([0, 3, 99, -1], TWO, 2)).toEqual([]);
  });

  it('讀唔到嘅相一律當敏感', () => {
    const images = [
      { pos: 0, data: '' },
      { pos: 2, data: '' },
    ];
    expect(sensitivePositions([], images, 3)).toEqual([1]);
    expect(sensitivePositions([2], images, 3)).toEqual([1, 2]);
  });
});

describe('buildAnalysis', () => {
  it('第 4 版格式：等級用 triage，唔用 AI 建議；建議用代碼；冇 confidenceScore、冇 AI 原因文字、冇 AI 建議文字', () => {
    // AI 建議 P2，但觀察有傷 → triage P1
    const raw = parseRaw(text({ ...VALID_RAW, suggestedUrgency: 'P2' }));
    const { obs, evidence } = toObservation(raw, TWO);
    const t = triage(obs, raw.suggestedUrgency, []);
    const a = buildAnalysis(raw, obs, evidence, t, TWO, 2, new Date('2026-11-17T00:00:00Z'));
    expect(a.schemaVersion).toBe(SCHEMA_VERSION);
    expect(a.schemaVersion).toBe(5);
    expect(a.advice?.libraryVersion).toBe('advice.v1');
    expect(a.advice?.firstAid[0]).toBe('keep_distance');
    expect(a.advice?.firstAid).toContain('gentle_pressure_bleeding'); // bleeding minor
    expect(a.aiNote).toBe('The cat is under a parked car.');
    expect(a.urgencyLevel).toBe('P1');
    expect(a.triage).toEqual({
      reasonCodes: t.reasonCodes,
      needsHumanReview: false,
      rulesVersion: t.rulesVersion,
      modelSuggestion: 'P2',
    });
    expect(a.gate).toEqual({ animalVisible: true, imageUsable: true, speciesCategory: 'cat' });
    expect(a.sensitivePhotos).toEqual([1]);
    expect(a.analyzedAt).toBe('2026-11-17T00:00:00.000Z');
    for (const k of [
      'confidenceScore', 'urgencyReason', 'identifiedSpecies', 'apparentInjuries', 'suggestedUrgencyReason',
      'firstAidAdvice', 'rescueEquipment', 'handlingPrecautions', 'situationNote',
    ]) {
      expect(k in a, k).toBe(false);
    }
  });

  it('文字欄位截短；AI 加嘅建議文字會被刪走', () => {
    const raw = parseRaw(text({ ...VALID_RAW, estimatedBreed: 'x'.repeat(500), firstAidAdvice: ['Give milk'] }));
    const { obs, evidence } = toObservation(raw, TWO);
    const a = buildAnalysis(raw, obs, evidence, triage(obs, 'P1'), TWO, 2);
    expect(a.estimatedBreed).toHaveLength(100);
    expect('firstAidAdvice' in a).toBe(false);
  });

  it('AI 補充說明有電話號碼 → 唔用', () => {
    const raw = parseRaw(text({ ...VALID_RAW, situationNote: 'Call 2711 1234 now' }));
    const { obs, evidence } = toObservation(raw, TWO);
    expect(buildAnalysis(raw, obs, evidence, triage(obs, 'P1'), TWO, 2).aiNote).toBe('');
  });
});
