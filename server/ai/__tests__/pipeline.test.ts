// runAnalysis：送去 Gemini 嘅 request、Zod 驗證、triage、兩次分析（假 Gemini，唔讀寫 Firestore）
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import { GEMINI_MODEL } from '../config';
import { runAnalysis, type RunAnalysisInput } from '../pipeline';
import { ANALYZE_RESPONSE_JSON_SCHEMA } from '../prompts/analyze.v3';
import { VALID_RAW } from './fixtures';

// runAnalysis 唔讀寫 Firestore；firebase-admin/auth 喺 Node 20.12 會因為 require ESM 套件（jose）載入失敗
vi.mock('../../firebaseAdmin', () => ({
  getAdminDb: () => {
    throw new Error('測試唔應該連 Firestore');
  },
  getAdminBucket: () => null,
}));

const images = [
  { pos: 0, data: 'AAAA' },
  { pos: 1, data: 'BBBB' },
];
const input: RunAnalysisInput = {
  images,
  totalPhotos: 2,
  animalType: 'cat',
  description: 'Injured cat',
  reporterTags: [],
  lang: 'en',
  caseId: 'PW-T-1',
};

const reply = (o: unknown, tokens = 10) =>
  ({
    text: typeof o === 'string' ? o : JSON.stringify(o),
    candidates: [{ finishReason: 'STOP' }],
    usageMetadata: { totalTokenCount: tokens },
  }) as unknown as GenerateContentResponse;

const quiet = { sleep: async () => undefined, log: () => undefined };
const HEALTHY = {
  ...VALID_RAW,
  mobility: 'normal',
  bleeding: 'none',
  wounds: 'none',
  woundTypes: [],
  traumaVehicle: 'no',
  evidence: [],
  suggestedUrgency: 'P2',
  sensitivePhotoNumbers: [],
};

describe('runAnalysis', () => {
  it('送出：全部相先、文字指示最後；用 Zod 產生嘅 responseJsonSchema', async () => {
    let sent: GenerateContentParameters | undefined;
    const r = await runAnalysis(input, {
      observeTwice: false,
      retry: {
        ...quiet,
        call: async (p) => {
          sent = p;
          return reply(VALID_RAW);
        },
      },
    });
    expect(r.ok).toBe(true);
    expect(sent!.model).toBe(GEMINI_MODEL);
    expect(sent!.config?.responseJsonSchema).toBe(ANALYZE_RESPONSE_JSON_SCHEMA);
    expect(sent!.config?.responseSchema).toBeUndefined();
    const parts = (sent!.contents as { parts: Record<string, any>[] }).parts;
    expect(parts.map((p) => (p.inlineData ? 'img' : 'text'))).toEqual(['img', 'img', 'text']);
  });

  it('成功：等級由 triage 決定（AI 建議 P2 都會因為傷勢變 P1）', async () => {
    const r = await runAnalysis(input, {
      observeTwice: false,
      retry: { ...quiet, call: async () => reply({ ...VALID_RAW, suggestedUrgency: 'P2' }) },
    });
    if (r.ok !== true) throw new Error('應該成功');
    expect(r.analysis.urgencyLevel).toBe('P1');
    expect(r.analysis.schemaVersion).toBe(5);
    expect(r.analysis.matching).toMatchObject({ speciesMismatch: false, species: ['cat'], requiredCapabilities: [] });
    expect(r.analysis.advice?.firstAid).toContain('keep_distance');
    expect(r.analysis.aiNote).toBe('The cat is under a parked car.');
    expect(r.analysis.triage?.modelSuggestion).toBe('P2');
    expect(r.consensus).toBeNull();
  });

  it('報案人標籤傳入 triage', async () => {
    const r = await runAnalysis(
      { ...input, reporterTags: ['trapped'] },
      { observeTwice: false, retry: { ...quiet, call: async () => reply(HEALTHY) } }
    );
    if (r.ok !== true) throw new Error('應該成功');
    expect(r.analysis.urgencyLevel).toBe('P1');
    expect(r.analysis.triage?.reasonCodes).toContain('reporter_tag_trapped');
  });

  it('Zod 驗證失敗：schema 錯誤，保留原始回應', async () => {
    const r = await runAnalysis(input, {
      observeTwice: false,
      retry: { ...quiet, call: async () => reply({ ...VALID_RAW, bleeding: 'lots' }) },
    });
    if (r.ok !== false) throw new Error('應該失敗');
    expect(r.error.kind).toBe('schema');
    expect(r.error.retryable).toBe(true);
    expect(r.call?.text).toContain('"lots"');
  });

  it('Gemini 400：唔可以再試', async () => {
    const r = await runAnalysis(input, {
      observeTwice: false,
      retry: {
        ...quiet,
        call: async () => {
          throw new ApiError({ message: 'bad request', status: 400 });
        },
      },
    });
    if (r.ok !== false) throw new Error('應該失敗');
    expect(r.error.kind).toBe('client');
    expect(r.error.retryable).toBe(false);
  });
});

describe('runAnalysis：兩次分析（observeTwice）', () => {
  function sequence(...replies: GenerateContentResponse[]) {
    let i = 0;
    return async () => replies[Math.min(i++, replies.length - 1)];
  }

  it('一致 → 唔使覆核；token 加埋', async () => {
    const r = await runAnalysis(input, {
      observeTwice: true,
      retry: { ...quiet, call: sequence(reply(HEALTHY, 10), reply(HEALTHY, 15)) },
    });
    if (r.ok !== true) throw new Error('應該成功');
    expect(r.consensus).toEqual({ runs: 2, succeeded: 2, levels: ['P2', 'P2'], agreed: true });
    expect(r.analysis.triage?.needsHumanReview).toBe(false);
    expect(r.calls).toHaveLength(2);
  });

  it('唔一致 → 用較高等級 + 覆核；敏感相片取兩次嘅聯集', async () => {
    const heavy = {
      ...HEALTHY,
      bleeding: 'heavy',
      evidence: [{ finding: 'bleeding', photo: 1 }],
      sensitivePhotoNumbers: [1],
    };
    const r = await runAnalysis(input, {
      observeTwice: true,
      retry: { ...quiet, call: sequence(reply({ ...HEALTHY, sensitivePhotoNumbers: [2] }), reply(heavy)) },
    });
    if (r.ok !== true) throw new Error('應該成功');
    expect(r.analysis.urgencyLevel).toBe('P0');
    expect(r.analysis.findings?.bleeding).toBe('heavy');
    expect(r.analysis.triage?.needsHumanReview).toBe(true);
    expect(r.analysis.triage?.reasonCodes).toContain('runs_disagree');
    expect(r.analysis.sensitivePhotos).toEqual([0, 1]);
    expect(r.consensus?.agreed).toBe(false);
  });

  it('一次失敗 → 用另一次嘅結果', async () => {
    const r = await runAnalysis(input, {
      observeTwice: true,
      retry: { ...quiet, call: sequence(reply('not json'), reply(HEALTHY)) },
    });
    if (r.ok !== true) throw new Error('應該成功');
    expect(r.consensus).toMatchObject({ runs: 2, succeeded: 1, agreed: null });
  });
});
