// NGO 對 AI 結果嘅回饋：輸入驗證同預測快照
import { describe, expect, it } from 'vitest';
import { FEEDBACK_NOTE_MAX, parseFeedback, predictionSnapshot } from '../aiFeedback';

const valid = { actualSpecies: 'cat', actualUrgency: 'P0', adviceUseful: 'partly', note: 'AI missed the fracture' };

describe('parseFeedback', () => {
  it('有效', () => {
    expect(parseFeedback(valid)).toEqual(valid);
    expect(parseFeedback({ ...valid, note: undefined })).toEqual({ ...valid, note: '' });
  });

  it.each([
    [null],
    ['text'],
    [{ ...valid, actualSpecies: 'lion' }],
    [{ ...valid, actualUrgency: 'P3' }],
    [{ ...valid, adviceUseful: 'maybe' }],
    [{ ...valid, note: 42 }],
    [{ actualSpecies: 'cat', actualUrgency: 'P1' }],
  ])('無效：%j', (body) => {
    expect(parseFeedback(body)).toBeNull();
  });

  it('備註截短、刪控制字元但保留換行', () => {
    const r = parseFeedback({ ...valid, note: `a\u0000b\nc${'x'.repeat(1000)}` })!;
    expect(r.note.startsWith('ab\nc')).toBe(true);
    expect(r.note.length).toBe(FEEDBACK_NOTE_MAX);
  });

  it('多出嚟嘅欄位唔會寫入', () => {
    expect(Object.keys(parseFeedback({ ...valid, role: 'admin', prediction: {} })!).sort()).toEqual(
      ['actualSpecies', 'actualUrgency', 'adviceUseful', 'note'].sort()
    );
  });
});

describe('predictionSnapshot', () => {
  it('第 3 版以上：用 gate 物種同 triage', () => {
    const s = predictionSnapshot(
      {
        urgency: 'P1',
        aiAnalysis: {
          schemaVersion: 5,
          gate: { speciesCategory: 'dog' },
          triage: { needsHumanReview: true, rulesVersion: 'triage.v1' },
          analyzedAt: '2026-11-19T00:00:00Z',
        },
      },
      { promptVersion: 'analyze.v3', model: 'gemini-x' }
    );
    expect(s).toEqual({
      urgency: 'P1', species: 'dog', needsHumanReview: true, schemaVersion: 5,
      rulesVersion: 'triage.v1', promptVersion: 'analyze.v3', model: 'gemini-x', analyzedAt: '2026-11-19T00:00:00Z',
    });
  });

  it('舊格式：用 AI 寫嘅物種文字，schemaVersion 當 1', () => {
    const s = predictionSnapshot({ urgency: 'P0', geminiResponse: { identifiedSpecies: 'Cat' } }, undefined);
    expect(s).toMatchObject({ urgency: 'P0', species: 'Cat', schemaVersion: 1, promptVersion: null });
  });

  it('冇 AI 結果：記低預設 P1，其他係 null', () => {
    expect(predictionSnapshot({ urgency: 'P1' }, undefined)).toEqual({
      urgency: 'P1', species: null, needsHumanReview: null, schemaVersion: null,
      rulesVersion: null, promptVersion: null, model: null, analyzedAt: null,
    });
  });
});
