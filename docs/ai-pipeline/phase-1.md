# Phase 1: Extract and harden

Status: implemented on branch `feat/ai-pipeline`, not committed, not deployed.

## Problem

- **One inline function.** `runGeminiAnalysis` lived in `server.ts`, and the edit route duplicated its logic.
- **No timeout and no retry.** A single-use lock (`claimOnce("analyze")`) was used up *before* the Gemini call. One temporary error therefore left a case at P1 for good, with every photo blurred.
- **Weak schema.** `urgencyLevel` was a free string, and it came before `urgencyReason`, so the model picked the label before it reasoned.
- **Fabricated confidence.** The prompt asked for a "confidence between 0.70 and 0.99", and the UI showed that number as a percentage.
- **Nothing recorded.** Model, prompt version, latency and token usage were not stored. `geminiResponse` duplicated `aiAnalysis`.

## What changed

### New modules

| File | Purpose |
|---|---|
| `server/env.ts` | Loads `.env.local` and `.env`. It is imported first, because ES modules run their imports before the importing file's own code. |
| `server/firebaseAdmin.ts` | `getAdminDb`, `getAdminBucket` and `getAdminAuth`, moved unchanged from `server.ts`. |
| `server/cases.ts` | Photo constants, `casePhotoPaths`, `loadCasePhotos` and `isFreshCase`, moved unchanged. |
| `server/sanitize.ts` | `cleanStr` and `cleanList`, moved unchanged. They are used across `server.ts`, not only by the AI. |
| `server/ai/config.ts` | Model, `SCHEMA_VERSION = 2`, timeouts and limits. |
| `server/ai/client.ts` | Client singleton and `generateWithRetry`. |
| `server/ai/prompts/analyze.v1.ts` | `PROMPT_VERSION`, the prompt builder and the response schema. |
| `server/ai/validate.ts` | `parseAnalysis`, which throws `SchemaError`. |
| `server/ai/runLock.ts` | The lease-based analysis lock. |
| `server/ai/quota.ts` | Daily quota, moved and now charged once per case. |
| `server/ai/runRecord.ts` | Writes `private/aiRun`. |
| `server/ai/pipeline.ts` | `runAnalysis` (no I/O) and `analyzeCase(caseId, trigger, { lang })`. |
| `server/ai/__tests__/*` | 84 vitest tests. |

### Changed files

- `server.ts`
  - The `/analyze` route is now a thin wrapper around `analyzeCase`.
  - The edit route uses `analyzeCase(caseId, 'edit')`. An AI exception there no longer turns a committed edit into a 500.
  - The admin delete route also removes `private/aiRun` and the `analyzeEdit_` lock.
- `src/types.ts`: `schemaVersion?` was added, `confidenceScore` is now optional (legacy), and `geminiResponse` is marked legacy.
- `src/services/caseService.ts`: the create payload no longer writes `geminiResponse`. `docToReport` still reads it as a fallback.
- `src/components/ReportForm.tsx`: the local `geminiResponse: null` was removed.
- `src/components/AIAnalysisCard.tsx`: the confidence percentage only shows for legacy results (no `schemaVersion`).
- `src/App.tsx`: if `/analyze` returns `retryable`, the client retries once in the background after 5 s, then updates the success screen.
- `firestore.rules`: `private/aiRun` can no longer be updated or deleted by clients, admins included. Read access stays admin-only, and clients still can't create it.
- `firebase-blueprint.json`: added `AiRun`, `aiAnalysis.schemaVersion`, the legacy markers, and the lock semantics.
- `CLAUDE.md`: factual updates only (directory, `aiRun` row, `npm test`, `AI_TIMEOUT_MS`, the lock rule). The full architecture section is planned for Phase 6.
- `package.json` / `package-lock.json`: added `vitest@^4.1.12` as a devDependency and an `npm test` script.
- `vitest.config.ts`: Node environment, `server/**/*.test.ts` only.

## Behaviour

### Retry budget

| Level | Limit | Retries on |
|---|---|---|
| HTTP attempt | 30 s (`AI_TIMEOUT_MS`) | — |
| Run (one `analyzeCase` call) | Up to 3 attempts, 75 s total deadline. Backoff is 1 s, then 2 s, each randomised between half and the full value. A 429 `retryDelay` hint is honoured if it fits in the deadline. | 429, 5xx, 408 / timeout, network errors |
| Case (per trigger) | Up to 3 runs, within 15 min of `createdAt` (create) or `editedAt` (edit) | A run that failed with a temporary error, an empty response, or a schema error releases the lock |

- **Not retried:** other 4xx errors, safety blocks, unknown errors, a missing API key, and quota exhaustion.
- **Worst case:** 9 Gemini calls for one case, and only during a sustained 429/5xx outage.
- **Daily quota:** `AI_DAILY_LIMIT` is charged on the first run of each case only.

### Lock states (`serverLocks/{analyze|analyzeEdit}_{caseId}`)

