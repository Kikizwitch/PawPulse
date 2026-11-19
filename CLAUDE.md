# PawPulse — 流浪動物即時通報與 AI 救援媒合平台

市民影相通報受傷／流浪動物 → Gemini 分析傷勢同緊急度（P0/P1/P2）→ 按距離、物種、容量配對 NGO → NGO 接手跟進，報案人喺「我的案件」睇進度。

## 語言規範

- **程式註解用廣東話書面語**（例如「唔」「嘅」「喺」「冇」），同現有風格一致。
- **UI 文字唔可以喺元件入面寫死**，一律放 `src/locales/zh.json` 同 `src/locales/en.json`，用 `t('...')` 讀。兩個檔嘅結構必須一致，否則 `satisfies Translation` 會 lint 失敗。
- 用 `utils/caseLabels.ts`（`statusLabel` 等）嘅元件一定要 call `useTranslation()`，否則轉語言唔會即時更新。
- 錯誤狀態儲翻譯 key 而唔係文字，咁中途轉語言都會跟住轉。
- 介面語言由用戶揀（zh / en，存 localStorage `pawpulse-lang`）；地區由瀏覽器判斷。`getApiLang()` 合併兩者（例如 `en-HK`），用嚟做地址搜尋同 Gemini 回應語言。
- Server 錯誤訊息暫時係中文；Firestore collection 名、type 名、API 路徑用英文。

## 技術棧

- **前端**：React 19 + Vite 6 + Tailwind CSS 4 + i18next / react-i18next + `lucide-react` + Leaflet
- **後端**：Express（`server.ts` 放全部 API 路由；共用模組同 AI 流程放 `server/`），部署喺 **Google Cloud Run**（Docker，port 8080）
- **Firebase**：Firestore（**非 default database**）、Cloud Storage、Auth（電郵密碼 + Google 登入）
- **AI**：`@google/genai`（Gemini Developer API，`vertexai: false`），model 寫喺 `server/ai/config.ts` 嘅 `GEMINI_MODEL`；流程見 `docs/ai-pipeline/`
- **寄信**：nodemailer + Gmail SMTP（App Password）；未設定就喺 terminal 模擬
- **地圖／地址**：Google Geocoding + Places API (New)；Nominatim 做 reverse geocode 後備；香港 18 區用政府 ALS API

## 常用指令

```bash
npm install
npm run dev     # tsx server.ts：Express + Vite middleware，http://localhost:3000
npm run lint    # tsc --noEmit
npm test        # vitest run（測 server/ 同 src/utils 純函數，唔使連 Gemini 同 Firebase）
npm run eval    # AI 評估：用 eval-data/（唔入 git）跑分析流程，要 GEMINI_API_KEY；見 docs/ai-pipeline/eval.md
npm run build   # vite build → dist/；esbuild server.ts → server-dist/server.cjs
npm run start   # node server-dist/server.cjs（要 NODE_ENV=production 先會 serve dist/）
npx firebase-tools deploy --only firestore:rules   # 部署 Firestore rules（firebase.json 已指定非 default database）
```

- 本機用 Firebase Admin SDK 前要先 `gcloud auth application-default login`。
- 環境變數放 `.env.local`（優先）或 `.env`。
- **Dockerfile 用 `npm ci --omit=dev`**：server 用到嘅套件（例如 nodemailer）一定要喺 dependencies；改依賴後要 commit `package-lock.json`。

## 用戶身份

| 身份 | 判斷方法 | 可以做 |
|---|---|---|
| user | 已登入，但唔係 admin / ngo | 報案；「我的案件」睇自己報過嘅案件 |
| ngo | Firestore 有 `ngouser/{uid}`（入面有 `ngoId`） | NGO 工作台：接手案件、更新自己機構接手咗嘅案件、睇該案件聯絡資料 |
| admin | Firestore 有 `adminuser/{uid}` | 全部案件同機構；建立／移除 NGO 帳戶 |

- 前端 `AuthContext` 同 server `getAuthInfo` 都係 **fail-closed**：讀取失敗就當普通 user。
- Server 用 `verifyIdToken(token, true)`；移除 NGO 帳戶會 `revokeRefreshTokens`，即刻失效。
- Admin 只可以喺 Firebase Console 手動新增 `adminuser/{uid}` 文件（文件 ID = UID）。
- NGO 帳戶由 admin 喺後台建立，server 寄「設定密碼連結」（`generatePasswordResetLink`），唔會寄明文密碼。每間機構最多 5 個帳戶。
- 報案人帳戶：寄確認信時 server 用報案電郵搵或者建立 Auth 帳戶，案件記入 `usercases/{uid}.caseIds`；新帳戶嘅確認信附設定密碼連結。
- Sidebar 按身份顯示分頁（`ROLE_NAV_ITEM`），冇固定 admin 入口。

