// Cloud Tasks：AI 分析唔再喺瀏覽器等嘅 request 入面做，改為排隊，由 Cloud Tasks call 返 server 嘅 handler
// 點解唔係「先回應、背景繼續做」：Cloud Run 回應之後會限制 CPU，背景工作可能做唔完
// 用 REST API（google-auth-library），唔使額外裝 @google-cloud/tasks（gRPC）
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import {
  AI_TASKS_HANDLER_URL,
  AI_TASKS_QUEUE,
  AI_TASKS_SERVICE_ACCOUNT,
  TASK_DISPATCH_DEADLINE_S,
} from "./config";
import type { AnalyzeTrigger } from "./runLock";

const CASE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
const TRIGGERS: AnalyzeTrigger[] = ["create", "edit"];

export interface AnalyzeTaskPayload {
  caseId: string;
  trigger: AnalyzeTrigger;
  lang: string;
}

/** task body 雖然係我哋自己排嘅，都照樣驗證 */
export function parseTaskPayload(body: unknown): AnalyzeTaskPayload | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return null;
  const { caseId, trigger, lang } = b;
  if (typeof caseId !== "string" || !CASE_ID_RE.test(caseId)) return null;
  if (typeof trigger !== "string" || !TRIGGERS.includes(trigger as AnalyzeTrigger)) return null;
  if (typeof lang !== "string" || !LANG_RE.test(lang)) return null;
  return { caseId, trigger: trigger as AnalyzeTrigger, lang };
}

/**
 * Task 名用嚟防止重複排隊（例如報案人撳兩次、或者瀏覽器重試）：
 * 同一宗案件、同一種觸發、同一個 editCount 只會有一個 task
 */
export function taskId(p: AnalyzeTaskPayload, editCount: number): string {
  return `analyze-${p.trigger}-${p.caseId}-${editCount}`;
}

let auth: GoogleAuth | null = null;
const getAuth = () => (auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }));

/** 排隊；已經有同名 task 就回傳 duplicate（當已排隊） */
export async function enqueueAnalyzeTask(p: AnalyzeTaskPayload, editCount: number): Promise<"queued" | "duplicate"> {
  const client = await getAuth().getClient();
  try {
    await client.request({
      url: `https://cloudtasks.googleapis.com/v2/${AI_TASKS_QUEUE}/tasks`,
      method: "POST",
      data: {
        task: {
          name: `${AI_TASKS_QUEUE}/tasks/${taskId(p, editCount)}`,
          dispatchDeadline: `${TASK_DISPATCH_DEADLINE_S}s`,
          httpRequest: {
            url: AI_TASKS_HANDLER_URL,
            httpMethod: "POST",
            headers: { "Content-Type": "application/json" },
            body: Buffer.from(JSON.stringify(p)).toString("base64"),
            oidcToken: { serviceAccountEmail: AI_TASKS_SERVICE_ACCOUNT, audience: AI_TASKS_HANDLER_URL },
          },
        },
      },
    });
    return "queued";
  } catch (err) {
    const status = (err as { response?: { status?: number }; status?: number })?.response?.status ?? (err as any)?.status;
    if (status === 409) return "duplicate"; // ALREADY_EXISTS
    throw err;
  }
}

// ---------- handler：核對真係 Cloud Tasks call 嚟 ----------

export interface TokenClaims {
  email?: string;
  email_verified?: boolean;
  aud?: string | string[];
}

/** 純函數：OIDC token 已經過簽名驗證之後，再核對 email 同 audience */
export function isTrustedTaskClaims(claims: TokenClaims | undefined, expectedEmail: string, expectedAudience: string): boolean {
  if (!claims || !expectedEmail || !expectedAudience) return false;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return claims.email === expectedEmail && claims.email_verified === true && aud.includes(expectedAudience);
}

let oauth: OAuth2Client | null = null;

/**
 * 驗證 Authorization: Bearer <OIDC token>（Google 簽名 + audience + 服務帳戶 email）
 * 唔可以靠 X-CloudTasks-* header：外面嘅人可以自己加
 */
export async function verifyTaskRequest(authorization: string | undefined): Promise<boolean> {
  const m = /^Bearer (.+)$/.exec(authorization ?? "");
  if (!m) return false;
  try {
    oauth ??= new OAuth2Client();
    const ticket = await oauth.verifyIdToken({ idToken: m[1], audience: AI_TASKS_HANDLER_URL });
    return isTrustedTaskClaims(ticket.getPayload() as TokenClaims, AI_TASKS_SERVICE_ACCOUNT, AI_TASKS_HANDLER_URL);
  } catch {
    return false;
  }
}
