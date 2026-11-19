// NGO 配對排名（純函數）
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NGO_CAPABILITIES } from '../../src/config/ngoCapabilities';
import type { AIMatching } from '../../src/types';
import { SCORE, distanceKm, rankNgos, scoreNgo, toMatchNgo, type MatchContext, type MatchNgo } from '../matching';

// 旺角
const HERE = { lat: 22.3193, lng: 114.1694 };
// 大約 18 公里外：分數唔會碰到 10–99 嘅上下限，加減分差距睇得清楚
const MID = { lat: 22.4813, lng: 114.1694 };

const matching = (over: Partial<AIMatching> = {}): AIMatching => ({
  requiredCapabilities: [],
  speciesMismatch: false,
  species: ['cat'],
  rulesVersion: 'test',
  ...over,
});

const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({ ...HERE, level: 'P1', matching: matching(), ...over });

const ngo = (over: Partial<MatchNgo> = {}): MatchNgo => ({
  id: 'ngo_a',
  ...HERE,
  acceptedAnimals: ['cat', 'dog'],
  hasEmergencyRescue: false,
  capacityStatus: 'available',
  capabilities: [],
  ...over,
});

describe('distanceKm', () => {
  it('同一點 = 0；旺角去沙田大約 7.7 公里', () => {
    expect(distanceKm(HERE.lat, HERE.lng, HERE.lat, HERE.lng)).toBe(0);
    expect(distanceKm(HERE.lat, HERE.lng, 22.3857, 114.1915)).toBeCloseTo(7.7, 0);
  });
});

describe('toMatchNgo（Firestore 資料唔信）', () => {
  it('座標唔啱 → 唔參與配對', () => {
    expect(toMatchNgo('x', { lat: 'abc', lng: 114 })).toBeNull();
    expect(toMatchNgo('x', { lat: 95, lng: 114 })).toBeNull();
    expect(toMatchNgo('x', undefined)).toBeNull();
  });

  it('清洗欄位；冇 capabilities 欄位 = 未標記（null）', () => {
    const n = toMatchNgo('x', {
      lat: 22.3, lng: 114.1,
      acceptedAnimals: ['cat', 3],
      hasEmergencyRescue: 'yes',
      capacityStatus: 'weird',
    })!;
    expect(n).toEqual({
      id: 'x', lat: 22.3, lng: 114.1, acceptedAnimals: ['cat'],
      hasEmergencyRescue: false, capacityStatus: 'available', capabilities: null,
    });
    expect(toMatchNgo('x', { lat: 1, lng: 1, capabilities: ['surgery', 'bird_rehab', 'surgery'] })!.capabilities).toEqual(['surgery']);
  });
});

