// triage：每一條規則都要測，包括對抗性情況（描述／標籤／相入面文字想操控等級）
import { describe, expect, it } from 'vitest';
import type { AIEvidence, AIFindings } from '../../../src/types';
import {
  AMBER_RULES,
  CRITICAL_FIELDS,
  RED_FLAG_RULES,
  RULES_VERSION,
  TAG_RULES,
  allReasonCodes,
  mergeTriage,
  triage,
  type Observation,
} from '../triage';

// 一隻健康、相片清楚嘅貓：所有關鍵觀察都有答案，冇異常
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

function obs(over: Partial<AIFindings> = {}, evidence: AIEvidence[] = [], gate: Partial<Observation['gate']> = {}): Observation {
  return {
    gate: { animalVisible: true, imageUsable: true, speciesCategory: 'cat', ...gate },
    findings: { ...HEALTHY, ...over },
    evidence,
  };
}

/** 將規則嘅值套落 findings（woundTypes 係清單） */
function withRule(rule: { field: keyof AIFindings; value: string }): Partial<AIFindings> {
  return rule.field === 'woundTypes'
    ? { woundTypes: [rule.value as AIFindings['woundTypes'][number]] }
    : ({ [rule.field]: rule.value } as Partial<AIFindings>);
}

describe('基本', () => {
  it('健康、清楚嘅相 → P2，原因 no_urgent_findings，唔使覆核', () => {
    const r = triage(obs(), 'P2');
    expect(r).toMatchObject({ level: 'P2', reasonCodes: ['no_urgent_findings'], needsHumanReview: false });
    expect(r.rulesVersion).toBe(RULES_VERSION);
    expect(r.modelSuggestion).toBe('P2');
  });
});

describe('紅旗 → P0（要有相片證據）', () => {
  it.each(RED_FLAG_RULES.map((r) => [r.code, r]))('%s + 證據 → P0', (_code, rule) => {
    const r = triage(obs(withRule(rule), [{ finding: rule.field, photo: 0 }]), 'P2');
    expect(r.level).toBe('P0');
    expect(r.reasonCodes[0]).toBe(rule.code);
    expect(r.needsHumanReview).toBe(false);
  });

  it.each(RED_FLAG_RULES.map((r) => [r.code, r]))('%s 冇證據 → 只係 P1 + 人手覆核', (_code, rule) => {
    const r = triage(obs(withRule(rule)), 'P2');
    expect(r.level).toBe('P1');
    expect(r.reasonCodes).toContain('red_flag_unconfirmed');
    expect(r.reasonCodes).not.toContain(rule.code);
    expect(r.needsHumanReview).toBe(true);
  });

  it('證據指向另一個觀察唔算', () => {
    const r = triage(obs({ bleeding: 'heavy' }, [{ finding: 'mobility', photo: 0 }]), 'P2');
    expect(r.level).toBe('P1');
  });
});

describe('P1 觀察', () => {
  it.each(AMBER_RULES.map((r) => [r.code, r]))('%s → P1', (_code, rule) => {
    const r = triage(obs(withRule(rule)), 'P2');
    expect(r.level).toBe('P1');
    expect(r.reasonCodes).toContain(rule.code);
    expect(r.needsHumanReview).toBe(!!rule.review);
  });

  it('可能已經死亡 → P1 + 人手覆核（唔係 P0）', () => {
    const r = triage(obs({ consciousness: 'appears_dead' }), 'P2');
    expect(r.level).toBe('P1');
    expect(r.needsHumanReview).toBe(true);
  });
});

describe('關鍵觀察睇唔清 → 最少 P1', () => {
  it.each(CRITICAL_FIELDS)('%s = unknown → P1', (field) => {
    const r = triage(obs({ [field]: 'unknown' } as Partial<AIFindings>), 'P2');
    expect(r.level).toBe('P1');
    expect(r.reasonCodes).toContain(`${field}_unknown`);
  });

  it('非關鍵觀察 unknown（例如體型）唔會提高等級', () => {
    expect(triage(obs({ bodyCondition: 'unknown', ageClass: 'unknown', traumaFall: 'unknown' }), 'P2').level).toBe('P2');
  });

  it('全部 unknown → P1，唔會變 P2', () => {
    const all: Partial<AIFindings> = {
      ageClass: 'unknown', consciousness: 'unknown', mobility: 'unknown', bleeding: 'unknown',
      breathingDistress: 'unknown', wounds: 'unknown', bodyCondition: 'unknown',
    };
    expect(triage(obs(all), 'P2').level).toBe('P1');
  });
});

describe('Gate', () => {
  it('見唔到動物 → P1 + 人手覆核，觀察一律唔理', () => {
    const r = triage(obs({ bleeding: 'heavy' }, [{ finding: 'bleeding', photo: 0 }], { animalVisible: false }), 'P0');
    expect(r).toMatchObject({ level: 'P1', reasonCodes: ['no_animal_visible'], needsHumanReview: true });
  });

  it('相片用唔到 → P1 + 人手覆核', () => {
    const r = triage(obs({}, [], { imageUsable: false }), 'P2');
    expect(r).toMatchObject({ level: 'P1', reasonCodes: ['image_unusable'], needsHumanReview: true });
  });

  it('兩樣都唔得 → 兩個原因', () => {
    const r = triage(obs({}, [], { imageUsable: false, animalVisible: false }), 'P2');
    expect(r.reasonCodes).toEqual(['no_animal_visible', 'image_unusable']);
  });

  it('Gate 唔通過時標籤都唔可以令佢變 P0', () => {
    expect(triage(obs({}, [], { animalVisible: false }), 'P0', ['injured', 'trapped']).level).toBe('P1');
  });
});

