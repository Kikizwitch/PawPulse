// 評估指標同 manifest 驗證
import { describe, expect, it } from 'vitest';
import path from 'path';
import { readFileSync } from 'fs';
import { computeMetrics, percentile, renderMarkdown, type EvalRecord } from '../metrics';
import { parseManifest, resolvePhotoPath } from '../manifest';

const rec = (over: Partial<EvalRecord> = {}): EvalRecord => ({
  caseId: 'c1',
  category: null,
  run: 1,
  expected: {},
  ok: true,
  errorKind: null,
  level: 'P1',
  species: 'cat',
  animalVisible: true,
  imageUsable: true,
  needsHumanReview: false,
  latencyMs: 1000,
  tokens: { prompt: 100, output: 20, total: 120 },
  ...over,
});

describe('percentile', () => {
  it('最近排名法', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([3, 1, 2], 50)).toBe(2);
  });
});

describe('computeMetrics：緊急程度', () => {
  const records = [
    rec({ caseId: 'a', expected: { urgency: 'P0' }, level: 'P0' }),
    rec({ caseId: 'b', expected: { urgency: 'P0' }, level: 'P1' }), // 漏判
    rec({ caseId: 'c', expected: { urgency: 'P0' }, ok: false, errorKind: 'timeout', level: 'P1' }), // 失敗 → P1 → 漏判
    rec({ caseId: 'd', expected: { urgency: 'P2' }, level: 'P1' }), // 判高咗
    rec({ caseId: 'e', expected: { urgency: 'P1' }, level: 'P2' }), // 判低咗
    rec({ caseId: 'f', expected: {}, level: 'P2' }), // 冇答案，唔計
  ];
  const m = computeMetrics(records);

  it('P0 漏判（主要指標）：失敗都算漏判', () => {
    expect(m.p0).toEqual({ total: 3, underTriaged: 2, rate: 2 / 3, caseIds: ['b', 'c'] });
  });

  it('confusion matrix', () => {
    expect(m.urgency.confusion.P0).toEqual({ P0: 1, P1: 2, P2: 0 });
    expect(m.urgency.confusion.P2).toEqual({ P0: 0, P1: 1, P2: 0 });
    expect(m.urgency.confusion.P1).toEqual({ P0: 0, P1: 0, P2: 1 });
  });

  it('準確度、判低、判高（只計有答案嘅）', () => {
    expect(m.urgency.scored).toBe(5);
    expect(m.urgency.accuracy).toBe(1 / 5);
    expect(m.urgency.underTriageRate).toBe(3 / 5);
    expect(m.urgency.overTriageRate).toBe(1 / 5);
  });

  it('錯誤統計', () => {
    expect(m.errors).toEqual({ timeout: 1 });
    expect(m.okRate).toBe(5 / 6);
    expect(m.schemaFailureRate).toBe(0);
  });
});

describe('computeMetrics：物種、Gate、其他', () => {
  it('物種同 Gate 只計成功嘅分析', () => {
    const m = computeMetrics([
      rec({ expected: { species: 'cat' }, species: 'cat' }),
      rec({ expected: { species: 'cat' }, species: 'unknown' }),
      rec({ expected: { species: 'dog' }, species: 'cat' }),
      rec({ expected: { species: 'cat' }, ok: false, errorKind: 'schema', species: null }),
      rec({ expected: { animalVisible: false }, animalVisible: false }),
      rec({ expected: { imageUsable: false }, imageUsable: true }),
    ]);
    expect(m.species).toEqual({ scored: 3, accuracy: 1 / 3, unknownRate: 1 / 3 });
    expect(m.gate.animalVisible).toEqual({ scored: 1, accuracy: 1 });
    expect(m.gate.imageUsable).toEqual({ scored: 1, accuracy: 0 });
    expect(m.schemaFailureRate).toBe(1 / 6);
  });

  it('延遲、token、成本', () => {
    const m = computeMetrics(
      [rec({ latencyMs: 1000 }), rec({ latencyMs: 3000, tokens: { prompt: 900, output: 80, total: 980 } })],
      { inputPerM: 1, outputPerM: 4 }
    );
    expect(m.latency).toEqual({ p50: 1000, p95: 3000, max: 3000 });
    expect(m.tokens).toEqual({ prompt: 1000, output: 100, total: 1100, meanPerRun: 550 });
    expect(m.costUsd!.total).toBeCloseTo((1000 * 1 + 100 * 4) / 1e6);
  });

  it('冇價錢 → 冇成本', () => {
    expect(computeMetrics([rec()]).costUsd).toBeNull();
  });

  it('重複分析嘅一致性', () => {
    const m = computeMetrics([
      rec({ caseId: 'x', run: 1, level: 'P1' }),
      rec({ caseId: 'x', run: 2, level: 'P1' }),
      rec({ caseId: 'y', run: 1, level: 'P0' }),
      rec({ caseId: 'y', run: 2, level: 'P1' }),
    ]);
    expect(m.cases).toBe(2);
    expect(m.consistency).toEqual({ casesWithRepeats: 2, rate: 0.5 });
    expect(computeMetrics([rec()]).consistency).toBeNull();
  });

  it('按分類統計', () => {
    const m = computeMetrics([
      rec({ category: 'injection', expected: { urgency: 'P1' }, level: 'P1' }),
      rec({ category: 'injection', expected: { urgency: 'P0' }, level: 'P1' }),
      rec({ category: null, ok: false, errorKind: 'server' }),
    ]);
    expect(m.byCategory).toEqual([
      { category: '(none)', runs: 1, accuracy: null, p0UnderTriaged: 0, errors: 1 },
      { category: 'injection', runs: 2, accuracy: 0.5, p0UnderTriaged: 1, errors: 0 },
    ]);
  });

  it('冇任何紀錄唔會 crash', () => {
    const m = computeMetrics([]);
    expect(m.p0.rate).toBeNull();
    expect(m.latency.p50).toBeNull();
  });
});

