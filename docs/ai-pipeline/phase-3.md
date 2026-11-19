# Phase 3: Reviewed advice library

Status: implemented on branch `feat/ai-pipeline`, not committed, not deployed. **All 38 advice entries are drafts and need vet review.** Until a vet marks an entry as reviewed, the UI shows it as "Pending vet review".

## What changed in one sentence

Gemini no longer writes first-aid, equipment or precaution text. Code picks entries from a fixed library based on the findings, the case stores only their codes, and the model may add at most one short, labelled sentence about the scene.

## Files

| File | Change |
|---|---|
| `src/config/adviceLibrary.ts` (new) | Every advice code, grouped as `firstAid`, `equipment` and `precautions`, each with a review `status` (`pending_vet_review` / `vet_reviewed`). The server and the UI both read it. |
| `server/ai/advice.ts` (new) | **Advice rule table** (`ADVICE_RULES`, data at the top), `selectAdvice(observation, level)`, per-category limits, and `cleanAiNote` |
| `server/ai/prompts/analyze.v3.ts` (new) | Same observe-only prompt as v2, without advice fields. Adds `situationNote` (one sentence, no medical instructions, no contact details). |
| `server/ai/geminiSchema.ts` (new) | The Zod → Gemini schema converter, shared from v3 on. v2 keeps its own copy because released versions aren't edited. |
| `server/ai/validate.ts`, `pipeline.ts`, `config.ts` | Switched to v3. `SCHEMA_VERSION = 4`. `buildAnalysis` stores `advice` (codes) and `aiNote`. |
| `src/types.ts` | `AIAdvice`; `aiNote`; the AI advice text fields are now optional (v1–v3 only) |
| `src/utils/aiAnalysis.ts` | `adviceView()`: library codes become translated text with review status. Old results fall back to the AI text, always treated as unreviewed. |
| `src/components/AIAnalysisCard.tsx` | A "Pending vet review" badge on each section with an unreviewed entry, plus a disclaimer line. A separate, labelled "AI note" box. |
| `src/locales/zh.json`, `en.json` | New `advice.*` block (38 entries plus 4 UI strings) |
| `firebase-blueprint.json`, `CLAUDE.md`, `docs/ai-pipeline/README.md` | Updated |

## How advice is chosen (`server/ai/advice.ts`). ⚠️ Vet review needed

The rules are evaluated in table order, which is also the priority order. Each category has a limit (first aid 6, equipment 6, precautions 4). When there are more matches, the general advice at the end of the table is dropped first.

1. **Always:** keep distance; gloves; bite and scratch risk.
2. **P0:** suggest phoning a nearby vet clinic if rescuers can't arrive soon. No numbers are given.
3. **No animal visible or unusable photos:** suggest adding a clearer photo by editing the report. Finding-based advice is skipped, because the findings aren't trusted.
4. **Findings:** one rule per finding. See the "Shown when" column below.
5. **Species:** a carrier, a slip lead, or a ventilated box and bird-specific advice.
6. **Always, lowest priority:** don't chase; no food, water or medicine; keep quiet; stay and observe; towels; wash hands.

The level used in step 2 is the **triage** level, not the model's suggestion.

## AI note (`aiNote`)

The model may write one sentence (`situationNote`) about the scene that the structured findings can't express, for example "the cat is under a parked car".

- **Cleaning:** `cleanAiNote` collapses it to one line and caps it at 200 characters.
- **Dropped entirely** if it contains a URL, an email address, or anything that looks like a phone number (6 or more digits, separators allowed).
- **Display:** the UI shows it in its own box, titled "AI note", with "Written automatically by AI; not checked by a person or a vet."
- **Still possible:** it can contain wrong statements. It is never used for triage or for choosing advice.

## Rendering every version

