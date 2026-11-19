# Phase 4: Async execution with Cloud Tasks

Status: implemented on branch `feat/ai-pipeline`, not committed, not deployed. **It needs GCP setup (a queue, a service account and IAM) before it is used.** Until the three `AI_TASKS_*` variables are set, the server falls back to running analysis inside the request, exactly as in Phases 1–3.

## Why Cloud Tasks

- **Problem:** the browser used to wait on the HTTP request while Gemini ran, up to about 75 s with retries. A temporary failure meant the browser had to retry.
- **Why not reply first and keep working:** Cloud Run throttles CPU after the response is sent, so "respond now, keep working in the background" isn't reliable.
- **What Cloud Tasks gives us:** a separate request that Cloud Run serves with full CPU, managed retries with backoff, and deduplication by task name.

## Flow

1. **Report.** The reporter's browser writes the case to Firestore, as before. It then calls `POST /api/cases/:id/analyze`.
2. **`queueAnalysis` (server):**
   - checks the 15-minute window and that the case has photo paths;
   - sets `aiStatus = "queued"`;
   - creates a Cloud Task named `analyze-{trigger}-{caseId}-{editCount}`; a second click or a retry gets `ALREADY_EXISTS`, which counts as already queued;
   - replies **202 `{ queued: true }`**.
3. **Waiting (browser).** The success screen subscribes to the case document (`subscribeToCase`, which uses `onSnapshot`) and shows "AI is analysing the photos…". When `aiAnalysis` arrives, it shows the result and re-ranks the NGOs for the new urgency.
4. **Cloud Tasks** calls `POST /api/internal/tasks/analyze` with an OIDC token signed for the configured service account.
5. **Handler:**
   - verifies the token: Google signature, `audience` equal to the handler URL, `email` equal to `AI_TASKS_SERVICE_ACCOUNT`, `email_verified`;
   - validates the payload;
   - runs `analyzeCase(..., { willRetry: true })`;
   - replies 503 on a temporary failure (Cloud Tasks retries) and 200 otherwise.
6. **Edit route.** It sets `aiStatus = "queued"` in the edit transaction, queues an `edit` task the same way, and replies straight away. The edit modal says "AI is re-analysing".

**Fallback:** if Cloud Tasks isn't configured, or the task can't be created, `/analyze` and the edit route run `analyzeCase` inside the request. The browser then gets the result in the response, as before.

The Phase 1 browser background retry is removed. Retries now come from Cloud Tasks, bounded by the per-case run lock (3 runs) and the 15-minute window.

## `aiStatus`

| Value | Set by | Meaning |
|---|---|---|
| (absent) / `null` | client create | Old case, or not yet queued |
| `queued` | `queueAnalysis`, edit transaction, or a temporary failure that Cloud Tasks will retry | Waiting for a task |
| `running` | `claimRun` (same transaction as the lock) | Gemini is being called |
| `done` | Result transaction (same write as `aiAnalysis`) | Finished |
| `failed` | Permanent failure, run cap reached, outside the window, or a temporary failure with no retry (inline mode) | No result; the case stays P1 |
| `skipped` | No API key, daily quota used up, no photos, storage not configured | Not analysed; the case stays P1 |

**Guards:**

- **Status writes are scoped.** The server only changes `aiStatus` on a case whose status is currently `queued` or `running`, with no `aiAnalysis` and an unchanged `editCount`. A stray API call can't stamp a status onto an old case, and a late result can't overwrite a newer edit.
- **The client never trusts a stuck status.** `isAiPending()` shows "analysing" only while the status is `queued` or `running` *and* the case was created or edited less than 20 minutes ago (15-minute window plus retries).

**Field changes, synced everywhere:**

- `src/types.ts`: `AiStatus`, `StrayReport.aiStatus`
- `firestore.rules`: `aiStatus` in the `hasOnly` whitelist, and it must be absent or null on create
- `caseService.ts`: `docToReport` reads it and drops unknown values; `casePayload` doesn't write it
- `firebase-blueprint.json`

## Daily quota

`AI_DAILY_LIMIT` is now enforced by a Firestore transaction on `aiQuota/{YYYY-MM-DD}`, where the date is UTC (08:00 in Hong Kong). The document holds `{ count, limit, updatedAt }`.

- **Shared across instances.** All Cloud Run instances share one counter. Before, each instance had its own in-memory counter, so the real limit was `AI_DAILY_LIMIT × instances`. **Review the value of `AI_DAILY_LIMIT`:** 500 now means 500 cases per day in total.
- **Charged per case,** on the first run only; retries and `AI_OBSERVE_TWICE` don't charge again.
- **Fail-safe.** If the quota transaction errors, the run releases its lock and Cloud Tasks retries. Analysis never runs without a successful quota check.
- **Client access.** `aiQuota` isn't in the rules allow-list, so clients can't read or write it (the final deny-all rule applies).

## Files

