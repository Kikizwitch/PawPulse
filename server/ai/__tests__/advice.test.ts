// 揀建議（建議庫代碼）同 AI 補充說明清洗
import { describe, expect, it } from 'vitest';
import { ADVICE_CATEGORIES, ADVICE_LIBRARY, ADVICE_LIBRARY_VERSION, isPendingReview } from '../../../src/config/adviceLibrary';
import type { AIFindings, UrgencyLevel } from '../../../src/types';
import { ADVICE_LIMITS, ADVICE_RULES, AI_NOTE_MAX, cleanAiNote, selectAdvice } from '../advice';
import type { Observation } from '../triage';

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

function obs(over: Partial<AIFindings> = {}, gate: Partial<Observation['gate']> = {}): Observation {
  return {
    gate: { animalVisible: true, imageUsable: true, speciesCategory: 'cat', ...gate },
    findings: { ...HEALTHY, ...over },
    evidence: [],
  };
}

const select = (o: Observation, level: UrgencyLevel = 'P2') => selectAdvice(o, level);

describe('建議庫同規則表', () => {
  it('規則用到嘅每個代碼都喺建議庫', () => {
    for (const rule of ADVICE_RULES) {
      for (const cat of ADVICE_CATEGORIES) {
        for (const code of rule[cat] ?? []) {
          expect(ADVICE_LIBRARY[cat][code], `${cat}.${code}`).toBeDefined();
        }
      }
    }
  });

  it('建議庫每條都起碼有一條規則用到（冇死條目）', () => {
    for (const cat of ADVICE_CATEGORIES) {
      for (const code of Object.keys(ADVICE_LIBRARY[cat])) {
        expect(ADVICE_RULES.some((r) => r[cat]?.includes(code)), `${cat}.${code}`).toBe(true);
      }
    }
  });

  it('目前全部條目都係「待獸醫審核」', () => {
    for (const cat of ADVICE_CATEGORIES) {
      for (const code of Object.keys(ADVICE_LIBRARY[cat])) {
        expect(isPendingReview(cat, code), `${cat}.${code}`).toBe(true);
      }
    }
  });

  it('唔認得嘅代碼當未審核（fail-closed）', () => {
    expect(isPendingReview('firstAid', 'no_such_code')).toBe(true);
    expect(isPendingReview('firstAid', 'constructor')).toBe(true);
  });
});

describe('selectAdvice', () => {
  it('健康嘅貓：一般建議，第一條係保持距離；帶建議庫版本', () => {
    const a = select(obs());
    expect(a.firstAid[0]).toBe('keep_distance');
    expect(a.equipment).toEqual(['gloves', 'carrier', 'towel_blanket']);
    expect(a.precautions).toEqual(['bite_scratch_risk', 'wash_hands']);
    expect(a.libraryVersion).toBe(ADVICE_LIBRARY_VERSION);
  });

  it.each(ADVICE_RULES.filter((r) => r.field).map((r) => [`${r.field}=${r.value}`, r]))('觀察 %s → 揀到對應建議', (_k, rule) => {
    const over =
      rule.field === 'woundTypes'
        ? { woundTypes: [rule.value as AIFindings['woundTypes'][number]] }
        : ({ [rule.field!]: rule.value } as Partial<AIFindings>);
    const a = select(obs(over));
    for (const cat of ADVICE_CATEGORIES) {
      for (const code of rule[cat] ?? []) expect(a[cat], `${cat}.${code}`).toContain(code);
    }
  });

  it('P0 → 加「盡快聯絡獸醫」，排喺保持距離之後', () => {
    const a = select(obs(), 'P0');
    expect(a.firstAid.slice(0, 2)).toEqual(['keep_distance', 'urgent_contact_vet']);
    expect(select(obs(), 'P1').firstAid).not.toContain('urgent_contact_vet');
  });

  it('Gate 唔通過：唔用觀察（就算有大出血），提示補相', () => {
    const a = select(obs({ bleeding: 'heavy' }, { imageUsable: false }), 'P1');
    expect(a.firstAid).toContain('add_clearer_photo');
    expect(a.firstAid).not.toContain('gentle_pressure_bleeding');
    expect(select(obs()).firstAid).not.toContain('add_clearer_photo');
  });

  it.each([
    ['cat', 'carrier'],
    ['dog', 'slip_lead'],
    ['bird', 'ventilated_box'],
    ['other', 'carrier'],
    ['unknown', 'carrier'],
  ] as const)('物種 %s → %s', (species, equipment) => {
    expect(select(obs({}, { speciesCategory: species })).equipment).toContain(equipment);
  });

  it('雀鳥加專用建議', () => {
    const a = select(obs({}, { speciesCategory: 'bird' }));
    expect(a.firstAid).toContain('bird_dark_box');
    expect(a.precautions).toContain('bird_minimal_handling');
  });

  it('去重、每類有上限；特定建議優先過排尾嘅一般建議', () => {
    const many = obs({
      traumaVehicle: 'yes',
      mobility: 'unable_to_stand',
      bleeding: 'heavy',
      breathingDistress: 'severe',
      consciousness: 'unresponsive',
      woundTypes: ['open_wound', 'fracture_deformity', 'maggots', 'eye_injury'],
      ageClass: 'neonate',
    });
    const a = select(many, 'P0');
    for (const cat of ADVICE_CATEGORIES) {
      expect(a[cat].length).toBeLessThanOrEqual(ADVICE_LIMITS[cat]);
      expect(new Set(a[cat]).size).toBe(a[cat].length);
    }
    expect(a.firstAid).toContain('avoid_moving_spine');
    expect(a.firstAid).not.toContain('stay_and_observe');
  });
});

describe('cleanAiNote', () => {
  it('正常一句', () => {
    expect(cleanAiNote('  The cat is under a\n parked car. ')).toBe('The cat is under a parked car.');
  });

  it('空 / 唔係字串 → 空字串', () => {
    expect(cleanAiNote('')).toBe('');
    expect(cleanAiNote('   ')).toBe('');
    expect(cleanAiNote(null)).toBe('');
    expect(cleanAiNote(['x'])).toBe('');
  });

  it.each([
    'Call 2711 1234 for help',
    'Phone +852 9123-4567',
    'Contact (02) 555 0199',
    'See https://example.com',
    'Visit www.example.org',
    'Email help@example.com',
  ])('有電話、網址或電郵 → 成句唔用：%s', (s) => {
    expect(cleanAiNote(s)).toBe('');
  });

  it('普通數字（例如「3 隻幼貓」、時間）可以保留', () => {
    expect(cleanAiNote('There are 3 kittens in the box at 10:30.')).toBe('There are 3 kittens in the box at 10:30.');
  });

  it('太長會截短', () => {
    const r = cleanAiNote('a'.repeat(500));
    expect(r.length).toBe(AI_NOTE_MAX);
    expect(r.endsWith('…')).toBe(true);
  });
});