## 目錄結構

```
server.ts                  # 全部 API：rate limit、geocode、places、上傳、AI 分析、確認信、NGO 帳戶、接手、更新進度、刪除
server/
  env.ts                   # 讀 .env.local / .env（一定要第一個 import）
  firebaseAdmin.ts         # getAdminDb / getAdminBucket / getAdminAuth
  cases.ts                 # 案件相片常數、casePhotoPaths、loadCasePhotos、isFreshCase
  sanitize.ts              # cleanStr / cleanList
  matching.ts              # NGO 配對排名（計分表）
  aiFeedback.ts            # NGO 對 AI 結果嘅回饋（驗證 + 預測快照）
  ai/                      # AI 分析流程：config、client（時限＋重試）、prompts/、findings（Zod）、validate、triage（規則表）、advice（揀建議規則表）、runLock、pipeline、runRecord、tasks（Cloud Tasks）、quota（Firestore 每日額度）
    eval/                  # 評估 manifest schema 同指標（純函數）
    __tests__/             # vitest
scripts/eval.ts            # npm run eval
eval-data/                 # 評估資料集（相片同報告；gitignore + dockerignore，絕對唔可以入 git）
docs/ai-pipeline/          # AI 架構、各階段改動紀錄、評估方法（eval.md）
src/
  App.tsx                  # 主畫面、tab 切換、報案流程（建立案件 → AI → 確認信）、接手／更新進度
  i18n.ts                  # i18next 設定、getAppLang / getBrowserRegion / getApiLang
  locales/zh.json, en.json # 全部 UI 文字
  firebase.ts              # client SDK 初始化（讀 firebase-applet-config.json）
  types.ts                 # StrayReport / CasePhoto / CaseAcceptance / NGOOrganization / UserProfile 等
  contexts/AuthContext.tsx # 登入、身份判斷（adminuser / ngouser）
  services/
    caseService.ts         # Firestore 讀寫、fetchCaseMatches、acceptCase / updateCaseStatus / subscribeToMyCaseIds / subscribeToCase
    api.ts                 # apiFetch：自動帶 Firebase ID token + VITE_API_BASE_URL
    places.ts              # 地址自動完成
  components/              # ReportForm、MyCases、NgoWorkspace、AdminDashboard、LoginModal、Sidebar、PhotoGallery 等
  utils/                   # imageCompressor、casePhotos、caseLabels、location、locale
  config/emergency.ts      # 各地區緊急熱線（按地區，唔按語言）
  config/adviceLibrary.ts  # 建議庫代碼同獸醫審核狀態（server 同前端共用）
  config/ngoCapabilities.ts # NGO 能力清單（server、前端、firestore.rules 共用同一份）
  hooks/useCaseMatches.ts  # 案件 NGO 配對（call server 嘅 /matches）
firestore.rules / storage.rules   # 安全規則（核心安全邏輯）
firebase-blueprint.json    # Firestore 資料結構說明（文件，code 唔會讀）
security_spec.md           # 威脅模型（Dirty Dozen payloads）
```

## Firestore 資料結構

| 路徑 | 讀 | 寫 |
|---|---|---|
| `case/{caseId}` | 公開 | 新建：任何人（嚴格驗證）；更新／刪除：admin；NGO 接手同更新進度經 server API |
| `case/{caseId}/private/contact` | admin、接手咗嘅 NGO | 只可以同案件喺同一個 batch 新建 |
| `case/{caseId}/private/aiRun` | admin | 只限 server（AI 原始回應、model、prompt 版本、延遲、token） |
| `case/{caseId}/private/aiFeedback` | admin、接手咗嘅 NGO | 只限 server（`POST /api/cases/:caseId/ai-feedback`，權限同更新進度一樣） |
| `ngodatail/{ngoId}` | 公開 | admin（`capabilities` 要係認得嘅值） |
| `adminuser/{uid}` | 本人 | **禁止**（只可以喺 Console 手動新增） |
| `ngouser/{uid}` | 本人、admin | 只限 server |
| `usercases/{uid}` | 本人 | 只限 server |
| `serverLocks/{kind}_{caseId}` | — | 只限 server |
| `aiQuota/{UTC 日期}` | — | 只限 server（AI 每日額度，所有 instance 共用） |

## 報案流程（改動前必讀）