| File | Change |
|---|---|
| `server/ai/tasks.ts` (new) | `enqueueAnalyzeTask` (Cloud Tasks REST via `google-auth-library`), `verifyTaskRequest`, `isTrustedTaskClaims`, `parseTaskPayload`, `taskId` |
| `server/ai/quota.ts` | Rewritten: Firestore counter, plus pure `decideQuota` and `quotaDocId` |
| `server/ai/pipeline.ts` | `queueAnalysis`; `aiStatusAfter` (pure); guarded `aiStatus` updates; `analyzeCase` options `willRetry` and `statusOwned`; storage and key checks happen before any Firestore read |
| `server/ai/runLock.ts` | `claimRun` sets `aiStatus = running` in the same transaction |
| `server/ai/config.ts` | `AI_TASKS_QUEUE`, `AI_TASKS_SERVICE_ACCOUNT`, `AI_TASKS_HANDLER_URL`, `TASKS_ENABLED`, `TASK_DISPATCH_DEADLINE_S` (135 s by default) |
| `server.ts` | `/analyze` queues (202) or falls back to inline; new `/api/internal/tasks/analyze`; the edit route queues |
| `src/App.tsx` | The background retry is removed; the success screen uses `subscribeToCase` and shows the analysing state |
| `src/components/CaseDetailModal.tsx`, `EditCaseModal.tsx` | Analysing state; "AI is re-analysing" message after an edit |
| `src/services/caseService.ts` | `subscribeToCase`; `docToReport` reads `aiStatus`; `editCase` returns `queued` |
| `src/utils/aiAnalysis.ts` | `isAiPending` |
| `src/locales/zh.json`, `en.json` | `app.successAnalyzing`, `app.aiAnalyzing*`, `caseModal.aiAnalyzing*`, `editCase.savedAnalyzing` |
| `package.json` | `google-auth-library@^10.9.1` as a direct dependency. It was already installed through `@google/genai`; the server now imports it. |

## Verification

- `npm run lint`: clean.
- `npm test`: 12 files, 284 tests, all passing. New coverage:
  - **Enqueue:** the request has the right queue URL, task name, OIDC service account and audience, dispatch deadline, and a base64 JSON body; a 409 means duplicate; other errors throw.
  - **Handler auth:** no Bearer token, a forged signature, the wrong service account, the wrong audience or an unverified email are all rejected; a valid token is accepted with the right audience.
  - **Payload validation:** path-traversal case IDs, unknown triggers and bad language codes are rejected.
  - **`aiStatusAfter`:** every outcome.
  - **Quota:** the UTC date boundary, the limit, corrupt counters, and a limit of 0.
  - **`isAiPending`:** every status, the 20-minute expiry, the edit timestamp, and bad dates.
- `npm run build`: succeeds; `google-auth-library` stays an external `require`.
- **Dev server smoke test:**
  - the handler returns **401** without a token and with a forged token;
  - with no Cloud Tasks variables, `/analyze` takes the inline path and returns 503 `storage_not_configured` in 12 ms. An earlier draft read Firestore before that check and hung without credentials; this is now fixed.
- **Not done:** a real Cloud Tasks round trip and a live Gemini call. Both need the GCP setup below and credentials this machine doesn't have.

## GCP setup (for the owner to run)

Replace the placeholders. The region matches the existing Cloud Run services.

```bash
PROJECT=<project-id>
REGION=asia-northeast1
SERVICE=<cloud-run-service>
QUEUE=ai-analyze
INVOKER=pawpulse-tasks-invoker@$PROJECT.iam.gserviceaccount.com
RUN_URL=$(gcloud run services describe $SERVICE --region $REGION --format='value(status.url)')

# 1. Enable the API and create the queue.
#    5 attempts > 3 runs per case; backoff 10–60 s keeps retries inside the 15-minute window.
gcloud services enable cloudtasks.googleapis.com --project $PROJECT
gcloud tasks queues create $QUEUE --location $REGION --project $PROJECT \
  --max-attempts=5 --min-backoff=10s --max-backoff=60s --max-doublings=3 \
  --max-dispatches-per-second=5 --max-concurrent-dispatches=10

# 2. The service account whose OIDC token Cloud Tasks sends.
gcloud iam service-accounts create pawpulse-tasks-invoker --project $PROJECT \
  --display-name "PawPulse Cloud Tasks invoker"

# 3. Let the Cloud Run runtime service account create tasks and sign as the invoker.
#    If the describe command prints nothing, the service uses the default compute account:
#    <PROJECT_NUMBER>-compute@developer.gserviceaccount.com
RUNTIME_SA=$(gcloud run services describe $SERVICE --region $REGION --format='value(spec.template.spec.serviceAccountName)')
gcloud projects add-iam-policy-binding $PROJECT \
  --member "serviceAccount:$RUNTIME_SA" --role roles/cloudtasks.enqueuer
gcloud iam service-accounts add-iam-policy-binding $INVOKER --project $PROJECT \
  --member "serviceAccount:$RUNTIME_SA" --role roles/iam.serviceAccountUser

# 4. Only if the service does NOT allow unauthenticated access:
# gcloud run services add-iam-policy-binding $SERVICE --region $REGION \
#   --member "serviceAccount:$INVOKER" --role roles/run.invoker

# 5. Configure the service. The handler URL must be the run.app URL, which is also the OIDC audience.
gcloud run services update $SERVICE --region $REGION --update-env-vars \
AI_TASKS_QUEUE=projects/$PROJECT/locations/$REGION/queues/$QUEUE,\
AI_TASKS_SERVICE_ACCOUNT=$INVOKER,\
AI_TASKS_HANDLER_URL=$RUN_URL/api/internal/tasks/analyze
```

**Also check:**

- **Request timeout.** The Cloud Run request timeout must be at least the dispatch deadline (135 s); the default is 300 s.
- **`AI_DAILY_LIMIT`.** It is now a total across instances.
- **Firestore rules.** Deploy them (`npx firebase-tools deploy --only firestore:rules`, with `--dry-run` first). The `aiStatus` rule is defence in depth: the client never writes the field, so the order relative to the server deploy doesn't matter.

**After deploying:**

1. Submit one report. The success screen should show "AI is analysing…" and then the result, without a reload.
2. In Firestore, check that the case's `aiStatus` went `queued → running → done`, and that `aiQuota/<today>` has `count` 1 or more.
3. In Cloud Logging, check the `[Tasks] case … : done` line and the `gemini_attempt` lines.
4. Run `gcloud tasks queues describe $QUEUE --location $REGION` to confirm the queue exists and is running.