| `schemaVersion` | Urgency reasons | Findings | Advice |
|---|---|---|---|
| none / 1 | AI text | AI injury text | AI text, with the "not vet-reviewed" note |
| 2 | AI text | AI injury text | AI text, with the note |
| 3 | Reason codes | Findings | AI text, with the note |
| 4 | Reason codes | Findings | Library codes, with "Pending vet review" badges; AI note box |

No top-level Case field changed (everything is inside `aiAnalysis`), so **`firestore.rules` needs no change in this phase.**

## Entries drafted for vet review

Every entry below is marked `status: 'pending_vet_review'` in `src/config/adviceLibrary.ts`, and the file header carries a "⚠️ 待獸醫審核" comment. The "Shown when" column comes from `ADVICE_RULES`.

Things I'd ask a vet to look at first:

- **`gentle_pressure_bleeding`, `avoid_moving_spine`, `neonate_keep_warm_no_milk`, `bird_dark_box`:** these are the only entries that tell a citizen to *do* something to the animal. The rest are "don't" instructions or safety notes.
- **`no_food_water_medicine`** is shown for every case. Is it right to tell citizens not to give water in all cases, for example a dehydrated adult cat in hot weather?
- **`neonate_watch_for_mother`:** how long should a citizen watch before acting, and should this differ for birds?
- **`urgent_contact_vet`:** is it appropriate to suggest a citizen take a P0 animal to a clinic themselves?
- **Regional points:** rabies or other zoonosis wording may need to vary by region. Nothing region-specific is included.

### First aid (shown to the citizen on the scene)

