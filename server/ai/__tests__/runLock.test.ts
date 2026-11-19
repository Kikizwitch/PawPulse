// 分析鎖嘅決定（純函數）：每一個分支都要測
import { describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { caseFacts, checkCaseEligible, decideClaim, lockId, type CaseFacts } from '../runLock';

// 唔使連 Firebase；而且 firebase-admin/auth 喺 Node 20.12 會因為 require ESM 套件（jose）載入失敗
vi.mock('../../firebaseAdmin', () => ({
  getAdminDb: () => {
    throw new Error('測試唔應該連 Firestore');
  },
  getAdminBucket: () => null,
}));

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const freshCase: CaseFacts = { createdAtMs: NOW - 2 * MIN, editedAtMs: null, editCount: 0, hasAnalysis: false };
const editedCase: CaseFacts = {
  createdAtMs: NOW - 3 * 60 * MIN, // 3 個鐘頭前建立
  editedAtMs: NOW - 2 * MIN,       // 2 分鐘前修改
  editCount: 1,
  hasAnalysis: false,
};

describe('decideClaim：鎖', () => {
  it('未有鎖 → 第 1 次，扣每日額度', () => {
    expect(decideClaim(undefined, freshCase, 'create', NOW)).toEqual({ ok: true, runNumber: 1, firstRun: true });
  });

  it('舊 claimOnce 文件（只有 createdAt）→ 當已完成', () => {
    expect(decideClaim({}, freshCase, 'create', NOW)).toEqual({ ok: false, reason: 'done' });
  });

  it('state 唔認得 → 當已完成（fail-closed）', () => {
    expect(decideClaim({ state: 'weird', runs: 0 }, freshCase, 'create', NOW)).toEqual({ ok: false, reason: 'done' });
  });

  it('done → 唔再分析', () => {
    expect(decideClaim({ state: 'done', runs: 1 }, freshCase, 'create', NOW)).toEqual({ ok: false, reason: 'done' });
  });

  it('running 而且租期未過 → 另一次分析進行緊', () => {
    const lock = { state: 'running', runs: 1, leaseUntil: NOW + 1 };
    expect(decideClaim(lock, freshCase, 'create', NOW)).toEqual({ ok: false, reason: 'in_progress' });
  });

  it('running 但租期過咗（instance 死咗）→ 可以再試，唔再扣額度', () => {
    const lock = { state: 'running', runs: 1, leaseUntil: NOW - 1 };
    expect(decideClaim(lock, freshCase, 'create', NOW)).toEqual({ ok: true, runNumber: 2, firstRun: false });
  });

  it('released → 可以再試', () => {
    expect(decideClaim({ state: 'released', runs: 2, leaseUntil: 0 }, freshCase, 'create', NOW)).toEqual({
      ok: true,
      runNumber: 3,
      firstRun: false,
    });
  });

  it('試夠 3 次 → 唔再分析', () => {
    expect(decideClaim({ state: 'released', runs: 3 }, freshCase, 'create', NOW)).toEqual({ ok: false, reason: 'max_runs' });
  });

  it('runs 唔係正整數 → 當已用晒次數（fail-closed）', () => {
    for (const runs of ['1', -1, 1.5, null, undefined]) {
      expect(decideClaim({ state: 'released', runs }, freshCase, 'create', NOW)).toEqual({ ok: false, reason: 'max_runs' });
    }
  });
});

describe('decideClaim / checkCaseEligible：案件', () => {
  it('已經有分析結果 → 唔再分析（就算冇鎖）', () => {
    expect(decideClaim(undefined, { ...freshCase, hasAnalysis: true }, 'create', NOW)).toEqual({
      ok: false,
      reason: 'already_analyzed',
    });
  });

  it('建立觸發：超過 15 分鐘 → outside_window', () => {
    expect(checkCaseEligible({ ...freshCase, createdAtMs: NOW - 16 * MIN }, 'create', NOW)).toBe('outside_window');
    expect(checkCaseEligible({ ...freshCase, createdAtMs: NOW - 15 * MIN }, 'create', NOW)).toBe('outside_window');
    expect(checkCaseEligible({ ...freshCase, createdAtMs: NOW - 15 * MIN + 1 }, 'create', NOW)).toBeNull();
  });

  it('建立觸發：冇建立時間 → outside_window', () => {
    expect(checkCaseEligible({ ...freshCase, createdAtMs: null }, 'create', NOW)).toBe('outside_window');
  });

  it('修改觸發：未改過 → not_edited', () => {
    expect(checkCaseEligible({ ...editedCase, editCount: 0 }, 'edit', NOW)).toBe('not_edited');
  });

  it('修改觸發：時限由修改時間起計（建立咗 3 個鐘都得）', () => {
    expect(decideClaim(undefined, editedCase, 'edit', NOW)).toEqual({ ok: true, runNumber: 1, firstRun: true });
  });

  it('修改觸發：修改咗超過 15 分鐘 → outside_window', () => {
    expect(checkCaseEligible({ ...editedCase, editedAtMs: NOW - 16 * MIN }, 'edit', NOW)).toBe('outside_window');
    expect(checkCaseEligible({ ...editedCase, editedAtMs: null }, 'edit', NOW)).toBe('outside_window');
  });

  it('建立觸發唔可以用修改時間延長時限', () => {
    expect(checkCaseEligible(editedCase, 'create', NOW)).toBe('outside_window');
  });
});

describe('lockId / caseFacts', () => {
  it('建立同修改用唔同嘅鎖', () => {
    expect(lockId('create', 'PW-A-1')).toBe('analyze_PW-A-1');
    expect(lockId('edit', 'PW-A-1')).toBe('analyzeEdit_PW-A-1');
  });

  it('由 Firestore 文件抽資料', () => {
    const facts = caseFacts({
      createdAt: Timestamp.fromMillis(NOW),
      editedAt: new Date(NOW + MIN).toISOString(),
      editCount: 1,
      aiAnalysis: { urgencyLevel: 'P1' },
    });
    expect(facts).toEqual({ createdAtMs: NOW, editedAtMs: NOW + MIN, editCount: 1, hasAnalysis: true });
  });

  it('欄位唔啱型別就當冇', () => {
    const facts = caseFacts({ createdAt: '2026-01-01', editedAt: 'not a date', editCount: 'x', aiAnalysis: null });
    expect(facts).toEqual({ createdAtMs: null, editedAtMs: null, editCount: 0, hasAnalysis: false });
    expect(caseFacts(undefined)).toEqual({ createdAtMs: null, editedAtMs: null, editCount: 0, hasAnalysis: false });
  });
});
