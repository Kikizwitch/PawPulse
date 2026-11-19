// aiStatus 轉換同每日額度（純函數）
import { describe, expect, it, vi } from 'vitest';
import { aiStatusAfter, type AnalyzeOutcome } from '../pipeline';
import { decideQuota, quotaDocId } from '../quota';

// 唔使連 Firebase；而且 firebase-admin/auth 喺 Node 20.12 會因為 require ESM 套件（jose）載入失敗
vi.mock('../../firebaseAdmin', () => ({
  getAdminDb: () => {
    throw new Error('測試唔應該連 Firestore');
  },
  getAdminBucket: () => null,
}));

const done = { status: 'done', analysis: {} as never, urgency: 'P1' } as AnalyzeOutcome;
const failed = (retryable: boolean) => ({ status: 'failed', retryable, errorKind: 'server' }) as AnalyzeOutcome;
const skip = (reason: string) => ({ status: 'skipped', reason }) as AnalyzeOutcome;

describe('aiStatusAfter', () => {
  it('成功 → done', () => {
    expect(aiStatusAfter(done, true)).toBe('done');
    expect(aiStatusAfter(done, false)).toBe('done');
  });

  it('暫時性失敗：Cloud Tasks 會重試 → queued；直接分析唔會重試 → failed', () => {
    expect(aiStatusAfter(failed(true), true)).toBe('queued');
    expect(aiStatusAfter(failed(true), false)).toBe('failed');
  });

  it('永久失敗 → failed', () => {
    expect(aiStatusAfter(failed(false), true)).toBe('failed');
  });

  it.each(['no_api_key', 'daily_quota', 'no_photos', 'storage_not_configured'])('%s → skipped', (r) => {
    expect(aiStatusAfter(skip(r), true)).toBe('skipped');
  });

  it.each(['outside_window', 'max_runs'])('%s → failed（重試都唔得）', (r) => {
    expect(aiStatusAfter(skip(r), true)).toBe('failed');
  });

  it.each(['already_analyzed', 'done', 'in_progress', 'changed', 'superseded', 'not_found', 'not_edited'])(
    '%s → 唔改（由另一個流程負責，例如重複嘅 task）',
    (r) => {
      expect(aiStatusAfter(skip(r), true)).toBeNull();
    }
  );
});

describe('每日額度', () => {
  it('UTC 日期做文件 ID', () => {
    expect(quotaDocId(new Date('2026-11-17T23:59:59Z'))).toBe('2026-11-17');
    // 香港時間 11 月 18 日早上 7 點仍然係 UTC 17 日
    expect(quotaDocId(new Date('2026-11-17T23:00:00Z'))).toBe('2026-11-17');
    expect(quotaDocId(new Date('2026-11-18T00:00:00Z'))).toBe('2026-11-18');
  });

  it('未到上限 → 可以用，加一', () => {
    expect(decideQuota(0, 500)).toEqual({ allowed: true, next: 1 });
    expect(decideQuota(499, 500)).toEqual({ allowed: true, next: 500 });
  });

  it('到咗上限 → 唔可以用', () => {
    expect(decideQuota(500, 500)).toEqual({ allowed: false, next: 500 });
    expect(decideQuota(9999, 500).allowed).toBe(false);
  });

  it('冇文件或者計數壞咗 → 由 0 計', () => {
    expect(decideQuota(undefined, 500)).toEqual({ allowed: true, next: 1 });
    expect(decideQuota('7', 500)).toEqual({ allowed: true, next: 1 });
    expect(decideQuota(-3, 500)).toEqual({ allowed: true, next: 1 });
  });

  it('上限 0 → 全部唔可以用', () => {
    expect(decideQuota(0, 0).allowed).toBe(false);
  });
});
