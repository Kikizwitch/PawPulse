# Phase 2: Findings and deterministic triage

Status: implemented on branch `feat/ai-pipeline`, not committed, not deployed. **The triage rule table needs vet review before it is relied on.**

## What changed in one sentence

Gemini no longer picks P0/P1/P2. It reports structured observations, each of which can be `unknown`, and a plain TypeScript rule table turns those observations into the urgency, reason codes and a human-review flag.

## Files

| File | Change |
|---|---|
| `server/ai/findings.ts` (new) | Zod definition of the Gate and Observe fields, plus a compile-time check that it matches `src/types.ts` |
| `server/ai/prompts/analyze.v2.ts` (new) | The observe-only prompt and `RawAnalysisSchema` (Zod). Gemini's `responseJsonSchema` is generated from that schema with `z.toJSONSchema`. |
| `server/ai/triage.ts` (new) | Rule table (data at the top of the file), `triage()` and `mergeTriage()` |
| `server/ai/validate.ts` | Rewritten: `parseRaw` (Zod), `toObservation`, `uncertaintyOf`, `sensitivePositions`, `buildAnalysis` |
| `server/ai/pipeline.ts` | `runAnalysis` now takes `reporterTags`, runs triage, and supports `AI_OBSERVE_TWICE` |
| `server/ai/runRecord.ts` | `aiRun` gains `triage` and `consensus` |
| `server/ai/config.ts` | `SCHEMA_VERSION = 3`, `AI_OBSERVE_TWICE` |
| `src/types.ts` | `AIGate`, `AIFindings`, `AIEvidence`, `AITriage`, `AIUncertainty`. The old text fields are now optional. |
| `src/utils/aiAnalysis.ts` (new) | Rendering helpers for every `aiAnalysis` version, defensive against malformed data |
| `src/components/AIAnalysisCard.tsx` | v3 shows: reason codes, rule version, AI suggestion, observed findings, uncertainty, a human-review banner, and a "not vet-reviewed" note on AI advice |
| `src/components/CaseFeed.tsx`, `InteractiveMap.tsx` | The injury summary comes from the helper. The feed search also matches translated findings. |
| `src/locales/zh.json`, `en.json` | New `aiFindings.*` and `triage.*` blocks, plus `aiCard.aiAdviceNote` |
| `vitest.config.ts` | Also runs `src/utils/**/*.test.ts` |
| `package.json` | `zod@^4.6.7` added to `dependencies` (used at runtime) |
| `firebase-blueprint.json`, `CLAUDE.md` | Updated for v3 and the new env var |

`analyze.v1.ts` is kept unchanged as a record but is no longer used.

## Model output (analyze.v2)

| Group | Fields |
|---|---|
| Gate | `animalVisible` (bool), `imageUsable` (bool), `speciesCategory` (cat, dog, bird, other, **unknown**) |
| Observe | `ageClass`, `consciousness`, `mobility`, `bleeding`, `breathingDistress`, `traumaVehicle`, `traumaFall`, `traumaBite`, `traumaEntrapment`, `wounds`, `woundTypes[]`, `bodyCondition`. Every single-value field allows `unknown`. |
| Evidence | `{finding, photo}[]`, linking each non-normal finding to a photo |
| Narrative | `estimatedBreed`, `appearanceDescription` |
| Suggestion | `suggestedUrgencyReason`, then `suggestedUrgency` (advisory only) |
| Advice (until Phase 3) | `rescueEquipment`, `firstAidAdvice`, `handlingPrecautions` |
| Safety | `sensitivePhotoNumbers` |

The properties are generated in that order, so observations come before the suggestion. Any invalid value or missing field rejects the whole output; the case stays P1 and the run can be retried. Extra fields, such as an invented `confidenceScore`, are dropped.

### One call, not two

Gate and Observe come from **one** Gemini call:

- **Same photos.** Two calls would upload the same images twice, roughly doubling tokens and latency.
- **Latency.** The reporter waits on this request on the success screen until Phase 4.
- **Quota.** `AI_DAILY_LIMIT` is counted per case, so a second call would double the cost of each case without changing the quota.
- **No dependency.** When the Gate fails, triage ignores the observations entirely, so there's no need to wait for the Gate before observing.

## Triage rules (`server/ai/triage.ts`, `triage.v1`). ⚠️ Vet review needed

The rules are applied in order:

1. **Gate.** If no animal is visible or the photos are unusable, the case is **P1** and needs human review. The observations are ignored.
2. **Red flags → P0**, but only if `evidence` cites a photo for that field. Without photo evidence, the case is P1 with `red_flag_unconfirmed` and needs human review.

   | Finding | Code |
   |---|---|
   | consciousness = unresponsive | `unresponsive` |
   | bleeding = heavy | `heavy_bleeding` |
   | breathingDistress = severe | `severe_breathing_distress` |
   | traumaVehicle = yes | `vehicle_trauma` |
   | mobility = unable_to_stand | `unable_to_stand` |