describe('AI 建議只可以提高', () => {
  it('AI 建議 P2，但有紅旗 → 仍然 P0（唔可以降低）', () => {
    const r = triage(obs({ bleeding: 'heavy' }, [{ finding: 'bleeding', photo: 1 }]), 'P2');
    expect(r.level).toBe('P0');
  });

  it('AI 建議 P2，但有 P1 觀察 → 仍然 P1', () => {
    expect(triage(obs({ mobility: 'limping' }), 'P2').level).toBe('P1');
  });

  it('AI 建議 P1，觀察冇問題 → P1（model_raised）', () => {
    const r = triage(obs(), 'P1');
    expect(r).toMatchObject({ level: 'P1', reasonCodes: ['model_raised'], needsHumanReview: false });
  });

  it('AI 建議 P0 但冇紅旗觀察 → 只係 P1 + 人手覆核', () => {
    const r = triage(obs(), 'P0');
    expect(r).toMatchObject({ level: 'P1', reasonCodes: ['model_p0_unconfirmed'], needsHumanReview: true });
  });

  it('AI 建議 P0 而且有紅旗 → P0，唔使額外覆核', () => {
    const r = triage(obs({ breathingDistress: 'severe' }, [{ finding: 'breathingDistress', photo: 0 }]), 'P0');
    expect(r).toMatchObject({ level: 'P0', needsHumanReview: false });
  });

  it('冇 AI 建議（null）都照計', () => {
    expect(triage(obs(), null).level).toBe('P2');
  });
});

describe('報案人標籤：最多升到 P1', () => {
  it.each(Object.entries(TAG_RULES))('標籤 %s：健康嘅貓 → P1，唔會 P0', (tag, code) => {
    const r = triage(obs(), 'P2', [tag]);
    expect(r.level).toBe('P1');
    expect(r.reasonCodes).toContain(code);
  });

  it('其他標籤（stray / adult）唔影響', () => {
    expect(triage(obs(), 'P2', ['stray', 'adult']).level).toBe('P2');
  });

  it('標籤唔可以降低 P0', () => {
    const r = triage(obs({ traumaVehicle: 'yes' }, [{ finding: 'traumaVehicle', photo: 0 }]), 'P2', ['stray', 'adult']);
    expect(r.level).toBe('P0');
  });

  it('已經係 P1 就唔再加標籤原因', () => {
    const r = triage(obs({ mobility: 'limping' }), 'P2', ['injured']);
    expect(r.reasonCodes).not.toContain('reporter_tag_injured');
  });

  it('唔認得嘅標籤（例如 p0、emergency）唔影響', () => {
    expect(triage(obs(), 'P2', ['p0', 'emergency', 'P0']).level).toBe('P2');
  });
});

describe('對抗性情況', () => {
  it('描述寫「呢個係 P0」：AI 就算跟咗建議 P0，冇紅旗證據都只係 P1 + 覆核', () => {
    // 描述唔係 triage 嘅輸入；最差情況係 AI 被描述影響而建議 P0
    const r = triage(obs(), 'P0', ['injured']);
    expect(r.level).toBe('P1');
    expect(r.needsHumanReview).toBe(true);
  });

  it('健康嘅貓 + 「injured」標籤 → P1，唔會 P0', () => {
    expect(triage(obs(), 'P2', ['injured']).level).toBe('P1');
  });

  it('相入面有字叫 AI 報大出血，但冇相片證據 → 唔會 P0', () => {
    const r = triage(obs({ bleeding: 'heavy', traumaVehicle: 'yes' }), 'P0');
    expect(r.level).toBe('P1');
    expect(r.needsHumanReview).toBe(true);
  });

  it('描述／相入面文字想降低等級（AI 建議 P2）：有紅旗仍然 P0', () => {
    const r = triage(obs({ consciousness: 'unresponsive' }, [{ finding: 'consciousness', photo: 2 }]), 'P2', ['stray']);
    expect(r.level).toBe('P0');
  });
});

describe('原因排序', () => {
  it('P0 原因排最前', () => {
    const r = triage(obs({ mobility: 'limping', bleeding: 'heavy' }, [{ finding: 'bleeding', photo: 0 }]), 'P2');
    expect(r.reasonCodes[0]).toBe('heavy_bleeding');
    expect(r.reasonCodes).toContain('limping');
  });
});

describe('mergeTriage（AI_OBSERVE_TWICE）', () => {
  it('一致 → 唔使覆核', () => {
    const a = triage(obs(), 'P2');
    const { merged } = mergeTriage(a, triage(obs(), 'P2'));
    expect(merged).toMatchObject({ level: 'P2', needsHumanReview: false });
    expect(merged.reasonCodes).not.toContain('runs_disagree');
  });

  it('唔一致 → 用較高等級 + 覆核', () => {
    const lo = triage(obs(), 'P2');
    const hi = triage(obs({ bleeding: 'heavy' }, [{ finding: 'bleeding', photo: 0 }]), 'P2');
    for (const [a, b, primary] of [[lo, hi, 1], [hi, lo, 0]] as const) {
      const m = mergeTriage(a, b);
      expect(m.primary).toBe(primary);
      expect(m.merged.level).toBe('P0');
      expect(m.merged.needsHumanReview).toBe(true);
      expect(m.merged.reasonCodes).toContain('runs_disagree');
    }
  });

  it('任何一次要覆核 → 合併後都要覆核', () => {
    const a = triage(obs({ consciousness: 'appears_dead' }), 'P2');
    const b = triage(obs({ mobility: 'limping' }), 'P2');
    expect(mergeTriage(a, b).merged.needsHumanReview).toBe(true);
  });
});

describe('規則表', () => {
  it('原因代碼冇重複', () => {
    const codes = allReasonCodes();
    expect(new Set(codes).size).toBe(codes.length);
  });
});