1. `ReportForm` 生成 Case ID：`PW-<base36 時間>-<4 位隨機>`（storage.rules：資料夾 `^PW-[A-Z0-9]{1,20}-[A-Z0-9]{1,8}$`、檔名 `^[0-4][.]jpg$`）。
2. 最多 5 張相，經 `compressImage` 轉成 JPEG（≤1280px），用 `uploadCasePhotos` 上傳去 `animal-reports/{caseId}/{0-4}.jpg`；失敗就 fallback 去 `POST /api/upload-photo`（帶 `index`）。第 1 張係封面，同時寫入 `photoUrl` / `storagePath`；全部相寫入 `photos[]`。
3. `createCaseInFirestore` 用 **writeBatch** 同時寫 `case/{id}` 同 `private/contact`。Rules 強制：`status == 'pending'`、`urgency == 'P1'`、`createdAt == request.time`、`aiAnalysis` / `geminiResponse` / `dispatchedToNGO` 係 null、唔可以有 `acceptedBy`。
4. `POST /api/cases/:caseId/analyze`：有設定 Cloud Tasks 就 `queueAnalysis` → `aiStatus = queued`、排 task、回 **202**；Cloud Tasks call `POST /api/internal/tasks/analyze`（OIDC 驗證）→ `analyzeCase(caseId, 'create')`（`server/ai/pipeline.ts`；修改案件用 `'edit'`）：由 Storage 讀全部相（唔信前端傳嘅圖）→ Gemini（每次 30 秒時限，暫時性錯誤最多試 3 次）→ Zod 驗證 → triage → 寫 `aiAnalysis`、`urgency`、`aiStatus = done`，再寫 `private/aiRun`。暫時性失敗 handler 回 503，由 Cloud Tasks 重試。前端用 `subscribeToCase`（onSnapshot）等結果，顯示「分析中」。冇設定 Cloud Tasks（本機）或者排唔到隊，就喺 request 入面直接分析。
5. `POST /api/cases/send-confirmation-email`：server 由 `private/contact` 讀電郵（唔信前端）→ `linkCaseToReporter` 搵／建帳戶並寫 `usercases` → 寄確認信。開帳戶失敗都照寄信。
6. NGO `POST /api/cases/:caseId/accept`：transaction 防止兩間機構同時接手 → 寫 `acceptedBy`、狀態轉 `in_progress` → 寄信通知報案人（附機構公開資料）。
7. `POST /api/cases/:caseId/status`：admin 可以改任何案件；NGO 只可以改自己機構接手咗嘅，而且唔可以改返 `pending`。

**15 分鐘時限**：AI 分析、確認信、報案人派送 NGO 都只可以喺案件建立後 15 分鐘內做（修改觸發嘅 AI 分析由修改時間起計）。確認信同派送每宗案件只做一次（`claimOnce` 用 `serverLocks`）；AI 分析用 `server/ai/runLock.ts` 嘅鎖，暫時性失敗會釋放，每宗案件每種觸發最多分析 3 次。

## AI 架構（改 AI 相關程式之前必讀）

原則：**Gemini 只做觀察，程式決定緊急度，建議用審核過嘅內容。** 詳細見 `docs/ai-pipeline/README.md`。

| 層 | 負責 | 檔案 | 版本 |
|---|---|---|---|
| 觀察 | Gemini 回傳 Gate（見唔見到動物、相用唔用得、物種）同觀察（意識、出血、呼吸等，每項都可以 `unknown`）＋相片證據 | `server/ai/prompts/analyze.vN.ts`、`findings.ts`（Zod） | `PROMPT_VERSION` |
| 決定 | 規則表計 P0/P1/P2、原因代碼、`needsHumanReview`；P0 一定要有相片證據 | `server/ai/triage.ts` | `RULES_VERSION` |
| 建議 | 按觀察喺建議庫揀代碼（逐條有獸醫審核狀態） | `server/ai/advice.ts`、`src/config/adviceLibrary.ts` | `ADVICE_LIBRARY_VERSION` |
| 配對 | 需要嘅 NGO 能力、物種唔一致；server 排名 | `server/ai/capabilities.ts`、`server/matching.ts` | `MATCHING_RULES_VERSION`、`MATCHING_VERSION` |
| 執行 | 時限＋重試、分析鎖、Cloud Tasks、每日額度、`aiStatus` | `client.ts`、`runLock.ts`、`tasks.ts`、`quota.ts`、`pipeline.ts` | — |
| 紀錄 | 每次分析寫 `private/aiRun`；NGO 回饋寫 `private/aiFeedback` | `runRecord.ts`、`server/aiFeedback.ts` | `SCHEMA_VERSION`（`aiAnalysis.schemaVersion`） |