3. **P1 findings.** No evidence is required, because they can only raise urgency.

   | Finding | Code |
   |---|---|
   | consciousness = dull | `dull_consciousness` |
   | consciousness = appears_dead | `possibly_deceased` (also needs human review) |
   | bleeding = minor | `minor_bleeding` |
   | breathingDistress = mild | `mild_breathing_distress` |
   | mobility = limping | `limping` |
   | traumaFall / traumaBite / traumaEntrapment = yes | `fall_trauma` / `bite_wound` / `entrapment` |
   | wounds = present | `visible_wound` |
   | woundTypes ∋ open_wound, fracture_deformity, burn, eye_injury, skin_disease, maggots, other | the same name (`other` → `other_injury`) |
   | bodyCondition = emaciated | `emaciated` |
   | ageClass = neonate | `neonate` |

4. **Critical unknowns → at least P1.** A critical observation answered `unknown` gives `<field>_unknown`. The critical fields are consciousness, bleeding, breathingDistress and mobility.
5. **Model suggestion.** It can only raise the level, and never above P1 on its own:
   - P1 when the rules said P2 → P1 (`model_raised`).
   - P0 without a confirmed red flag → P1, `model_p0_unconfirmed`, needs human review.
   - A lower suggestion is ignored.
6. **Reporter tags.** `injured`, `trapped` and `juvenile` raise P2 to P1, never further. Other tags have no effect.
7. Nothing triggered → **P2** with `no_urgent_findings`.

The reporter's **description is not a triage input.** The model sees it as untrusted context. Because the model could still be swayed by it, P0 requires photo evidence, and a model P0 suggestion alone caps at P1.

### Decisions a vet (or you) should confirm

- **`unable_to_stand` is a P0 red flag.** It covers spinal or pelvic injury and shock. The prompt tells the model to answer `unknown` if the animal is just lying down.
- **A possibly dead animal is P1 plus human review**, not P0.
- **A neonate alone is P1.**
- **Fracture or deformity, maggots and burns are P1**, not P0.
- **`thin` and `overweight` are not flagged**; only `emaciated` is.
- **Unknown on any of the 4 critical fields gives at least P1.** Expect many more P1s and fewer P2s than before. That is the intended direction (under-triage is the primary risk), but it will show up in the numbers.

## Uncertainty (replaces the confidence number)

`aiAnalysis.uncertainty = { unknownFindings, totalFindings (11), animalVisible, imageUsable }`. The card shows "N of 11 observations could not be determined from the photos" and lists which ones.

## Optional double run (`AI_OBSERVE_TWICE=1`, off by default)

- **Calls.** Two identical calls run in parallel, so latency stays close to a single call.
- **Merging.** The higher level wins. A disagreement adds `runs_disagree` and needs human review. A photo marked sensitive by either run stays blurred.
- **Failures.** If one run fails, the other is used.
- **Cost.** Tokens double, but the daily quota is still charged once per case.
- **Record.** `aiRun.consensus` stores both levels.

## Stored shape (`schemaVersion: 3`)

`aiAnalysis` now holds:

- `urgencyLevel`, which comes from triage, not from the model
- `gate`, `findings`, `evidence` (photo positions in the case), `triage`, `uncertainty`
- the narrative fields `estimatedBreed` and `appearanceDescription`
- the AI-written advice lists (until Phase 3)
- `sensitivePhotos` and `analyzedAt`

`identifiedSpecies`, `apparentInjuries`, `urgencyReason` and `confidenceScore` are no longer written. The UI still renders v1 and v2 results through `src/utils/aiAnalysis.ts`.

No top-level Case field changed: everything new is inside `aiAnalysis`, which the client must create as `null`. So **`firestore.rules` needs no change in this phase.**

## Verification

- `npm run lint`: clean. This includes the Zod/type drift check; changing one enum value on one side was confirmed to fail lint.
- `npm test`: 9 files, 183 tests, all passing. They cover:
  - **Triage:** every rule in the table, every red flag with and without evidence, every critical unknown, Gate failures, all model-suggestion paths, all tag paths, and adversarial cases:
    - a description saying "this is P0"
    - an "injured" tag on a healthy cat
    - in-image text pushing a heavy-bleeding report without evidence
    - attempts to lower a red flag
  - **Merging:** consensus merge.
  - **Validation:** every invalid enum, a missing field for each field, extra fields stripped, evidence photo mapping, sensitive-photo fail-closed.
  - **Schema:** the generated Gemini schema uses only supported keywords, with the right order, `unknown` on every observation, and no safe-integer bounds.
  - **Locales:** every reason code and every finding value has zh and en text, with no extras.
  - **Client helper:** v1, v2 and v3 shapes and malformed data.
- `npm run build`: succeeds. zod stays an external `require` and is in `dependencies`, so `npm ci --omit=dev` installs it.
- Dev server starts. `/api/ai/status` and the `/analyze` error path respond as before.
- **Not done:** a live Gemini call. There is no API key or bucket on this machine. The real model's behaviour on the new schema (especially how often it answers `unknown`) is unmeasured until Phase 6's eval or a staging test.

## Deploy

- **Rules:** no change in this phase. Phase 1's `aiRun` rule change still needs deploying if it hasn't been.
- **Cloud Run:** redeploy. `AI_OBSERVE_TWICE` is optional and off by default.
- **After deploy:** submit one report and check:
  - `aiAnalysis.schemaVersion == 3`
  - `triage.reasonCodes` is present
  - `aiRun.promptVersion == "analyze.v2"` and `aiRun.triage` is present
  - the card shows the reasons and observations in both languages
