// generateWithRetry：時限、重試、錯誤分類、退避
// 用假時鐘同假 sleep，唔會真係等，亦唔會連 Gemini
import { describe, expect, it } from 'vitest';
import { ApiError, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import {
  AiCallError,
  backoffMs,
  classifyError,
  generateWithRetry,
  retryHintMs,
  type RetryOptions,
} from '../client';

const PARAMS: GenerateContentParameters = { model: 'test-model', contents: 'hi' };
const META = { label: 'test', caseId: 'PW-TEST-0001' };
const SECRET_TEXT = '{"identifiedSpecies":"secret-output"}';

function response(over: Record<string, unknown> = {}): GenerateContentResponse {
  return {
    text: SECRET_TEXT,
    candidates: [{ finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125 },
    modelVersion: 'test-model-001',
    ...over,
  } as unknown as GenerateContentResponse;
}

const apiError = (status: number, message = `HTTP ${status}`) => new ApiError({ message, status });

type Step = (clock: { advance: (ms: number) => void }) => Promise<GenerateContentResponse>;

// 每次 call 用 steps 入面下一個（用完就重複最後一個）
function harness(steps: Step[], opts: RetryOptions = {}) {
  let t = 0;
  let i = 0;
  const callTimes: number[] = [];
  const sleeps: number[] = [];
  const logs: Record<string, unknown>[] = [];
  const seenParams: GenerateContentParameters[] = [];
  const clock = { advance: (ms: number) => { t += ms; } };
  const run = () =>
    generateWithRetry(PARAMS, META, {
      call: async (p) => {
        seenParams.push(p);
        callTimes.push(t);
        const step = steps[Math.min(i++, steps.length - 1)];
        return step(clock);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      now: () => t,
      random: () => 0.5,
      log: (e) => logs.push(e),
      timeoutMs: 30_000,
      deadlineMs: 75_000,
      ...opts,
    });
  return { run, callTimes, sleeps, logs, seenParams };
}

const ok: Step = async () => response();
const fail = (err: unknown): Step => async () => {
  throw err;
};
const hang: Step = () => new Promise(() => undefined);

async function expectAiError(p: Promise<unknown>): Promise<AiCallError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AiCallError);
    return err as AiCallError;
  }
  throw new Error('應該要 throw');
}