- `runAnalysis`（`pipeline.ts`）唔讀寫 Firestore：production 同評估用同一個函數。`analyzeCase` 先至處理鎖、額度、寫入。
- **改 prompt、response schema、triage／建議／配對規則或者 `GEMINI_MODEL`，一定要用 `npm run eval` 喺同一個資料集比較改之前同改之後**（報告有資料集 sha256）；主要指標係 **P0 漏判率（P0 under-triage）**，唔可以變差。發佈前可以用 `npm run eval -- --max-p0-under-triage 0`。
- 改咗就要升版本號（prompt 開新檔；規則表改 `*_VERSION`；儲存格式改 `SCHEMA_VERSION`），咁 `aiRun`、`aiFeedback` 同評估報告先對得返。
- 評估資料集（`eval-data/`）有動物相片，**唔可以入 git**；範本：`docs/ai-pipeline/eval-manifest.example.json`。

## 重要規則同注意事項

- **改 Case 欄位要同步**：`src/types.ts`、`firestore.rules`（`isValidCase` 嘅 `hasOnly` 白名單）、`caseService.ts`（`casePayload` 同 `docToReport`）、`firebase-blueprint.json`。漏咗 rules 會令成個 batch 寫入失敗。
- `CaseStatus` 只可以係 `pending | in_progress | rescued | closed`；`AnimalType` 係 `cat | dog | bird | other`。
- **NGO 配對喺 server 做**：`GET /api/cases/:caseId/matches`（`server/matching.ts` 計分表 + `server/ai/capabilities.ts` 由觀察推算需要嘅能力），前端用 `useCaseMatches`，唔可以再喺前端排名。`specialties` 係自由文字只作顯示；配對用 `capabilities`（清單改咗要同步 `src/config/ngoCapabilities.ts`、`firestore.rules`、locales `capability.*`，`npm test` 會檢查）。AI 物種同報案人揀嘅唔同，配對時兩個都考慮。
- 報案人聯絡資料**絕對唔可以**放入公開嘅 `case` 文件；`acceptedBy` 都唔可以放 NGO 職員電郵。
- NGO 登入電郵放 `ngouser`，公開電郵放 `ngodatail.publicEmail`，兩者分開。
- **Gemini 只做觀察，程式決定緊急度**：AI 輸出由 Zod（`server/ai/findings.ts` + `prompts/analyze.vN.ts`）定義同驗證，任何欄位唔啱就成個結果唔用；P0/P1/P2 由 `server/ai/triage.ts` 嘅規則表決定（規則表待獸醫審核）。報案描述、標籤、相入面嘅文字都唔可以降低等級，亦唔可以單獨令案件變 P0（P0 一定要有相片證據）。
- 加新原因代碼或者觀察值，要同時加 `zh.json` / `en.json` 嘅 `triage.reason.*` / `aiFindings.*`（`npm test` 會檢查）。前端顯示 AI 結果用 `src/utils/aiAnalysis.ts`，新舊格式都處理到。
- **建議唔再由 AI 寫**：急救、裝備、注意事項由 `server/ai/advice.ts` 按觀察喺建議庫（`src/config/adviceLibrary.ts` + locales `advice.*`）揀代碼，案件只存代碼。每條有審核狀態，未經獸醫審核嘅前端會標「待獸醫審核」；改咗文字要將狀態改返 `pending_vet_review`。AI 最多寫一句 `aiNote`（有電話／網址／電郵就唔用），前端標明係 AI 生成。建議入面唔可以有電話號碼。
- Prompt 放 `server/ai/prompts/analyze.vN.ts`，改 prompt 或 response schema 要開新版本，唔好改舊版（`private/aiRun.promptVersion` 先對得返）。
- AI 失敗或者超出 `AI_DAILY_LIMIT` 唔可以阻止報案，案件維持 P1；相片未分析就維持模糊。
- 新 AI 結果唔再寫 `geminiResponse`，亦唔再有 `confidenceScore`（改用 `uncertainty`）；`aiAnalysis.schemaVersion` 冇 = 1、2 = Phase 1、3 = 觀察 + triage、4 = 建議庫代碼 + aiNote、5 = matching。前端全部版本都要識顯示。
- Rate limiter 係**記憶體內、每個 Cloud Run instance 各自計**；`windowSeconds` 唔好超過 600。AI 每日額度改用 Firestore `aiQuota/{UTC 日期}`（transaction），所有 instance 共用。
- `aiStatus`（`queued | running | done | failed | skipped`）只由 server 寫；只會改由 server 負責緊（queued / running）嘅案件。前端用 `isAiPending()`，超過 20 分鐘仍然 queued / running 就當冇回應。
- `config/emergency.ts`：只加入親自核實過嘅熱線號碼，打錯緊急熱線比冇更危險。
- `vite.config.ts` 嘅 `allowedHosts: true` / `hmr: false` 係 AI Studio 預覽需要，只影響 dev server。
- 未定義嘅 `/api/*` 一律回 JSON 404。
- 設定密碼連結用 `PUBLIC_BASE_URL` 做 continue URL，該網域要加入 Firebase Authentication → Authorized domains。