| Code | Shown when | English | 中文 |
|---|---|---|---|
| `keep_distance` | always | Keep a safe distance and watch the animal. Injured or frightened animals may bite or scratch. | 請與動物保持安全距離並留意牠的情況；受傷或受驚的動物可能會咬人或抓人。 |
| `urgent_contact_vet` | level P0 | This looks serious. If rescuers can't arrive soon, phone a nearby vet clinic to ask whether they can take the animal. | 情況看來危急。如救援人員未能盡快到場，可先致電附近的獸醫診所，查詢能否接收。 |
| `add_clearer_photo` | photos unusable / no animal | The photos don't clearly show the animal's condition. If it is safe, edit the report and add a clearer photo. | 相片未能清楚顯示動物情況。如安全可行，請修改通報並補上較清晰的相片。 |
| `avoid_moving_spine` | traumaVehicle = yes; mobility = unable_to_stand; traumaFall = yes | Possible impact or fall: don't move the animal unless it is in immediate danger. If you must, slide a flat board or towel under it and keep its head and back in a straight line. | 疑似撞擊或墮下：除非動物身處即時危險，否則請不要移動牠。如必須移動，請用平板或毛巾承托，盡量保持頭部和背部成一直線。 |
| `gentle_pressure_bleeding` | bleeding = heavy; bleeding = minor | If the animal is calm and you can approach safely, press a clean cloth gently on the bleeding area. If blood soaks through, don't remove it; add another layer. | 如動物安靜而你能安全接近，可用乾淨的布輕輕按住出血位置；布被血滲透時不要拿走，再加一層即可。 |
| `keep_airway_clear` | breathingDistress = severe; breathingDistress = mild | The animal is struggling to breathe: keep the area ventilated, don't cover its head and don't press on its chest. | 動物呼吸有困難：請保持周圍通風，不要蓋住牠的頭部，也不要按壓胸口。 |
| `do_not_shake_check_breathing` | consciousness = unresponsive | The animal isn't responding: don't shake it. Watch whether its chest is moving and tell the rescuers. | 動物沒有反應：請不要搖動牠。留意胸口有沒有起伏，並告訴救援人員。 |
| `possibly_deceased_no_bare_hands` | consciousness = appears_dead | The animal may have died. Don't touch it with bare hands, and keep the location details so rescuers can confirm. | 動物可能已經死亡。請不要徒手觸碰，並保留位置資料讓救援人員確認。 |
| `do_not_pull_free` | traumaEntrapment = yes | The animal is trapped or tangled: don't pull it free. Wait for rescuers with the right tools. | 動物被困或被纏住：請不要強行把牠拉出來，等待帶備合適工具的救援人員。 |
| `do_not_splint` | woundTypes = fracture_deformity | Don't try to straighten or splint a limb that may be broken. | 請不要嘗試拉直或固定疑似骨折的肢體。 |
| `no_home_remedies` | woundTypes = open_wound; woundTypes = burn | Don't put creams, alcohol or home remedies on wounds. | 請不要在傷口塗抹藥膏、酒精或其他家居療法。 |
| `do_not_touch_eye` | woundTypes = eye_injury | Don't touch or rinse an injured eye. | 請不要觸碰或沖洗受傷的眼睛。 |
| `do_not_remove_maggots` | woundTypes = maggots | Don't try to remove maggots yourself. Tell the rescuers; a vet needs to treat it. | 請不要自行清除蛆蟲；請告訴救援人員，需要由獸醫處理。 |
| `neonate_watch_for_mother` | ageClass = neonate | Very young animals are not always abandoned; the mother may be nearby. Unless they are in danger, watch from a distance for a while first. | 初生動物不一定被遺棄，母親可能就在附近。除非牠們身處危險，請先在遠處觀察一段時間。 |
| `neonate_keep_warm_no_milk` | ageClass = neonate | Newborn animals can't keep themselves warm. If they must be moved, keep them warm with a towel, but don't give them cow's milk. | 初生動物無法自行保暖。如必須移動，請用毛巾保暖，但不要餵牛奶。 |
| `keep_warm` | bleeding = heavy; consciousness = unresponsive; bodyCondition = emaciated | Shelter the animal from rain, sun or wind, for example with a box or towel, but keep it ventilated and don't cover its head. | 請為動物遮擋雨水、陽光或寒風，例如用紙箱或毛巾，但要保持通風，不要蓋住頭部。 |
| `bird_dark_box` | species bird | Birds: if it must be contained, put it in a box with air holes in a dark, quiet place, and don't give it water. | 雀鳥：如必須收容，請放在有透氣孔的紙箱內，置於陰暗安靜的地方，不要餵水。 |
| `do_not_chase` | always | Don't chase or corner the animal; it may panic, run off or get hurt again. | 請不要追趕或圍堵動物，以免牠驚慌逃走或再次受傷。 |
| `no_food_water_medicine` | always | Unless a vet or rescuer tells you to, don't give food, water or any human medicine. | 除非獸醫或救援人員指示，請不要餵食、餵水或給予人用藥物。 |
| `keep_quiet` | always | Keep the area quiet and keep crowds and other pets away. | 請保持周圍安靜，並讓人群和其他寵物遠離。 |
| `stay_and_observe` | always | If it is safe, stay nearby until rescuers arrive and note any changes in the animal's condition. | 如情況安全，請在附近留守觀察直至救援人員到場，並記下動物情況的變化。 |

### Equipment (for the NGO team)

| Code | Shown when | English | 中文 |
|---|---|---|---|
| `gloves` | always | Thick protective gloves | 厚身保護手套 |
| `towel_blanket` | always | Towels or blankets | 毛巾或毯子 |
| `carrier` | species cat; species other; species unknown | Pet carrier or crate | 寵物籠或運輸箱 |
| `slip_lead` | species dog | Slip lead | 牽引繩（P 繩） |
| `ventilated_box` | species bird | Ventilated box | 有透氣孔的紙箱 |
| `stretcher_board` | traumaVehicle = yes; mobility = unable_to_stand; woundTypes = fracture_deformity | Stretcher or flat board | 擔架或平板 |
| `first_aid_kit` | bleeding = heavy; bleeding = minor; woundTypes = open_wound; woundTypes = burn | First-aid supplies (gauze, bandages) | 急救用品（紗布、繃帶） |
| `cutting_tools` | traumaEntrapment = yes | Cutting tools to free a trapped animal | 剪鉗等解困工具 |
| `heat_source` | ageClass = neonate | Heat source (heat pad or hot water bottle) | 保暖用品（暖包、熱水袋） |