describe('scoreNgo', () => {
  it('同一位置、接收物種、冇其他因素 → base + 物種分（上限 99）', () => {
    expect(scoreNgo(ngo(), ctx()).matchScore).toBe(Math.min(SCORE.max, SCORE.base + SCORE.acceptsSpecies));
  });

  it('距離越遠分越低；車程最少 5 分鐘', () => {
    const near = scoreNgo(ngo({ lat: 22.33, lng: 114.17 }), ctx());
    const far = scoreNgo(ngo({ lat: 22.45, lng: 114.03 }), ctx());
    expect(far.matchScore).toBeLessThan(near.matchScore);
    expect(scoreNgo(ngo(), ctx()).driveTimeMins).toBe(5);
  });

  it('唔接收物種 → 扣分', () => {
    const r = scoreNgo(ngo({ acceptedAnimals: ['dog'], lat: 22.4 }), ctx());
    expect(r.reasons).toContain('species_not_accepted');
    expect(r.matchScore).toBeLessThan(scoreNgo(ngo({ lat: 22.4 }), ctx()).matchScore);
  });

  it('物種唔一致：接收其中一種就算接收', () => {
    const m = ctx({ matching: matching({ speciesMismatch: true, species: ['cat', 'dog'] }) });
    expect(scoreNgo(ngo({ acceptedAnimals: ['dog'] }), m).reasons).toContain('accepts_species');
    expect(scoreNgo(ngo({ acceptedAnimals: ['bird'] }), m).reasons).toContain('species_not_accepted');
  });

  it('P0：有 24 小時緊急救援加分，冇就扣分；P1 唔計', () => {
    const far = MID;
    const yes = scoreNgo(ngo({ ...far, hasEmergencyRescue: true }), ctx({ level: 'P0' }));
    const no = scoreNgo(ngo({ ...far }), ctx({ level: 'P0' }));
    expect(yes.matchScore - no.matchScore).toBe(SCORE.p0Emergency - SCORE.p0NoEmergency);
    expect(scoreNgo(ngo({ ...far }), ctx()).reasons).not.toContain('no_emergency_rescue');
  });

  it('能力：有就加分，冇就扣分', () => {
    const far = MID;
    const need = ctx({ matching: matching({ requiredCapabilities: ['surgery', 'transport'] }) });
    const both = scoreNgo(ngo({ ...far, capabilities: ['surgery', 'transport'] }), need);
    const one = scoreNgo(ngo({ ...far, capabilities: ['surgery'] }), need);
    expect(both.matchedCapabilities).toEqual(['surgery', 'transport']);
    expect(one.missingCapabilities).toEqual(['transport']);
    expect(both.matchScore - one.matchScore).toBe(SCORE.capabilityMatch - SCORE.capabilityMissing);
  });

  it('未標記能力嘅機構：唔加分亦唔扣分', () => {
    const far = MID;
    const need = ctx({ matching: matching({ requiredCapabilities: ['surgery'] }) });
    const untagged = scoreNgo(ngo({ ...far, capabilities: null }), need);
    const noNeed = scoreNgo(ngo({ ...far, capabilities: null }), ctx());
    expect(untagged.matchScore).toBe(noNeed.matchScore);
    expect(untagged.missingCapabilities).toEqual([]);
    expect(untagged.reasons).toContain('capabilities_untagged');
  });

  it('容量：忙扣少啲，滿額扣多啲', () => {
    const far = MID;
    const a = scoreNgo(ngo({ ...far }), ctx()).matchScore;
    expect(a - scoreNgo(ngo({ ...far, capacityStatus: 'busy' }), ctx()).matchScore).toBe(-SCORE.busy);
    expect(a - scoreNgo(ngo({ ...far, capacityStatus: 'full' }), ctx()).matchScore).toBe(-SCORE.full);
  });

  it('分數限制喺 10–99', () => {
    const terrible = scoreNgo(ngo({ lat: 23.5, lng: 113, acceptedAnimals: [], capacityStatus: 'full' }), ctx({ level: 'P0' }));
    expect(terrible.matchScore).toBe(SCORE.min);
  });
});

describe('rankNgos', () => {
  it('高分排先；只回傳上限數目', () => {
    const list = [
      ngo({ id: 'far', lat: 22.45, lng: 114.03 }),
      ngo({ id: 'near', lat: 22.33, lng: 114.17 }),
      ngo({ id: 'full', capacityStatus: 'full' }),
      ngo({ id: 'mid', lat: 22.38, lng: 114.19 }),
    ];
    const r = rankNgos(list, ctx(), 3);
    expect(r).toHaveLength(3);
    expect(r[0].ngoId).toBe('near');
  });

  it('同分 → 近嘅排先，再同就按 ID（結果穩定）', () => {
    const r = rankNgos([ngo({ id: 'b' }), ngo({ id: 'a' })], ctx(), 3);
    expect(r.map((x) => x.ngoId)).toEqual(['a', 'b']);
  });

  it('冇機構 → 空', () => {
    expect(rankNgos([], ctx())).toEqual([]);
  });

  it('P0 + 需要能力：有齊能力同緊急救援嘅機構排先，就算遠少少', () => {
    const need = ctx({ level: 'P0', matching: matching({ requiredCapabilities: ['emergency_vet', 'transport'] }) });
    const r = rankNgos(
      [
        ngo({ id: 'close_basic', lat: 22.325, lng: 114.17 }),
        ngo({ id: 'equipped', lat: 22.34, lng: 114.18, hasEmergencyRescue: true, capabilities: ['emergency_vet', 'transport'] }),
      ],
      need
    );
    expect(r[0].ngoId).toBe('equipped');
  });
});

describe('同 firestore.rules 一致', () => {
  it('rules 嘅能力清單 = NGO_CAPABILITIES', () => {
    const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
    const m = /data\.capabilities\.hasOnly\(\[([^\]]+)\]\)/.exec(rules);
    expect(m).not.toBeNull();
    const list = m![1].match(/'([a-z_]+)'/g)!.map((s) => s.slice(1, -1));
    expect(list).toEqual([...NGO_CAPABILITIES]);
    expect(rules).toContain(`data.capabilities.size() <= ${NGO_CAPABILITIES.length}`);
  });
});
