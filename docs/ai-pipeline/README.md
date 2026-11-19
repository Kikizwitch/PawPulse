# PawPulse AI pipeline

How PawPulse uses Gemini to triage stray-animal reports, and how that design is changing.

## Design principle

**Gemini observes, code decides, reviewed content advises.**

| Layer | Who | What it produces | Why |
|---|---|---|---|
| Observe | Gemini | Structured findings about the photos (species, visible injuries, usability), each one allowed to be `unknown` | The model is good at perception and bad at being accountable for decisions |
| Decide | Plain TypeScript (`triage.ts`, Phase 2) | Urgency P0/P1/P2, reason codes, `needsHumanReview` | Rules can be read, reviewed by non-engineers, unit-tested and versioned |
| Advise | Reviewed locale entries (Phase 3) | First-aid, equipment and precaution text chosen by finding code | Advice shown to citizens must be content a vet has reviewed, not free model text |

Around those layers:

- **Reliable execution:** timeouts, bounded retries, a lease-based lock, and later an async queue (Phase 4).
- **Version tracking:** every run records its model, prompt version, schema version, latency and token usage in a private document.
- **Evaluation loop:** an offline eval set plus NGO feedback on real cases (Phase 6).

## Safety invariants (hold in every phase)

1. If the AI fails, times out or runs out of quota, the report still goes through and the case stays **P1**.
2. Photos that have not been analysed stay **blurred** (fail-closed).
3. Model output is validated field by field before anything is written. The reporter's description, the reporter's tags and any text visible in the photos are untrusted. They can never lower urgency, and they cannot raise a case to P0 on their own.
4. Reporter contact data never goes into the public `case` document.
5. Raw model output lives only in `case/{id}/private/aiRun`. Only the server writes it and only admins can read it.
6. Old cases keep rendering. `aiAnalysis.schemaVersion` tells the UI which shape it is reading (missing means v1).
7. No medical advice or phone number is presented as verified until a vet or a human has checked it.

## Phases

| Phase | Scope | Status |
|---|---|---|
| [1](phase-1.md) | Extract `server/ai/`, timeouts and retries, versioned prompt, enum urgency, retryable lock, `private/aiRun`, drop the fake confidence | Done, awaiting review |
| [2](phase-2.md) | Zod-defined Gate and Observe findings, deterministic `triage.ts`, uncertainty signals, i18n reason codes | Done, awaiting review (rule table needs vet review) |
| [3](phase-3.md) | Advice library in the locale files, selected by code from findings; at most one AI-written note, labelled as such | Done, awaiting review (every advice entry needs vet review) |
| [4](phase-4.md) | Async execution with Cloud Tasks, `aiStatus`, `onSnapshot` on the client, a transactional daily quota | Done, awaiting review (GCP setup needed) |
| [5](phase-5.md) | Server-side NGO matching, `capabilities` enum, `requiredCapabilities`, `speciesMismatch` | Done, awaiting review (scores and rules need rescue-team review) |
| [6](phase-6.md) | NGO feedback (`private/aiFeedback`), [`npm run eval`](eval.md) on a local dataset, CLAUDE.md architecture section | Done, awaiting review (dataset to be collected) |

## Current flow (after Phase 4)

```
Browser (App.tsx)                    Server                                   Firestore / Storage / Cloud Tasks
-----------------                    ------                                   ---------------------------------
createCaseInFirestore ─────────────────────────────────────────────────────▶  case/{id} (urgency P1, aiAnalysis null)
POST /api/cases/:id/analyze ──▶ queueAnalysis(id, 'create')
                                 ├─ check 15-min window and photo paths
                                 ├─ aiStatus = queued  ───────────────────────▶  case/{id}.aiStatus
                                 └─ create task (name dedupes) ───────────────▶  Cloud Tasks queue
   ◀── 202 { queued: true }
subscribeToCase (onSnapshot) ◀──────────────────────────────────────────────── case/{id} changes
shows "AI is analysing…"
                                                         Cloud Tasks ──POST (OIDC token)──▶
                                 POST /api/internal/tasks/analyze
                                 ├─ verifyTaskRequest (Google signature, audience, service account)
                                 └─ analyzeCase(id, 'create', willRetry)
                                     ├─ claimRun (transaction) → aiStatus = running
                                     ├─ daily quota: aiQuota/{UTC day} (transaction, first run only)
                                     ├─ runAnalysis: prompt v3 → Gemini → Zod → triage → selectAdvice
                                     ├─ write aiAnalysis + urgency + aiStatus = done (transaction)
                                     └─ writeRunRecord → private/aiRun
                                 ◀── 200 (done / not retryable) or 503 (temporary → Cloud Tasks retries)
```