## 未完成／模擬中

- **NGO 派送**（`/api/ngo/notify`）目前只係 `console.log` 模擬（`simulated: true`），有 `TODO` 標記。
- 未設定 `GMAIL_*` 時，全部電郵只會印喺 terminal（**包括設定密碼連結，production 一定要設定**）。
- `GET /api/ngos` 回傳空陣列；前端直接由 Firestore 讀 NGO。
- 自動化測試只覆蓋 `server/` 嘅純函數同 `src/utils`（vitest）；Express route、rules 同 React 元件未有測試。Rules 用 `npx firebase-tools deploy --only firestore:rules`（或 `--only storage`）部署，部署前可以加 `--dry-run` 檢查語法。
- AI 分析仍然要瀏覽器 call `/analyze` 先會排隊（案件由前端直接寫入 Firestore，server 唔知有新案件）；報案人寫完案件即刻關閉網頁就唔會分析，案件維持 P1。
- dev 同 PRD 共用同一個 Firestore 同 Storage，Publish rules 會即刻影響 PRD。

## 環境變數（Cloud Run）

| 變數 | 用途 |
|---|---|
| `GEMINI_API_KEY` | Gemini（Secret Manager：`gemini-api-key`） |
| `GOOGLE_MAPS_API_KEY` | Geocoding 同 Places（Secret Manager：`google-maps-api-key`） |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Gmail SMTP 寄信；App Password 要放 Secret Manager |
| `FIREBASE_PROJECT_ID` / `FIRESTORE_DATABASE_ID` / `FIREBASE_STORAGE_BUCKET` | Admin SDK。**`FIRESTORE_DATABASE_ID` 一定要設**，值同 `firebase-applet-config.json` 嘅 `firestoreDatabaseId` 一樣 |
| `PUBLIC_BASE_URL` | 電郵入面嘅連結（防 Host header 偽造），每個 service 填自己嘅網址 |
| `AI_DAILY_LIMIT` | 全部 instance 合計每日 AI 分析上限（預設 500；按案件計，重試唔再扣；UTC 換日） |
| `AI_TIMEOUT_MS` | 每次 Gemini 請求時限（可選，預設 30000，範圍 5000–120000）；總時限 = 2.5 倍 |
| `AI_OBSERVE_TWICE` | 可選，`1` = 每宗案件分析兩次，唔一致就用較高等級並要人手覆核（token 成本加倍） |
| `AI_TASKS_QUEUE` | Cloud Tasks queue：`projects/{project}/locations/{region}/queues/{queue}`；三個 `AI_TASKS_*` 齊晒先用 Cloud Tasks，否則喺 request 入面直接分析 |
| `AI_TASKS_SERVICE_ACCOUNT` | Cloud Tasks 簽 OIDC token 用嘅服務帳戶；handler 會核對 |
| `AI_TASKS_HANDLER_URL` | Cloud Tasks call 嘅網址（Cloud Run `run.app` 網址 + `/api/internal/tasks/analyze`）；預設用 `PUBLIC_BASE_URL` 砌 |
| `EVAL_PRICE_INPUT_PER_M` / `EVAL_PRICE_OUTPUT_PER_M` | 只限本機 `npm run eval`：model 每 100 萬 token 價錢（USD），用嚟估算成本 |
| `EXTRA_CORS_ORIGINS` | 額外 CORS 來源（逗號分隔） |
| `VITE_API_BASE_URL` | **Build 時**注入（Docker `ARG`）；網頁版留空，手機 app 填 Cloud Run 網址 |

一般變數：`gcloud run services update <服務> --region asia-northeast1 --update-env-vars KEY=VALUE`
Secret：`gcloud run services update <服務> --region asia-northeast1 --update-secrets KEY=secret-name:latest`（服務帳戶要有 `roles/secretmanager.secretAccessor`）
