// Cloud Tasks：排隊 request 嘅內容、防重複、handler 嘅身份核對、payload 驗證（唔會真係連 Google）
import { beforeEach, describe, expect, it, vi } from 'vitest';

// config 喺 import 時讀環境變數，要喺 import 之前設定
const env = vi.hoisted(() => {
  const e = {
    AI_TASKS_QUEUE: 'projects/pawpulse-test/locations/asia-northeast1/queues/ai-analyze',
    AI_TASKS_SERVICE_ACCOUNT: 'tasks-invoker@pawpulse-test.iam.gserviceaccount.com',
    AI_TASKS_HANDLER_URL: 'https://pawpulse-test.a.run.app/api/internal/tasks/analyze',
  };
  Object.assign(process.env, e);
  return e;
});

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  verifyIdToken: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getClient() {
      return { request: mocks.request };
    }
  },
  OAuth2Client: class {
    verifyIdToken = mocks.verifyIdToken;
  },
}));

import { TASKS_ENABLED, TASK_DISPATCH_DEADLINE_S } from '../config';
import {
  enqueueAnalyzeTask,
  isTrustedTaskClaims,
  parseTaskPayload,
  taskId,
  verifyTaskRequest,
} from '../tasks';

const payload = { caseId: 'PW-ABC123-XY9Z', trigger: 'create' as const, lang: 'zh-HK' };

beforeEach(() => {
  mocks.request.mockReset();
  mocks.verifyIdToken.mockReset();
});

describe('設定', () => {
  it('三個環境變數都有 → 用 Cloud Tasks', () => {
    expect(TASKS_ENABLED).toBe(true);
  });

  it('dispatch 時限長過一次分析', () => {
    expect(TASK_DISPATCH_DEADLINE_S).toBeGreaterThan(75 + 30);
    expect(TASK_DISPATCH_DEADLINE_S).toBeLessThanOrEqual(1800); // Cloud Tasks 上限 30 分鐘
  });
});

describe('enqueueAnalyzeTask', () => {
  it('送出：task 名防重複、OIDC token、audience = handler、body 係 base64 JSON', async () => {
    mocks.request.mockResolvedValue({ data: {} });
    await expect(enqueueAnalyzeTask(payload, 0)).resolves.toBe('queued');

    const req = mocks.request.mock.calls[0][0];
    expect(req.url).toBe(`https://cloudtasks.googleapis.com/v2/${env.AI_TASKS_QUEUE}/tasks`);
    expect(req.method).toBe('POST');
    const task = req.data.task;
    expect(task.name).toBe(`${env.AI_TASKS_QUEUE}/tasks/analyze-create-PW-ABC123-XY9Z-0`);
    expect(task.dispatchDeadline).toBe(`${TASK_DISPATCH_DEADLINE_S}s`);
    expect(task.httpRequest).toMatchObject({
      url: env.AI_TASKS_HANDLER_URL,
      httpMethod: 'POST',
      oidcToken: { serviceAccountEmail: env.AI_TASKS_SERVICE_ACCOUNT, audience: env.AI_TASKS_HANDLER_URL },
    });
    expect(JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString())).toEqual(payload);
  });

  it('同名 task 已存在（409）→ duplicate，唔當錯誤', async () => {
    mocks.request.mockRejectedValue(Object.assign(new Error('exists'), { response: { status: 409 } }));
    await expect(enqueueAnalyzeTask(payload, 0)).resolves.toBe('duplicate');
  });

  it('其他錯誤 → throw（route 改為直接分析）', async () => {
    mocks.request.mockRejectedValue(Object.assign(new Error('denied'), { response: { status: 403 } }));
    await expect(enqueueAnalyzeTask(payload, 0)).rejects.toThrow('denied');
  });

  it('task 名：觸發同 editCount 唔同就係唔同 task', () => {
    expect(taskId(payload, 0)).toBe('analyze-create-PW-ABC123-XY9Z-0');
    expect(taskId({ ...payload, trigger: 'edit' }, 1)).toBe('analyze-edit-PW-ABC123-XY9Z-1');
    // Cloud Tasks task ID 只可以有字母、數字、- 同 _
    expect(taskId(payload, 0)).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
  });
});

describe('parseTaskPayload', () => {
  it('有效', () => {
    expect(parseTaskPayload(payload)).toEqual(payload);
    expect(parseTaskPayload({ ...payload, extra: 'ignored' })).toEqual(payload);
  });

  it.each([
    [null],
    ['string'],
    [{ ...payload, caseId: '../../etc' }],
    [{ ...payload, caseId: 'x'.repeat(65) }],
    [{ ...payload, trigger: 'delete' }],
    [{ ...payload, lang: 'en"; drop' }],
    [{ caseId: payload.caseId, trigger: 'create' }],
  ])('無效：%j', (body) => {
    expect(parseTaskPayload(body)).toBeNull();
  });
});

describe('handler 身份核對', () => {
  const good = {
    email: env.AI_TASKS_SERVICE_ACCOUNT,
    email_verified: true,
    aud: env.AI_TASKS_HANDLER_URL,
  };

  it('isTrustedTaskClaims：email、驗證、audience 都要啱', () => {
    const check = (c: object | undefined) =>
      isTrustedTaskClaims(c as never, env.AI_TASKS_SERVICE_ACCOUNT, env.AI_TASKS_HANDLER_URL);
    expect(check(good)).toBe(true);
    expect(check({ ...good, aud: [env.AI_TASKS_HANDLER_URL] })).toBe(true);
    expect(check({ ...good, email: 'attacker@evil.example' })).toBe(false);
    expect(check({ ...good, email_verified: false })).toBe(false);
    expect(check({ ...good, aud: 'https://other.example/api' })).toBe(false);
    expect(check(undefined)).toBe(false);
    expect(isTrustedTaskClaims(good, '', env.AI_TASKS_HANDLER_URL)).toBe(false);
  });

  it('冇 Bearer token → 拒絕，唔使驗證', async () => {
    expect(await verifyTaskRequest(undefined)).toBe(false);
    expect(await verifyTaskRequest('Basic abc')).toBe(false);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it('簽名驗證失敗 → 拒絕', async () => {
    mocks.verifyIdToken.mockRejectedValue(new Error('bad signature'));
    expect(await verifyTaskRequest('Bearer forged')).toBe(false);
  });

  it('簽名有效但服務帳戶唔啱 → 拒絕', async () => {
    mocks.verifyIdToken.mockResolvedValue({ getPayload: () => ({ ...good, email: 'someone@else.iam.gserviceaccount.com' }) });
    expect(await verifyTaskRequest('Bearer token')).toBe(false);
  });

  it('全部啱 → 接受；audience 用 handler 網址', async () => {
    mocks.verifyIdToken.mockResolvedValue({ getPayload: () => good });
    expect(await verifyTaskRequest('Bearer token')).toBe(true);
    expect(mocks.verifyIdToken).toHaveBeenCalledWith({ idToken: 'token', audience: env.AI_TASKS_HANDLER_URL });
  });
});