describe('generateWithRetry', () => {
  it('第一次成功：回傳內容、token 用量，冇重試', async () => {
    const h = harness([ok]);
    const r = await h.run();
    expect(r.text).toBe(SECRET_TEXT);
    expect(r.attempts).toBe(1);
    expect(r.usage).toEqual({ promptTokens: 100, candidatesTokens: 20, thoughtsTokens: 5, totalTokens: 125 });
    expect(r.finishReason).toBe('STOP');
    expect(r.modelVersion).toBe('test-model-001');
    expect(h.sleeps).toEqual([]);
  });

  it('每次請求都帶 abortSignal（時間到可以取消 fetch）', async () => {
    const h = harness([ok]);
    await h.run();
    expect(h.seenParams[0].config?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it.each([429, 500, 502, 503, 504])('HTTP %i 會重試，第二次成功', async (status) => {
    const h = harness([fail(apiError(status)), ok]);
    const r = await h.run();
    expect(r.attempts).toBe(2);
    expect(h.sleeps).toHaveLength(1);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(h.sleeps[0]).toBeLessThanOrEqual(1000);
  });

  it('最多試 3 次；3 次 503 之後 throw server，可以留待之後再試', async () => {
    const h = harness([fail(apiError(503))]);
    const e = await expectAiError(h.run());
    expect(e.kind).toBe('server');
    expect(e.status).toBe(503);
    expect(e.attempts).toBe(3);
    expect(e.retryable).toBe(true);
    expect(h.callTimes).toHaveLength(3);
  });

  it.each([400, 401, 403, 404])('HTTP %i 唔會重試，亦唔可以留待之後再試', async (status) => {
    const h = harness([fail(apiError(status)), ok]);
    const e = await expectAiError(h.run());
    expect(e.kind).toBe('client');
    expect(e.attempts).toBe(1);
    expect(e.retryable).toBe(false);
    expect(h.callTimes).toHaveLength(1);
  });

  it('超時會重試；3 次都超時就 throw timeout', async () => {
    const h = harness([hang], { timeoutMs: 15 });
    const e = await expectAiError(h.run());
    expect(e.kind).toBe('timeout');
    expect(e.attempts).toBe(3);
    expect(e.retryable).toBe(true);
  });

  it('超時之後再試成功', async () => {
    const h = harness([hang, ok], { timeoutMs: 15 });
    const r = await h.run();
    expect(r.attempts).toBe(2);
  });

  it('網絡錯誤（fetch failed）會重試', async () => {
    const h = harness([fail(new TypeError('fetch failed')), ok]);
    const r = await h.run();
    expect(r.attempts).toBe(2);
  });

  it('唔認得嘅錯誤唔會重試', async () => {
    const h = harness([fail(new Error('weird')), ok]);
    const e = await expectAiError(h.run());
    expect(e.kind).toBe('unknown');
    expect(e.retryable).toBe(false);
    expect(h.callTimes).toHaveLength(1);
  });

  it('回應冇內容：唔即刻重試，但可以留待之後再試；仍然記錄 token', async () => {
    const h = harness([async () => response({ text: '' }), ok]);
    const e = await expectAiError(h.run());
    expect(e.kind).toBe('empty');
    expect(e.retryable).toBe(true);
    expect(e.attempts).toBe(1);
    expect(e.usage?.totalTokens).toBe(125);
    expect(h.callTimes).toHaveLength(1);
  });

  it('被安全過濾擋咗（promptFeedback）：唔重試', async () => {
    const h = harness([async () => response({ text: undefined, candidates: [], promptFeedback: { blockReason: 'SAFETY' } })]);
    const e = await expectAiError(h.run());
    expect(e.kind).toBe('blocked');
    expect(e.retryable).toBe(false);
  });

  it('被安全過濾擋咗（finishReason）：唔重試', async () => {
    const h = harness([async () => response({ text: '', candidates: [{ finishReason: 'IMAGE_SAFETY' }] })]);
    const e = await expectAiError(h.run());
    expect(e.kind).toBe('blocked');
  });

  it('剩低時間唔夠就唔再試', async () => {
    // 第一次請求用咗 3 秒先失敗；總時限 4 秒，等完再試會超時
    const slow503: Step = async (clock) => {
      clock.advance(3_000);
      throw apiError(503);
    };
    const h = harness([slow503, ok], { deadlineMs: 4_000 });
    const e = await expectAiError(h.run());
    expect(e.kind).toBe('server');
    expect(e.attempts).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('429 有 retryDelay：跟佢等；太長就唔等', async () => {
    const msg = '{"error":{"code":429,"details":[{"retryDelay":"30s"}]}}';
    const longEnough = harness([fail(apiError(429, msg)), ok], { deadlineMs: 75_000 });
    await longEnough.run();
    expect(longEnough.sleeps).toEqual([30_000]);

    const tooShort = harness([fail(apiError(429, msg)), ok], { deadlineMs: 20_000 });
    const e = await expectAiError(tooShort.run());
    expect(e.kind).toBe('rate_limit');
    expect(e.attempts).toBe(1);
  });

  it('每次請求一行 log，唔會記錄 AI 回應內容', async () => {
    const h = harness([fail(apiError(503)), ok]);
    await h.run();
    expect(h.logs).toHaveLength(2);
    expect(h.logs[0]).toMatchObject({ event: 'gemini_attempt', attempt: 1, ok: false, errorKind: 'server', caseId: 'PW-TEST-0001' });
    expect(h.logs[1]).toMatchObject({ attempt: 2, ok: true, totalTokens: 125 });
    expect(JSON.stringify(h.logs)).not.toContain('secret-output');
  });
});

describe('classifyError', () => {
  it.each([
    [429, 'rate_limit'],
    [408, 'timeout'],
    [500, 'server'],
    [503, 'server'],
    [400, 'client'],
    [403, 'client'],
  ])('ApiError %i → %s', (status, kind) => {
    expect(classifyError(apiError(status)).kind).toBe(kind);
  });

  it('AbortError / TimeoutError → timeout', () => {
    expect(classifyError(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind).toBe('timeout');
    expect(classifyError(Object.assign(new Error('t'), { name: 'TimeoutError' })).kind).toBe('timeout');
  });

  it('連線錯誤 → network', () => {
    const err = Object.assign(new TypeError('request failed'), { cause: { code: 'ECONNRESET' } });
    expect(classifyError(err).kind).toBe('network');
  });

  it('其他 → unknown', () => {
    expect(classifyError(new Error('x')).kind).toBe('unknown');
    expect(classifyError('string error').kind).toBe('unknown');
  });
});

describe('backoffMs / retryHintMs', () => {
  it('每次重試上限加倍，最多 8 秒，喺上限一半至全數之間', () => {
    expect(backoffMs(1, () => 0)).toBe(500);
    expect(backoffMs(1, () => 1)).toBe(1000);
    expect(backoffMs(2, () => 0)).toBe(1000);
    expect(backoffMs(2, () => 1)).toBe(2000);
    expect(backoffMs(10, () => 0)).toBe(4000);
    expect(backoffMs(10, () => 1)).toBe(8000);
  });

  it('讀 retryDelay', () => {
    expect(retryHintMs(new Error('"retryDelay": "12.5s"'))).toBe(12_500);
    expect(retryHintMs(new Error('no hint'))).toBeNull();
  });
});