describe('renderMarkdown', () => {
  const meta = {
    startedAt: '2026-11-19T00:00:00Z', model: 'm', promptVersion: 'analyze.v3', schemaVersion: 5,
    rulesVersion: 'triage.v1', adviceVersion: 'advice.v1', gitCommit: 'abc123', manifestSha256: 'f'.repeat(64),
    observeTwice: false, repeat: 1,
  };

  it('有主要指標同版本資料', () => {
    const md = renderMarkdown(computeMetrics([rec({ expected: { urgency: 'P0' }, level: 'P1', caseId: 'miss' })]), meta);
    expect(md).toContain('**P0 under-triage: 100.0%**');
    expect(md).toContain('`miss`');
    expect(md).toContain('analyze.v3');
    expect(md).toContain('abc123');
  });

  it('有失敗就喺最頂警告', () => {
    const md = renderMarkdown(computeMetrics([rec({ ok: false, errorKind: 'client' }), rec()]), meta);
    expect(md).toMatch(/⚠️ 1 of 2 runs failed \(client 1\)/);
    expect(renderMarkdown(computeMetrics([rec()]), meta)).not.toContain('⚠️');
  });
});

describe('manifest', () => {
  it('範本有效', () => {
    const file = path.resolve(__dirname, '../../../../docs/ai-pipeline/eval-manifest.example.json');
    expect(parseManifest(JSON.parse(readFileSync(file, 'utf8'))).cases.length).toBeGreaterThan(5);
  });

  it('預設值', () => {
    const m = parseManifest({ version: 1, cases: [{ id: 'a', photos: ['x.jpg'], reportedAnimal: 'cat', expected: {} }] });
    expect(m.cases[0]).toMatchObject({ description: '', tags: [], lang: 'zh-HK' });
  });

  it.each([
    [{ version: 2, cases: [] }],
    [{ version: 1, cases: [] }],
    [{ version: 1, cases: [{ id: 'a', photos: [], reportedAnimal: 'cat', expected: {} }] }],
    [{ version: 1, cases: [{ id: 'a b', photos: ['x.jpg'], reportedAnimal: 'cat', expected: {} }] }],
    [{ version: 1, cases: [{ id: 'a', photos: ['x.jpg'], reportedAnimal: 'lion', expected: {} }] }],
    [{ version: 1, cases: [{ id: 'a', photos: ['x.jpg'], reportedAnimal: 'cat', expected: { urgency: 'P3' } }] }],
    [{ version: 1, cases: [1, 2, 3, 4, 5, 6].map(() => ({ id: 'dup', photos: ['x.jpg'], reportedAnimal: 'cat', expected: {} })) }],
  ])('無效 manifest → throw', (m) => {
    expect(() => parseManifest(m)).toThrow(/manifest/);
  });

  it('相片路徑唔可以走出資料集資料夾', () => {
    const root = path.resolve('/data/eval');
    expect(resolvePhotoPath(root, 'photos/a.jpg')).toBe(path.join(root, 'photos/a.jpg'));
    expect(() => resolvePhotoPath(root, '../secret.jpg')).toThrow();
    expect(() => resolvePhotoPath(root, '/etc/passwd')).toThrow();
    expect(() => resolvePhotoPath(root, 'photos/../../evalx/a.jpg')).toThrow();
  });
});