Without Cloud Tasks configured (local dev), or if the task can't be created, `/analyze` runs `analyzeCase` inside the request, as in Phase 1–3.
The edit route sets `aiStatus = queued` in its transaction and queues an `'edit'` task the same way.

NGO matching is a separate read: the UI calls `GET /api/cases/:id/matches` (`useCaseMatches`) whenever the case's urgency or AI result, or the NGO data, changes. The server recomputes the required capabilities from the stored findings and ranks NGOs with `server/matching.ts`.

## Module map

| File | Responsibility | Touches Firestore? |
|---|---|---|
| `server/ai/config.ts` | Model name, timeouts, retry and run limits, schema version | No |
| `server/ai/client.ts` | Gemini client singleton, `generateWithRetry`, error classification, per-attempt structured logs | No |
| `server/ai/findings.ts` | Zod definition of Gate and Observe fields; compile-time check against `src/types.ts` | No |
| `server/ai/prompts/analyze.v3.ts` | Current prompt and `RawAnalysisSchema` (Zod); the Gemini `responseJsonSchema` is generated from it | No |
| `server/ai/geminiSchema.ts` | Zod → Gemini JSON Schema converter (v3 onwards) | No |
| `server/ai/advice.ts` | **Advice rule table** (`selectAdvice`) and `cleanAiNote` | No |
| `src/config/adviceLibrary.ts` | Advice codes and their vet-review status (shared by server and UI) | No |
| `server/ai/prompts/analyze.v2.ts` | Phase 2 prompt, kept unchanged as a record | No |
| `server/ai/prompts/analyze.v1.ts` | Phase 1 prompt, kept unchanged as a record (no longer used) | No |
| `server/ai/validate.ts` | `parseRaw` (Zod), `toObservation`, `uncertaintyOf`, `buildAnalysis` | No |
| `server/ai/triage.ts` | **Rule table** and the pure `triage()` / `mergeTriage()` functions | No |
| `src/utils/aiAnalysis.ts` | Client rendering helpers for every `aiAnalysis` version | No |
| `server/ai/runLock.ts` | `decideClaim` (pure) plus `claimRun` / `finishRun` (transactions) | Yes |
| `server/ai/quota.ts` | Daily quota: one Firestore document per UTC day, shared by all instances | Yes |
| `server/ai/tasks.ts` | Cloud Tasks enqueue (REST) and OIDC verification for the handler | No |
| `server/ai/capabilities.ts` | **Capability rule table**: findings → required NGO capabilities, species mismatch | No |
| `server/matching.ts` | **Scoring table** and pure NGO ranking used by `GET /api/cases/:id/matches` | No |
| `src/config/ngoCapabilities.ts` | The capability list (shared by server, UI and rules) | No |
| `server/aiFeedback.ts` | Validation and prediction snapshot for NGO feedback (`private/aiFeedback`) | No |
| `server/ai/eval/` | Eval manifest schema and metrics (pure) | No |
| `scripts/eval.ts` | `npm run eval`: runs `runAnalysis` on `eval-data/` and writes reports | No |
| `server/ai/runRecord.ts` | Writes `private/aiRun` | Yes |
| `server/ai/pipeline.ts` | `runAnalysis` (pure, reused by eval) and `analyzeCase` (orchestration) | Yes |

## Rules for changing the AI

- **Prompt or response schema change:** add a new file (next: `analyze.v4.ts`) and bump `PROMPT_VERSION`. Never edit a released version, or `aiRun.promptVersion` stops meaning anything.
- **Advice change:** add or edit text in both locale files, add the code to `adviceLibrary.ts` with `status: 'pending_vet_review'`, and reference it from `ADVICE_RULES`. A vet sets `vet_reviewed` once checked.
- **Triage rule change:** edit the table at the top of `triage.ts`, bump `RULES_VERSION`, add locale text for new codes, and get a vet to review it.
- **Stored shape change:** bump `SCHEMA_VERSION` in `server/ai/config.ts` and keep the UI rendering every older version.
- **Model change:** update `GEMINI_MODEL`.
- **Any of the above:** run [`npm run eval`](eval.md) before and after on the same dataset. P0 under-triage must not get worse.
- Run `npm test` after any change in `server/ai/`.