### Precautions (citizens and rescuers)

| Code | Shown when | English | 中文 |
|---|---|---|---|
| `bite_scratch_risk` | always | Injured or frightened animals may bite or scratch, even if they are usually friendly. | 受傷或受驚的動物即使平日溫馴，也可能咬人或抓人。 |
| `traffic_safety` | traumaVehicle = yes | Near a road: make sure you are safe first and watch for traffic. | 現場靠近道路：請先確保自身安全，留意來往車輛。 |
| `support_spine` | traumaVehicle = yes; mobility = unable_to_stand; traumaFall = yes | When lifting, support the head, back and pelvis, and avoid twisting the body. | 搬動時要承托頭部、背部和盆骨，避免扭動身體。 |
| `protect_injured_limb` | woundTypes = fracture_deformity | When moving the animal, avoid bumping the injured limb. | 搬動時避免碰撞受傷的肢體。 |
| `avoid_skin_contact` | woundTypes = maggots; woundTypes = skin_disease | Some skin conditions and parasites can spread to people or pets; avoid direct skin contact. | 部分皮膚病和寄生蟲可傳染給人或寵物，請避免皮膚直接接觸。 |
| `deceased_handling` | consciousness = appears_dead | Wear gloves when handling a dead animal, and clean your hands and tools afterwards. | 處理動物屍體時請戴手套，事後清潔雙手和用具。 |
| `bird_minimal_handling` | species bird | Birds stress easily; handle them as little as possible. | 雀鳥容易受驚，請盡量減少接觸。 |
| `wash_hands` | always | Wash your hands thoroughly after any contact. | 接觸動物後請徹底洗手。 |

## Marking an entry as reviewed

1. A vet reads the English and Chinese text and the "Shown when" condition.
2. If approved, set `status: 'vet_reviewed', reviewedAt: 'YYYY-MM-DD'` for that code in `src/config/adviceLibrary.ts`.
3. If the text changes later, set it back to `pending_vet_review`.

The UI reads the status at render time, so the badge disappears for old cases too, as soon as the change is deployed.

## Verification

- `npm run lint`: clean.
- `npm test`: 10 files, 239 tests, all passing. New coverage:
  - **Library and rules:** every rule code exists in the library, and every library code is used by some rule (no dead entries). All entries are currently pending review, and unknown codes count as pending (fail-closed).
  - **Selection:** each finding rule picks its advice; the P0 entry, the Gate-failure path, the species rules, dedupe and the limits; specific advice beats general advice at the limit.
  - **`cleanAiNote`:** phone numbers in several formats, URLs and emails are dropped; ordinary numbers ("3 kittens", "10:30") are kept; long notes are truncated.
  - **Locales:** zh and en contain exactly the library codes, and no advice text contains a phone number or URL.
  - **Client helper:** `adviceView` for v4, v3 and legacy results, unknown codes, and malformed data.
  - **Prompt and schema:** v3 has no advice fields, `situationNote` comes after the suggestion, and the prompt forbids medical instructions and contact details.
- `npm run build`: succeeds; the bundle contains `analyze.v3` and `advice.v1`.
- **Not done:** a live Gemini call. There is still no key or bucket on this machine.

## Deploy

- **Rules:** no change in this phase.
- **Cloud Run:** redeploy. No new environment variables.
- **After deploy:** submit one report and check:
  - `aiAnalysis.schemaVersion == 4`
  - `aiAnalysis.advice.firstAid` holds codes
  - `aiRun.promptVersion == "analyze.v3"`
  - the card shows "Pending vet review" badges in both languages
