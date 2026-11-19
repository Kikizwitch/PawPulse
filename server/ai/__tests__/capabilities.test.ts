// 案件需要嘅 NGO 能力、物種唔一致
import { describe, expect, it } from 'vitest';
import type { AIAnalysisResult, AIFindings } from '../../../src/types';
import { CAPABILITY_RULES, MATCHING_RULES_VERSION, deriveMatching } from '../capabilities';

const HEALTHY: AIFindings = {
  ageClass: 'adult',
  consciousness: 'alert',
  mobility: 'normal',
  bleeding: 'none',
  breathingDistress: 'none',
  traumaVehicle: 'no',
  traumaFall: 'no',
  traumaBite: 'no',
  traumaEntrapment: 'no',
  wounds: 'none',
  woundTypes: [],
  bodyCondition: 'normal',
};

function analysis(over: Partial<AIFindings> = {}, gate: Partial<NonNullable<AIAnalysisResult['gate']>> = {}): AIAnalysisResult {
  return {
    schemaVersion: 5,
    estimatedBreed: '',
    appearanceDescription: '',
    urgencyLevel: 'P1',
    analyzedAt: '',
    gate: { animalVisible: true, imageUsable: true, speciesCategory: 'cat', ...gate },
    findings: { ...HEALTHY, ...over },
  };
}

describe('requiredCapabilities', () => {
  it.each(CAPABILITY_RULES.filter((r) => r.field).map((r) => [`${r.field}=${r.value} → ${r.capability}`, r]))('%s', (_k, rule) => {
    const over =
      rule.field === 'woundTypes'
        ? { woundTypes: [rule.value as AIFindings['woundTypes'][number]] }
        : ({ [rule.field!]: rule.value } as Partial<AIFindings>);
    expect(deriveMatching(analysis(over), 'cat', 'P1').requiredCapabilities).toContain(rule.capability);
  });

  it('P0 → 緊急獸醫 + 接送', () => {
    expect(deriveMatching(analysis(), 'cat', 'P0').requiredCapabilities).toEqual(['emergency_vet', 'transport']);
  });

  it('P2 健康流浪動物 → 收容', () => {
    expect(deriveMatching(analysis(), 'cat', 'P2').requiredCapabilities).toEqual(['shelter']);
  });

  it('P1 冇特別觀察 → 冇特別需要', () => {
    expect(deriveMatching(analysis(), 'cat', 'P1').requiredCapabilities).toEqual([]);
  });

  it('去重（車禍 + 骨折都係手術）', () => {
    const r = deriveMatching(analysis({ traumaVehicle: 'yes', woundTypes: ['fracture_deformity'] }), 'cat', 'P1');
    expect(r.requiredCapabilities.filter((c) => c === 'surgery')).toHaveLength(1);
  });

  it('相片唔可信（Gate 唔通過）→ 唔用觀察，只按等級', () => {
    const r = deriveMatching(analysis({ ageClass: 'neonate' }, { imageUsable: false }), 'cat', 'P1');
    expect(r.requiredCapabilities).toEqual([]);
  });

  it('冇 AI 結果 → 只按等級', () => {
    expect(deriveMatching(null, 'dog', 'P0').requiredCapabilities).toEqual(['emergency_vet', 'transport']);
    expect(deriveMatching(undefined, 'dog', 'P1').requiredCapabilities).toEqual([]);
  });

  it('壞資料唔會 crash', () => {
    const bad = { ...analysis(), findings: 'oops' } as unknown as AIAnalysisResult;
    expect(deriveMatching(bad, 'cat', 'P1').requiredCapabilities).toEqual([]);
  });

  it('帶規則版本', () => {
    expect(deriveMatching(null, 'cat', 'P1').rulesVersion).toBe(MATCHING_RULES_VERSION);
  });
});

describe('物種唔一致', () => {
  it('一樣 → 唔係唔一致，只用一個物種', () => {
    expect(deriveMatching(analysis(), 'cat', 'P1')).toMatchObject({ speciesMismatch: false, species: ['cat'] });
  });

  it('唔一樣 → 唔一致，兩個物種都考慮（報案人揀嘅排先）', () => {
    expect(deriveMatching(analysis({}, { speciesCategory: 'dog' }), 'cat', 'P1')).toMatchObject({
      speciesMismatch: true,
      species: ['cat', 'dog'],
    });
  });

  it('AI 答 unknown → 唔算唔一致', () => {
    expect(deriveMatching(analysis({}, { speciesCategory: 'unknown' }), 'cat', 'P1')).toMatchObject({
      speciesMismatch: false,
      species: ['cat'],
    });
  });

  it('相片唔可信 → 唔理 AI 物種', () => {
    expect(deriveMatching(analysis({}, { speciesCategory: 'dog', animalVisible: false }), 'cat', 'P1').speciesMismatch).toBe(false);
  });

  it('報案人揀 other、AI 話係貓 → 唔一致（兩個都考慮）', () => {
    expect(deriveMatching(analysis(), 'other', 'P1').species).toEqual(['other', 'cat']);
  });

  it('報案人物種唔認得 → 當 other', () => {
    expect(deriveMatching(null, 'lion', 'P1').species).toEqual(['other']);
  });
});