| State | Meaning | Can a new run start? |
|---|---|---|
| (no doc) | Never run | Yes, as run 1 |
| `running` with `leaseUntil` in the future | A run is in progress | No (`in_progress`) |
| `running` with `leaseUntil` in the past | That instance died | Yes |
| `released` | The last run failed with a temporary error | Yes, while `runs < 3` |
| `done`, or a legacy doc with no `state` | Finished | No |

Results are written in a transaction. It skips the write (outcome `superseded`) if the case was edited during the run or already has a result. This closes an existing race where a slow create-time analysis could overwrite an edit.

### `/api/cases/:caseId/analyze` responses

| Situation | Response |
|---|---|
| Success | `200 { analysis, urgency }` (unchanged) |
| AI failed | `200 { noResponse: true, retryable }` |
| Missing key, quota used up, result superseded | `200 { noResponse: true, retryable: false }` |
| Storage not configured | `503` |
| Case or photos missing | `404` |
| Analysed already, outside the window, in progress, out of runs | `409` (unchanged message; the body adds `reason`) |

These responses stay compatible with frontends that are already cached.

### Stored data

- `case/{id}.aiAnalysis` now carries `schemaVersion: 2` and no `confidenceScore`. `urgencyLevel` is validated against P0/P1/P2. An invalid level now rejects the whole output (the case stays P1 and the run can be retried), where before it was silently replaced with P1 and the rest was accepted.
- `case/{id}.geminiResponse` is no longer written. The edit route still sets it to `null`, so an old copy can't resurface through the `docToReport` fallback.
- `case/{id}/private/aiRun` holds the latest run and the last 10 summaries:
  - `trigger`, `runNumber`, `outcome`, `skipReason`
  - `model`, `modelVersion`, `promptVersion`, `schemaVersion`
  - `attempts`, `latencyMs`, token `usage`, `finishReason`
  - `rawText` (capped at 20 KB), or `error {kind, status, message}`
- Each HTTP attempt also logs one JSON line (`event: "gemini_attempt"`) with latency and tokens, so Cloud Logging can filter on it. Model output is never logged.

## Decisions

- **Own retry loop, SDK retries off.** SDK v2.25.0 retries only when `retryOptions` is set, and it doesn't treat timeouts as retryable. Owning the loop gives accurate attempt counts and one log line per attempt.
- **Timeout via our own `AbortController`, raced against the call.** This works even if the SDK ignores the abort. The SDK passes `config.abortSignal` to `fetch`, so the request really is cancelled. Gemini may still bill a request that was cancelled.
- **Photos load before the lock is claimed,** as before, so a case with missing photos doesn't use up a run. The claim transaction re-checks that `editCount` hasn't changed since the photos were read.
- **`responseSchema` with `format: 'enum'` and `propertyOrdering`** (both checked in the installed types). Phase 2 moves to `responseJsonSchema` generated from Zod.
- **No `thinkingConfig` yet.** It would change outputs without measurement. Latency and token data come first.
- **Confidence is hidden only on new results**, as requested. Legacy results still show their (fabricated) percentage. Hiding it everywhere is a one-line change if you want it.
- **The edit trigger has no client retry in Phase 1.** It relies on the in-run retries. Its lock already supports later retries, which Phase 4's queue will use.
- **Firebase-dependent tests mock `server/firebaseAdmin`.** `firebase-admin/auth` `require()`s an ESM-only package (`jose`), which fails on the local Node 20.12. Production runs Node 22 and is unaffected.

## Verification

- `npm run lint`: clean.
- `npm test`: 5 files, 84 tests, all passing. They cover:
  - error classification and retry/no-retry for each status, timeout, network, empty, blocked
  - the attempt cap, the deadline cut-off, the `retryDelay` hint, backoff bounds
  - logs that never contain model output
  - every `decideClaim` branch
  - hostile and malformed model JSON
  - the sensitive-photo fail-closed mapping
  - escaping of the prompt's description fence
  - schema ordering and the enum
  - the request shape of `runAnalysis`
- `npm run build`: succeeds. `server-dist/server.cjs` contains the `server/ai` code, and `dotenv.config` runs before any env read in the bundle.
- `npm ci --dry-run` with npm 10.9: the lockfile is consistent.
- Dev server: `/api/health` responds, `/api/ai/status` responds, a bad case ID returns 400, and `/analyze` without storage returns 503 `storage_not_configured`.
- **Not done:**
  - **The end-to-end report test.** This machine has no `.env.local` or `.env`, so there is no `GEMINI_API_KEY` and no `FIREBASE_STORAGE_BUCKET`. A test case would have written to production Firestore without exercising the AI path, so none was created.
  - **`docker build`.** Docker isn't installed here.

## Deploy steps (for the owner)

1. Check the rules syntax: `npx firebase-tools deploy --only firestore:rules --dry-run`
2. Deploy the rules: `npx firebase-tools deploy --only firestore:rules`. This is a tightening only (no admin client update or delete on `private/aiRun`), so deploying it before or after the server is safe.
3. Rebuild and deploy Cloud Run as usual. Optional new env var: `AI_TIMEOUT_MS` (default 30000).
4. After deploying, submit one test report and check:
   - `aiAnalysis.schemaVersion == 2`
   - `private/aiRun` exists
   - log lines with `event="gemini_attempt"` appear
