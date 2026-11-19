# Phase 6: Evaluation and feedback

Status: implemented on branch `feat/ai-pipeline`, not committed, not deployed. The evaluation tooling is ready, but **the dataset still has to be collected and labelled** (see [eval.md](eval.md)). No real evaluation numbers exist yet.

## 1. NGO feedback

After accepting a case, an NGO can say on "My cases" in the NGO workspace what it actually found:

- the actual species (cat, dog, bird, other, not sure);
- the actual urgency (P0, P1, P2);
- whether the advice helped (helpful, partly, not helpful, not applicable);
- an optional note.

The form shows what the AI said next to each question, prefills a previous answer, and can be resubmitted. Feedback never changes the case itself.

**Storage:** `POST /api/cases/:caseId/ai-feedback` writes `case/{id}/private/aiFeedback`.

- **Authorization** is the same as the status update: an admin can submit for any case; an NGO only for a case its organisation accepted.
- **Validation:** `server/aiFeedback.ts` uses enums only; the note is capped at 500 characters, with control characters stripped but newlines kept; unknown fields are dropped.
- **Prediction snapshot.** The document stores what the AI predicted *when the feedback was first submitted*: case urgency, species, review flag, schema version, rules version, plus prompt version and model from `aiRun`. Later re-analysis can't rewrite history, and feedback can be grouped by prompt or rules version.
- **History:** `revisions`, `createdAt` and `updatedAt` record how often and when it changed.
- **Rules:** the accepting NGO and admins may read the document. Nobody may write it from the client, admins included: `update, delete: if isAdmin() && !(docId in ['aiRun', 'aiFeedback'])`. Clients can still create only `contact`.
- **Case deletion:** the admin delete route removes `aiFeedback` too.

## 2. `npm run eval`

`scripts/eval.ts` runs **`runAnalysis`**, the same function production uses, on `eval-data/manifest.json` plus photos:

- **What it touches:** no Firestore writes, no run locks, no daily quota.
- **Pure parts:** the manifest schema and path checks are in `server/ai/eval/manifest.ts`, and the metrics and Markdown report in `server/ai/eval/metrics.ts`.
- **Usage, report contents, case list:** see **[eval.md](eval.md)**.

**Reports.** It writes `eval-data/reports/<timestamp>-<prompt>.md` and `.json`. Each report records:

- **Versions:** model, prompt, schema, triage rules, advice library.
- **Commit:** the git commit, plus a `-dirty` marker if there are uncommitted changes.
- **Dataset:** the dataset's SHA-256, so runs on different data can't be compared by mistake.

**Metrics.** P0 under-triage is the primary metric. The report also has:

- the urgency confusion matrix, accuracy, and under- and over-triage;
- species and Gate accuracy;
- human-review rate, success rate and schema failure rate;
- p50 and p95 latency, and tokens (plus cost if prices are given);
- consistency (with `--repeat`), and a per-category breakdown.

**Design choices:**

- **Failures count as P1.** A failed run counts as P1, the production fallback, so a timeout on a true-P0 case is scored as under-triage, which is what a reporter would experience. If any run failed, the report warns about it at the top.
- **Same photo rules as production.** Only JPEGs under 5 MB are accepted, and all photos are loaded before the first Gemini call, so a bad file stops the run before quota is spent.
- **Photos stay inside the dataset.** Photo paths can't leave the manifest folder.
- **Pre-release check.** `--max-p0-under-triage <0–1>` exits 1 when the threshold is exceeded, for CI or pre-release checks.
- **Never shipped.** `eval-data/` is in `.gitignore` and `.dockerignore`, so photos can't be committed or baked into the image. `scripts/` is docker-ignored too, and the eval code isn't in the server bundle.

**Template:** `docs/ai-pipeline/eval-manifest.example.json` has 11 example cases, one per category to collect. It is validated by a test.

## 3. CLAUDE.md

A new section, "AI 架構（改 AI 相關程式之前必讀）", covers:

- the layer, file and version table;
- the rule that **any change to the prompt, schema, triage, advice or matching rules, or the model must be compared with `npm run eval` on the same dataset, with P0 under-triage not getting worse**;
- version-bump rules, and the warning that `eval-data/` must never be committed.

Commands, directory map, Firestore table, test coverage note and environment variables are updated too.

## Files

| File | Change |
|---|---|
| `server/aiFeedback.ts` (new) | `parseFeedback`, `predictionSnapshot` |
| `server.ts` | `POST /api/cases/:caseId/ai-feedback`; the case delete route removes `aiFeedback` |
| `firestore.rules` | Read access to `aiFeedback` for the accepting NGO; server-only writes |
| `src/components/AiFeedbackForm.tsx` (new), `NgoWorkspace.tsx` | Feedback form on "My cases" |
| `src/services/caseService.ts`, `src/types.ts` | `fetchAiFeedback`, `submitAiFeedback`, `AiFeedback` |
| `server/ai/eval/manifest.ts`, `metrics.ts` (new) | Manifest schema, path check, metrics, Markdown report |
| `scripts/eval.ts` (new), `package.json` | `npm run eval` |
| `.gitignore`, `.dockerignore` | `eval-data/` (and `scripts/` for Docker) |
| `docs/ai-pipeline/eval.md`, `eval-manifest.example.json` (new) | How to run, metrics, case collection list, template |
| `src/locales/*.json` | `aiFeedback.*`, `server.errors.badFeedback` and `feedbackFailed` |
| `firebase-blueprint.json`, `CLAUDE.md`, README | Updated |

## Verification

- `npm run lint`: clean.
- `npm test`: 16 files, 360 tests, all passing. New coverage:
  - **Metrics:** percentiles, the P0 metric (including failures counting as misses), the confusion matrix, accuracy and under- and over-triage, species and Gate scoring on successful runs only, latency, tokens and cost, consistency, the per-category table, empty input, report content and the failure warning.
  - **Manifest:** the template is valid, defaults apply, invalid manifests are rejected, duplicate IDs are rejected, and `../` or absolute photo paths are refused.
  - **Feedback:** valid and invalid input, note cleaning, extra fields dropped, and prediction snapshots for v5, legacy and no-AI cases.
- `npm run build`: succeeds; no eval code ends up in `server-dist`.
- **CLI smoke test** on a scratch dataset with a synthetic JPEG and an **invalid** API key (Gemini rejects the key, so nothing is analysed or billed):
  - photo loading, the real Gemini client and error classification (`client`) all run;
  - failed runs count as P1, and the true-P0 case is reported as missed;
  - the warning header appears, both report files are written, and `--max-p0-under-triage 0` exits 1;
  - a missing key, a missing manifest and a `../` photo path exit 2 with clear messages.
- **Not done:** a real evaluation run (no key and no dataset on this machine), and a live feedback submission (needs Firebase credentials and an NGO account).

## Deploy

1. **Firestore rules:** run `npx firebase-tools deploy --only firestore:rules --dry-run`, then the real deploy. Without it, NGOs can't prefill their earlier feedback: the read is denied and the form starts empty. Submitting still works, because it goes through the server.
2. **Cloud Run:** redeploy. No new environment variables.
3. **After deploy:** sign in as an NGO account, accept a test case, open "Give feedback on the AI result", submit it, and check that `case/{id}/private/aiFeedback` exists with a `prediction` block.
4. **Evaluation:** collect and label a dataset following [eval.md](eval.md), then run `npm run eval` to record the baseline for `analyze.v3` / `triage.v1`.
