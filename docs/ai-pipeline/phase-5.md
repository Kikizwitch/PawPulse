# Phase 5: Matching on the server

Status: implemented on branch `feat/ai-pipeline`, not committed, not deployed. The scoring table and the capability rules are drafts for the rescue team to review.

## What changed in one sentence

NGO ranking moved from the browser to the server. NGOs gain a structured `capabilities` list (free-text `specialties` stays as display text). A case's required capabilities are derived from the AI findings, and a species disagreement between the AI and the reporter widens the match instead of excluding NGOs.

## Decisions (as agreed)

- **Keep `specialties` as display text and add `capabilities` as a separate field.** No data migration is needed.
- **Capability list:** `emergency_vet`, `surgery`, `neonate_care`, `trapping`, `transport`, `skin_parasite`, `shelter`. `bird_rehab` and `wildlife_rehab` were removed at your request.
- **NGOs without the field are neutral.** An NGO with no `capabilities` field ("not tagged yet") is neither rewarded nor penalised for capabilities, so existing NGOs don't drop in the ranking before an admin tags them. An NGO with an empty list *has been* tagged and does get the missing-capability penalty.
- **Species mismatch → consider both species.** If the AI's `speciesCategory` (from usable photos, not `unknown`) differs from the reporter's `animalType`, an NGO that accepts either species counts as accepting. Either side may be wrong, so neither should exclude the right NGO. The AI card shows a notice asking rescuers to confirm on site. Urgency isn't affected.
- **Recomputed at match time.** The matches endpoint derives the required capabilities from the stored findings on every request, so rule changes apply to old cases too. `aiAnalysis.matching` (schema v5) records what was derived at analysis time, for audit and evaluation.

## Capability rules (`server/ai/capabilities.ts`). ⚠️ Rescue-team review needed

| Condition | Required capability |
|---|---|
| Urgency P0 | `emergency_vet`, `transport` |
| mobility = unable_to_stand | `transport` |
| traumaVehicle = yes | `surgery` |
| woundTypes ∋ fracture_deformity | `surgery` |
| ageClass = neonate | `neonate_care` |
| traumaEntrapment = yes | `trapping` |
| woundTypes ∋ skin_disease or maggots | `skin_parasite` |
| Urgency P2 | `shelter` |

Finding-based rules apply only when the photos passed the Gate. The urgency is the case's `urgency`, which comes from triage.

## Scoring (`server/matching.ts`). ⚠️ Rescue-team review needed

| Factor | Points |
|---|---|
| Base | 100 |
| Distance | −3.5 per km |
| Accepts the species (either one, if mismatched) / doesn't | +25 / −40 |
| P0 only: has 24 h emergency rescue / doesn't | +35 / −25 |
| Each required capability the NGO has / lacks (tagged NGOs only) | +12 / −8 |
| Capacity busy / full | −15 / −50 |
| Clamp | 10–99 |

- **Carried over:** distance, species, P0 emergency and capacity points are unchanged from the old browser ranking. Only the capability points are new.
- **Ties:** broken by distance, then by NGO ID, so the order is stable.
- **Drive time:** stays a rough estimate (2.5 min per km, at least 5 min). It isn't a routed time.

## API

`GET /api/cases/:caseId/matches?limit=3` (limit 1–10, rate-limited to 60 per minute per IP).

- **Access:** public, because case and NGO data are already public. Cases pending deletion return 404 unless the caller is an admin or an NGO, matching `firestore.rules`.
- **Response:** `{ matches: [{ ngoId, matchScore, distanceKm, driveTimeMins, matchedCapabilities, missingCapabilities, reasons }], requiredCapabilities, speciesMismatch, species, version }`.
- **No NGO data in the response:** it returns only IDs and scores. The client joins them with the NGO list it already subscribes to (`mergeMatches`).
- **Caching:** the server caches `ngodatail` for 60 s. A capacity or capability change can take up to a minute to affect the ranking.

## Files

| File | Change |
|---|---|
| `src/config/ngoCapabilities.ts` (new) | Capability list, `cleanCapabilities` |
| `server/ai/capabilities.ts` (new) | Capability rule table, `deriveMatching` |
| `server/matching.ts` (new) | Scoring table, `toMatchNgo`, `scoreNgo`, `rankNgos`, `distanceKm` |
| `server.ts` | New `GET /api/cases/:caseId/matches` |
| `server/ai/pipeline.ts`, `config.ts` | Stores `aiAnalysis.matching`; `SCHEMA_VERSION = 5` |
| `src/services/caseService.ts` | `rankFirestoreNGOs` is **removed**; adds `fetchCaseMatches`, `mergeMatches`, `updateNGOCapabilities`; `subscribeToNGOs` cleans `capabilities` |
| `src/hooks/useCaseMatches.ts` (new) | Fetches matches. It re-fetches when the case's urgency, AI result or species changes, or when an NGO's capacity, capabilities or 24 h flag changes. |
| `src/App.tsx`, `CaseDetailModal.tsx`, `ReportForm.tsx` | Use the hook; the report form no longer ranks before submitting |
| `src/components/NGOMatchFeedback.tsx` | "This case may need" chips, ✓ / "not listed" capability chips per NGO, loading and unavailable states |
| `src/components/AIAnalysisCard.tsx` | Species-mismatch notice |
| `src/components/AdminDashboard.tsx` | Capability checkboxes in the create form; toggle chips on each NGO card |
| `src/types.ts` | `NGOOrganization.capabilities`, `matchedCapabilities`, `missingCapabilities`; `AIMatching` |
| `firestore.rules` | `ngodatail` create and update must have a valid `capabilities` list (at most 7 values, known values only); delete stays admin-only |
| `src/locales/*.json` | `capability.*`, `ngoMatch.*`, `aiCard.speciesMismatch`, admin labels, `server.errors.matchesFailed` |
| `firebase-blueprint.json`, `CLAUDE.md`, README | Updated |

## Verification

- `npm run lint`: clean.
- `npm test`: 14 files, 324 tests, all passing. New coverage:
  - **Capability rules:** every rule; P0, P2 and plain P1; dedupe; Gate failure; no AI result; malformed data.
  - **Species mismatch:** match, mismatch, `unknown`, untrusted photos, a reporter choosing "other", an invalid reporter value.
  - **Scoring:** distance, species (including either-species on mismatch), P0 emergency, capabilities (tagged versus untagged), capacity, the clamp, tie-breaking, the limit, and an "equipped NGO beats a slightly closer basic one" scenario.
  - **Input cleaning:** `toMatchNgo` with bad coordinates and unknown values.
  - **Rules drift check:** the capability list in `firestore.rules` must equal `NGO_CAPABILITIES`.
  - **Locales:** capability labels in zh and en.
- `npm run build`: succeeds.
- Dev server: `/matches` with a bad ID returns 400. A real ranking call needs Firestore credentials, which this machine doesn't have.

## Deploy

1. **Firestore rules** (now validates `ngodatail.capabilities`): run `npx firebase-tools deploy --only firestore:rules --dry-run`, then the real deploy. Deploy the rules **after or together with** the new frontend. The old admin UI never writes `capabilities`, so it isn't affected.
2. **Cloud Run:** redeploy. No new environment variables.
3. **After deploy:**
   - open a case; the NGO tab should load, briefly showing "Matching nearby rescue organisations…";
   - in the admin dashboard, tag one NGO's capabilities;
   - within a minute, a case that needs those capabilities should show ✓ chips for that NGO.
4. **Tagging existing NGOs:** an admin tags each existing NGO from its card. Until then they stay neutral.
