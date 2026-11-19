// 一定要第一個 import：先讀 .env.local / .env，其他模組先讀到環境變數
import "./server/env";
import express, { NextFunction, Request, Response } from "express";
import path from "path";
import { randomUUID } from "crypto";
import nodemailer, { Transporter } from "nodemailer";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { LOCALES, DEFAULT_LANG as APP_DEFAULT_LANG, toAppLang, type AppLang } from "./src/locales";
import { STORAGE_BUCKET, getAdminAuth, getAdminBucket, getAdminDb } from "./server/firebaseAdmin";
import {
  ALLOWED_ANIMAL_HINTS,
  MAX_CASE_PHOTOS,
  MAX_PHOTO_BYTES,
  MAX_STORED_PHOTOS,
  PHOTO_FILE_RE,
  casePhotoPaths,
  isFreshCase,
} from "./server/cases";
import { cleanStr } from "./server/sanitize";
import { GEMINI_MODEL, TASKS_ENABLED, getGeminiApiKey } from "./server/ai/config";
import { analyzeCase, queueAnalysis, type SkipReason } from "./server/ai/pipeline";
import { parseTaskPayload, verifyTaskRequest } from "./server/ai/tasks";
import { deriveMatching } from "./server/ai/capabilities";
import { MATCHING_VERSION, rankNgos, toMatchNgo, type MatchNgo } from "./server/matching";
import { parseFeedback, predictionSnapshot } from "./server/aiFeedback";
import type { UrgencyLevel } from "./src/types";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

// 部署喺 Cloud Run 等反向代理後面，信任第一層 proxy（令 req.ip 係真實用戶 IP）
app.set("trust proxy", 1);

// ===== CORS：容許將來 iOS / Android app（Capacitor）呼叫 API =====
const ALLOWED_ORIGINS = new Set([
  "capacitor://localhost", // iOS app
  "https://localhost",     // Android app
  ...(process.env.EXTRA_CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
]);
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept-Language");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const NOMINATIM_USER_AGENT = "PawPulse-RescuePlatform/1.0 (contact@pawpulse.app)";

// ---------- Rate limiting ----------

class SlidingWindowLimiter {
  private inMemoryStore = new Map<string, number[]>();

  constructor() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, timestamps] of this.inMemoryStore.entries()) {
        const active = timestamps.filter((ts) => now - ts < 10 * 60 * 1000);
        if (active.length === 0) this.inMemoryStore.delete(key);
        else this.inMemoryStore.set(key, active);
      }
    }, 10 * 60 * 1000).unref();
  }

  // ⚠️ windowSeconds 唔好超過 600（10 分鐘），因為上面嘅清理會刪走 10 分鐘前嘅紀錄
  async isAllowed(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const timestamps = (this.inMemoryStore.get(key) || []).filter((ts) => now - ts < windowMs);

    if (timestamps.length >= limit) {
      this.inMemoryStore.set(key, timestamps);
      return { allowed: false, remaining: 0 };
    }

    timestamps.push(now);
    this.inMemoryStore.set(key, timestamps);
    return { allowed: true, remaining: limit - timestamps.length };
  }
}
const rateLimiter = new SlidingWindowLimiter();

function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

// messageKey = locales JSON 入面 server.errors.* 嘅 key
function makeRateLimit(prefix: string, limit: number, windowSeconds: number, messageKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { allowed, remaining } = await rateLimiter.isAllowed(`${prefix}_${getClientIp(req)}`, limit, windowSeconds);
    res.setHeader("X-RateLimit-Remaining", remaining);
    if (!allowed) {
      res.status(429).json({ error: errMsg(req, messageKey) });
      return;
    }
    next();
  };
}

const aiRateLimitMiddleware = makeRateLimit("ai", 15, 60, "rateAi");
const uploadRateLimitMiddleware = makeRateLimit("upload", 20, 60, "rateUpload");
const geocodeRateLimitMiddleware = makeRateLimit("geocode", 30, 60, "rateGeocode");
const placesRateLimitMiddleware = makeRateLimit("places", 60, 60, "ratePlaces");
const emailIpRateLimitMiddleware = makeRateLimit("email_ip", 10, 300, "rateEmail");
const dispatchRateLimitMiddleware = makeRateLimit("dispatch", 10, 300, "rateDispatch");
const adminRateLimitMiddleware = makeRateLimit("admin", 60, 60, "rateAction");
const caseActionRateLimitMiddleware = makeRateLimit("case_action", 30, 60, "rateAction");

// AI 每日總上限：見 server/ai/quota.ts（按案件計）

function maskEmail(email: string): string {
  return email.replace(/^(.).*(@.*)$/, "$1***$2");
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Firebase Admin（Firestore + Storage + Auth）：見 server/firebaseAdmin.ts
// 案件相片常數、casePhotoPaths、loadCasePhotos、isFreshCase：見 server/cases.ts

const CASE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UID_RE = /^[A-Za-z0-9]{1,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NGO_ACCOUNTS = 5; // 每間機構最多幾多個登入帳戶
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 報案人 24 小時內可以改
const MAX_REPORTER_EDITS = 1;               // 只可以改 1 次
const TAG_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
// 原因／類別嘅顯示名放喺 locales JSON：server.labels.deleteReason.* / server.labels.contactCategory.*
const DELETE_REASONS = new Set(["duplicate", "resolved", "wrong_info", "privacy", "mistake", "other"]);
const NORMAL_STATUSES = ["pending", "in_progress", "rescued", "closed"];
const CONTACT_CATEGORIES = new Set(["update", "delete", "photo", "status", "other"]);

// 優先用固定網址，防止有人偽造 Host header 令電郵出現釣魚連結
function getPublicBaseUrl(req: Request): string {
  const fallbackBase = `${req.protocol}://${req.get("host") || "localhost:3000"}`;
  return (process.env.PUBLIC_BASE_URL || fallbackBase).replace(/\/$/, "");
}

// ---------- 寄信（Gmail SMTP；未設定就模擬，喺 terminal 印出）----------

const GMAIL_USER = (process.env.GMAIL_USER || "").trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");

let mailer: Transporter | null = null;
function getMailer(): Transporter | null {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  if (!mailer) {
    mailer = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return mailer;
}

const MAIL_FROM_NAME = (process.env.MAIL_FROM_NAME || "PawPulse 管理員").trim();

// ---------- i18n：同前端共用 src/locales/*.json ----------
// 只支援 {{變數}}，唔支援 i18next 嘅 _one / _other 複數 key
function tr(lang: AppLang, key: string, vars: Record<string, unknown> = {}): string {
  const pick = (obj: unknown) =>
    key.split(".").reduce<any>((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
  const s = pick(LOCALES[lang].translation) ?? pick(LOCALES[APP_DEFAULT_LANG].translation);
  if (typeof s !== "string") return key;
  return s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, v) => String(vars[v] ?? ""));
}

// 搵唔到翻譯就用 fallback（例如資料庫入面有未知狀態）
function trOr(lang: AppLang, key: string, fallback: string, vars?: Record<string, unknown>): string {
  const s = tr(lang, key, vars);
  return s === key ? fallback : s;
}

function statusLabel(lang: AppLang, status: string): string {
  return trOr(lang, `status.${status}`, status);
}

// request 嘅語言：前端明確傳入嘅 lang → Accept-Language header → 中文
function reqLang(req: Request, explicit?: unknown): AppLang {
  return toAppLang(resolveLang(req, explicit ?? req.body?.lang ?? req.query?.lang));
}

// API 錯誤訊息：server.errors.{key}
function errMsg(req: Request, key: string, vars?: Record<string, unknown>): string {
  return tr(reqLang(req), `server.errors.${key}`, vars);
}

async function sendMail(
  to: string,
  subject: string,
  text: string,
  opts: { replyTo?: string } = {}
): Promise<{ simulated: boolean }> {
  const m = getMailer();
  if (!m) {
    // ⚠️ 只係本機測試用：內容（包括設定密碼連結）會印喺 log，正式環境一定要設定 GMAIL_*
    console.log(`[EMAIL - SIMULATED] → ${maskEmail(to)} | ${subject}\n${text}\n`);
    return { simulated: true };
  }
  await m.sendMail({
    from: { name: MAIL_FROM_NAME, address: GMAIL_USER },
    to,
    subject,
    text,
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
  });
  console.log(`[EMAIL] sent → ${maskEmail(to)} | ${subject}`);
  return { simulated: false };
}

// ---------- 登入身份 ----------
// admin：Firestore 有 adminuser/{uid} 文件
// ngo：Firestore 有 ngouser/{uid} 文件（入面有 ngoId）
// 其他：普通 user；任何讀取失敗都當普通 user（fail-closed）

type AuthRole = "user" | "ngo" | "admin";

interface AuthInfo {
  uid: string;
  email: string | null;
  role: AuthRole;
  ngoId: string | null;
}

async function getAuthInfo(req: Request): Promise<AuthInfo | null> {
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) return null;

  let decoded;
  try {
    // 第二個參數 true：已撤銷嘅 token（例如被移除嘅 NGO 帳戶）即刻失效
    decoded = await getAdminAuth().verifyIdToken(m[1], true);
  } catch {
    return null;
  }
  const base = { uid: decoded.uid, email: decoded.email ?? null };

  try {
    const db = getAdminDb();
    const [adminDoc, ngoDoc] = await Promise.all([
      db.collection("adminuser").doc(decoded.uid).get(),
      db.collection("ngouser").doc(decoded.uid).get(),
    ]);
    if (adminDoc.exists) return { ...base, role: "admin", ngoId: null };

    const ngoId = ngoDoc.exists ? ngoDoc.data()?.ngoId : null;
    if (typeof ngoId === "string" && CASE_ID_RE.test(ngoId)) {
      return { ...base, role: "ngo", ngoId };
    }
  } catch (err) {
    console.warn("[Auth] role check failed:", (err as Error).message);
  }
  return { ...base, role: "user", ngoId: null };
}

// 每宗案件每種動作只可以做一次（create 遇到已存在嘅文件會失敗，所以係原子操作）
// 用喺確認信同派送；AI 分析改用 server/ai/runLock.ts（暫時性失敗可以再試）
async function claimOnce(kind: string, caseId: string): Promise<boolean> {
  try {
    await getAdminDb()
      .collection("serverLocks")
      .doc(`${kind}_${caseId}`)
      .create({ createdAt: FieldValue.serverTimestamp() });
    return true;
  } catch (err: any) {
    if (err?.code === 6) return false; // ALREADY_EXISTS
    throw err;
  }
}

// Gemini client、model、時限同重試：見 server/ai/

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/ai/status", (_req: Request, res: Response) => {
  const key = getGeminiApiKey();
  res.json({
    status: key ? "configured" : "missing_key",
    hasApiKey: !!key,
    model: GEMINI_MODEL,
  });
});

// ---------- 語言（跟市民瀏覽器）----------

const DEFAULT_LANG = "zh-HK";
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

// 優先次序：前端明確傳入 → Accept-Language header → 繁體中文
function resolveLang(req: Request, explicit?: unknown): string {
  if (typeof explicit === "string" && LANG_RE.test(explicit)) return explicit;
  const header = req.headers["accept-language"];
  const first = typeof header === "string" ? header.split(",")[0]?.split(";")[0]?.trim() : "";
  return first && LANG_RE.test(first) ? first : DEFAULT_LANG;
}

// "en-GB" → "GB"、"zh-Hant-HK" → "HK"；冇地區部分就回傳 undefined
function regionFromLang(lang: string): string | undefined {
  const region = lang.split("-").find((p, i) => i > 0 && /^[A-Za-z]{2}$/.test(p));
  return region?.toUpperCase();
}

// ---------- 區名判斷（全球通用 + 香港 18 區加強）----------

type AddrComp = { long: string; short: string; types: string[] };

// 由細到大：區 → 城市 → 縣／郡 → 省／州
const AREA_TYPE_PRIORITY = [
  "sublocality_level_1",
  "sublocality",
  "locality",
  "postal_town",
  "administrative_area_level_3",
  "administrative_area_level_2",
  "administrative_area_level_1",
];

function fromGeocodingComponents(list: unknown): AddrComp[] {
  if (!Array.isArray(list)) return [];
  return list.map((c: any) => ({
    long: String(c?.long_name ?? ""),
    short: String(c?.short_name ?? ""),
    types: Array.isArray(c?.types) ? c.types : [],
  }));
}

function fromPlacesComponents(list: unknown): AddrComp[] {
  if (!Array.isArray(list)) return [];
  return list.map((c: any) => ({
    long: String(c?.longText ?? ""),
    short: String(c?.shortText ?? ""),
    types: Array.isArray(c?.types) ? c.types : [],
  }));
}

function pickArea(components: AddrComp[]): { district?: string; countryCode?: string } {
  const country = components.find((c) => c.types.includes("country"));
  const countryCode = country?.short ? country.short.toUpperCase() : undefined;
  for (const type of AREA_TYPE_PRIORITY) {
    const hit = components.find((c) => c.types.includes(type) && c.long);
    if (hit) return { district: hit.long, countryCode };
  }
  return { district: country?.long || undefined, countryCode };
}

// 香港：用政府 ALS 地址查詢服務攞 18 區準確區名（免費、免 key）
type AlsDistrict = { chi?: string; eng?: string };
const alsCache = new Map<string, AlsDistrict | null>();

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

async function lookupHkDistrict(address: string, lang: string): Promise<string | undefined> {
  const q = address.replace(/\s+/g, " ").trim().slice(0, 150);
  if (q.length < 2) return undefined;

  let hit = alsCache.get(q);
  if (hit === undefined) {
    try {
      const r = await fetch(`https://www.als.gov.hk/lookup?q=${encodeURIComponent(q)}&n=1`, {
        headers: { Accept: "application/xml" },
        signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) return undefined;
      const xml = await r.text();
      const score = Number(xml.match(/<Score>([\d.]+)<\/Score>/)?.[1] ?? 0);
      const chi = xml.match(/<ChiDistrict>\s*<DcDistrict>([^<]+)<\/DcDistrict>/)?.[1]?.trim();
      const eng = xml.match(/<EngDistrict>\s*<DcDistrict>([^<]+)<\/DcDistrict>/)?.[1]?.trim();
      hit = score >= 40 && (chi || eng) ? { chi, eng: eng ? titleCase(eng) : undefined } : null;
      if (alsCache.size > 2000) alsCache.clear();
      alsCache.set(q, hit);
    } catch (err) {
      console.warn("[ALS] 香港地區查詢失敗:", (err as Error).message);
      return undefined;
    }
  }
  if (!hit) return undefined;
  return lang.toLowerCase().startsWith("zh") ? hit.chi || hit.eng : hit.eng || hit.chi;
}

async function resolveArea(
  components: AddrComp[],
  lang: string,
  alsQueries: Array<string | undefined>
): Promise<{ district?: string; countryCode?: string }> {
  const area = pickArea(components);
  if (area.countryCode === "HK") {
    for (const q of alsQueries) {
      if (!q) continue;
      const d = await lookupHkDistrict(q, lang);
      if (d) return { ...area, district: d };
    }
  }
  return area;
}

// 移除 Google 有時會加喺地址前面嘅 Plus Code（例如「8QF6+XX」）
function stripPlusCode(s: string): string {
  return s
    .replace(/\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b/gi, "")
    .replace(/^[\s,，]+/, "")
    .trim();
}

// ---------- Geocoding（全球）----------

function getGoogleMapsApiKey(): string | undefined {
  return process.env.GOOGLE_MAPS_API_KEY;
}

app.get("/api/geocode", geocodeRateLimitMiddleware, async (req: Request, res: Response) => {
  const address = typeof req.query.address === "string" ? req.query.address.trim().slice(0, 200) : "";
  if (!address) {
    res.status(400).json({ error: errMsg(req, "missingAddress") });
    return;
  }

  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    console.error("[Geocode] GOOGLE_MAPS_API_KEY not set in environment");
    res.status(500).json({ error: errMsg(req, "geocodeNotConfigured") });
    return;
  }

  const lang = resolveLang(req, req.query.lang);

  try {
    // 唔設 region，讓 Google 自行判斷全球地址；只設 language 控制回傳語言
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("language", lang);
    url.searchParams.set("key", apiKey);

    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const data: any = await response.json();

    if (data.status !== "OK" || !data.results?.length) {
      console.warn("[Geocode] No results:", data.status, data.error_message);
      res.status(404).json({ error: errMsg(req, "addressNotFound"), status: data.status });
      return;
    }

    const result = data.results[0];
    const { lat, lng } = result.geometry.location;
    const formattedAddress = stripPlusCode(String(result.formatted_address ?? address)) || address;
    const area = await resolveArea(fromGeocodingComponents(result.address_components), lang, [formattedAddress, address]);

    res.json({
      lat,
      lng,
      formattedAddress,
      locationType: result.geometry.location_type,
      district: area.district,
      countryCode: area.countryCode,
    });
  } catch (error) {
    console.error("[Geocode] Error:", (error as Error).message);
    res.status(500).json({ error: errMsg(req, "geocodeFailed") });
  }
});

app.get("/api/reverse-geocode", geocodeRateLimitMiddleware, async (req: Request, res: Response) => {
  const lat = parseFloat(String(req.query.lat));
  const lng = parseFloat(String(req.query.lng));

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: errMsg(req, "badLatLng") });
    return;
  }

  const lang = resolveLang(req, req.query.lang);
  const googleKey = getGoogleMapsApiKey();

  if (googleKey) {
    try {
      const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      url.searchParams.set("latlng", `${lat},${lng}`);
      url.searchParams.set("language", lang);
      url.searchParams.set("key", googleKey);

      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const data: any = await r.json();
      const best = data.results?.find((x: any) => !x.types?.includes("plus_code")) ?? data.results?.[0];

      if (data.status === "OK" && best) {
        const address =
          stripPlusCode(String(best.formatted_address ?? "")) ||
          tr(toAppLang(lang), "server.misc.coordAddress", { lat: lat.toFixed(4), lng: lng.toFixed(4) });
        const area = await resolveArea(fromGeocodingComponents(best.address_components), lang, [address]);
        res.json({ address, district: area.district, countryCode: area.countryCode, provider: "google" });
        return;
      }
      console.warn("Google Reverse Geocoding API 回傳非 OK 狀態:", data.status);
    } catch (err) {
      console.warn("Google Reverse Geocoding 失敗，改用 Nominatim:", (err as Error).message);
    }
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const r = await fetch(url, {
      headers: { "User-Agent": NOMINATIM_USER_AGENT, "Accept-Language": lang },
      signal: AbortSignal.timeout(6000),
    });
    const data: any = await r.json();
    if (data?.display_name) {
      const a = data.address ?? {};
      const countryCode = typeof a.country_code === "string" ? a.country_code.toUpperCase() : undefined;
      let district: string | undefined =
        a.city_district || a.borough || a.suburb || a.city || a.town || a.village || a.county || a.state || a.country;
      if (countryCode === "HK") {
        district = (await lookupHkDistrict(data.display_name, lang)) || district;
      }
      res.json({ address: data.display_name, district, countryCode, provider: "nominatim" });
      return;
    }
  } catch (err) {
    console.error("Nominatim reverse fallback 失敗:", (err as Error).message);
  }

  res.status(404).json({ error: errMsg(req, "addressNotFound") });
});

// ---------- 地址自動完成（Google Places API New，全球）----------

function getPlacesApiKey(): string | undefined {
  return process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
}

const PLACES_SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

app.post("/api/places/autocomplete", placesRateLimitMiddleware, async (req: Request, res: Response) => {
  const apiKey = getPlacesApiKey();
  if (!apiKey) {
    res.status(503).json({ error: errMsg(req, "placesNotConfigured") });
    return;
  }

  const input = typeof req.body?.input === "string" ? req.body.input.trim().slice(0, 100) : "";
  if (input.length < 2) {
    res.json({ suggestions: [] });
    return;
  }

  const lang = resolveLang(req, req.body?.lang);
  const regionCode = regionFromLang(lang);
  const rawToken = req.body?.sessionToken;
  const sessionToken = typeof rawToken === "string" && PLACES_SESSION_RE.test(rawToken) ? rawToken : undefined;

  // 唔限制國家：有已確認位置就優先附近結果；冇就靠瀏覽器語言嘅地區碼做大概估計
  const body: Record<string, unknown> = {
    input,
    languageCode: lang,
    ...(regionCode && { regionCode }),
    ...(sessionToken && { sessionToken }),
  };
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 10000 } };
  }

  try {
    const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      console.error("[Places] autocomplete HTTP", r.status, await r.text().catch(() => ""));
      res.status(502).json({ error: errMsg(req, "placesUnavailable") });
      return;
    }
    const data: any = await r.json();
    const suggestions = (data.suggestions ?? [])
      .map((s: any) => s.placePrediction)
      .filter((p: any) => p?.placeId)
      .slice(0, 5)
      .map((p: any) => ({
        placeId: String(p.placeId),
        mainText: String(p.structuredFormat?.mainText?.text ?? p.text?.text ?? ""),
        secondaryText: String(p.structuredFormat?.secondaryText?.text ?? ""),
      }));
    res.json({ suggestions });
  } catch (err) {
    console.error("[Places] autocomplete failed:", (err as Error).message);
    res.status(502).json({ error: errMsg(req, "placesUnavailable") });
  }
});

app.get("/api/places/details/:placeId", placesRateLimitMiddleware, async (req: Request, res: Response) => {
  const apiKey = getPlacesApiKey();
  if (!apiKey) {
    res.status(503).json({ error: errMsg(req, "placesNotConfigured") });
    return;
  }

  const placeId = String(req.params.placeId ?? "");
  if (!PLACE_ID_RE.test(placeId)) {
    res.status(400).json({ error: errMsg(req, "badPlace") });
    return;
  }

  const lang = resolveLang(req, req.query.lang);
  const regionCode = regionFromLang(lang);

  const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`);
  url.searchParams.set("languageCode", lang);
  if (regionCode) url.searchParams.set("regionCode", regionCode);
  const token = req.query.sessionToken;
  if (typeof token === "string" && PLACES_SESSION_RE.test(token)) url.searchParams.set("sessionToken", token);

  try {
    const r = await fetch(url, {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "id,formattedAddress,location,displayName,addressComponents",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      console.error("[Places] details HTTP", r.status, await r.text().catch(() => ""));
      res.status(502).json({ error: errMsg(req, "placeDetailsFailed") });
      return;
    }
    const d: any = await r.json();
    const lat = d.location?.latitude;
    const lng = d.location?.longitude;
    if (typeof lat !== "number" || typeof lng !== "number") {
      res.status(502).json({ error: errMsg(req, "placeNoCoords") });
      return;
    }
    const address = String(d.formattedAddress ?? "");
    const name = String(d.displayName?.text ?? "");
    const area = await resolveArea(fromPlacesComponents(d.addressComponents), lang, [address, name]);

    res.json({
      placeId: d.id ?? placeId,
      address,
      name,
      lat,
      lng,
      district: area.district,
      countryCode: area.countryCode,
    });
  } catch (err) {
    console.error("[Places] details failed:", (err as Error).message);
    res.status(502).json({ error: errMsg(req, "placeDetailsFailed") });
  }
});

// ---------- 相片上傳（後備路線；主要路線係前端直接上 Firebase Storage）----------

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

app.post("/api/upload-photo", uploadRateLimitMiddleware, async (req: Request, res: Response) => {
  try {
    const { imageBase64, caseId, index } = req.body ?? {};
    if (typeof caseId !== "string" || !CASE_ID_RE.test(caseId)) {
      res.status(400).json({ error: errMsg(req, "badCaseId") });
      return;
    }

    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_STORED_PHOTOS) {
      res.status(400).json({ error: errMsg(req, "badPhotoIndex") });
      return;
    }
    if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
      res.status(400).json({ error: errMsg(req, "missingImage") });
      return;
    }

    const encoded = imageBase64.replace(/^data:image\/jpe?g;base64,/i, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      res.status(400).json({ error: errMsg(req, "badImageData") });
      return;
    }
    const buffer = Buffer.from(encoded, "base64");
    if (buffer.length === 0 || buffer.length >= MAX_PHOTO_BYTES) {
      res.status(413).json({ error: errMsg(req, "imageTooLarge") });
      return;
    }
    if (!isJpeg(buffer)) {
      res.status(400).json({ error: errMsg(req, "jpegOnly") });
      return;
    }

    const bucket = getAdminBucket();
    if (!bucket) {
      console.error("[Upload] FIREBASE_STORAGE_BUCKET 未設定");
      res.status(503).json({ error: errMsg(req, "storageNotConfigured") });
      return;
    }

    // 一宗案件一個資料夾，同 firestore.rules / storage.rules 嘅檢查一致
    const objectPath = `animal-reports/${caseId}/${idx}.jpg`;
    const token = randomUUID();
    try {
      await bucket.file(objectPath).save(buffer, {
        resumable: false,
        contentType: "image/jpeg",
        preconditionOpts: { ifGenerationMatch: 0 }, // 已有同名相片就拒絕，唔准覆蓋
        metadata: {
          cacheControl: "public, max-age=31536000",
          metadata: { firebaseStorageDownloadTokens: token, caseId, uploadedVia: "server-proxy" },
        },
      });
    } catch (err: any) {
      if (err?.code === 412) {
        res.status(409).json({ error: errMsg(req, "photoExists") });
        return;
      }
      throw err;
    }

    const downloadUrl =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
      `${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
    res.json({ success: true, downloadUrl, storagePath: objectPath });
  } catch (err) {
    console.error("[Upload] Photo upload error:", (err as Error).message);
    res.status(500).json({ error: errMsg(req, "photoSaveFailed") });
  }
});

app.get("/api/ngos", (_req: Request, res: Response) => {
  res.json([]);
});

// ---------- AI 分析（案件建立後由 server 執行，結果直接寫入 Firestore）----------
// 流程見 server/ai/pipeline.ts。AI 失敗唔當錯誤（回 200 / 202），舊版前端照樣用得

// 唔分析嘅原因 → HTTP 回應；冇列出嘅（未設定 key、超出每日額度、結果過時）當 AI 冇回應，案件維持 P1
const ANALYZE_UNAVAILABLE = { status: 409, key: "analyzeUnavailable" };
const ANALYZE_SKIP_RESPONSE: Partial<Record<SkipReason, { status: number; key: string }>> = {
  storage_not_configured: { status: 503, key: "storageNotConfigured" },
  not_found: { status: 404, key: "caseNotFound" },
  no_photos: { status: 404, key: "casePhotosNotFound" },
  already_analyzed: ANALYZE_UNAVAILABLE,
  outside_window: ANALYZE_UNAVAILABLE,
  not_edited: ANALYZE_UNAVAILABLE,
  done: ANALYZE_UNAVAILABLE,
  in_progress: ANALYZE_UNAVAILABLE,
  max_runs: ANALYZE_UNAVAILABLE,
  changed: ANALYZE_UNAVAILABLE,
};

// 唔分析嘅原因 → HTTP 回應（排隊同直接分析共用）
function sendSkip(req: Request, res: Response, reason: SkipReason): void {
  const mapped = ANALYZE_SKIP_RESPONSE[reason];
  if (mapped) {
    res.status(mapped.status).json({ error: errMsg(req, mapped.key), reason });
    return;
  }
  res.json({ noResponse: true, retryable: false });
}

// 報案後由瀏覽器 call：
// - 有設定 Cloud Tasks：排隊之後即刻回 202，瀏覽器用 onSnapshot 睇 aiStatus 同結果
// - 冇設定（本機開發）或者排唔到隊：喺 request 入面直接分析（舊做法）
app.post("/api/cases/:caseId/analyze", aiRateLimitMiddleware, async (req: Request, res: Response) => {
  const caseId = String(req.params.caseId ?? "");
  if (!CASE_ID_RE.test(caseId)) {
    res.status(400).json({ error: errMsg(req, "badCaseId") });
    return;
  }

  try {
    const lang = resolveLang(req, req.body?.lang);
    if (TASKS_ENABLED) {
      const q = await queueAnalysis(caseId, "create", lang);
      if (q.status === "queued") {
        res.status(202).json({ queued: true });
        return;
      }
      if (q.status === "skipped") {
        sendSkip(req, res, q.reason);
        return;
      }
      // enqueue_failed：落去直接分析
    }

    // 排唔到隊先會行到呢度（TASKS_ENABLED）：aiStatus 已經係 queued
    const outcome = await analyzeCase(caseId, "create", { lang, statusOwned: TASKS_ENABLED });
    if (outcome.status === "done") {
      res.json({ analysis: outcome.analysis, urgency: outcome.urgency });
      return;
    }
    if (outcome.status === "failed") {
      res.json({ noResponse: true, retryable: false });
      return;
    }
    sendSkip(req, res, outcome.reason);
  } catch (err) {
    console.error("[Analyze] error:", (err as any)?.code, (err as Error).message);
    res.status(500).json({ error: errMsg(req, "analyzeFailed") });
  }
});

// Cloud Tasks call 呢度做真正嘅分析（唔係俾瀏覽器用）
// 身份：一定要有 Google 簽發、audience 同服務帳戶都啱嘅 OIDC token
// 回應碼決定 Cloud Tasks 會唔會重試：暫時性失敗回 503（重試）；其他回 200（唔再試）
app.post("/api/internal/tasks/analyze", async (req: Request, res: Response) => {
  if (!TASKS_ENABLED || !(await verifyTaskRequest(req.headers.authorization))) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const payload = parseTaskPayload(req.body);
  if (!payload) {
    // 壞 payload 再試都冇用：回 200 令 Cloud Tasks 唔再重試
    console.error("[Tasks] 無效嘅 task payload");
    res.json({ ignored: true });
    return;
  }

  try {
    const outcome = await analyzeCase(payload.caseId, payload.trigger, {
      lang: payload.lang,
      willRetry: true,
      statusOwned: true,
    });
    const retryCount = Number(req.headers["x-cloudtasks-taskretrycount"]) || 0;
    console.log(
      `[Tasks] case ${payload.caseId} (${payload.trigger}) retry ${retryCount}: ${outcome.status}` +
        (outcome.status === "skipped" ? ` (${outcome.reason})` : outcome.status === "failed" ? ` (${outcome.errorKind})` : "")
    );
    if (outcome.status === "failed" && outcome.retryable) {
      res.status(503).json({ retry: true });
      return;
    }
    res.json({ status: outcome.status });
  } catch (err) {
    // 鎖已經釋放（pipeline 嘅 finally），Cloud Tasks 會重試
    console.error("[Tasks] analyze error:", (err as any)?.code, (err as Error).message);
    res.status(500).json({ error: "analyze_failed" });
  }
});

// ---------- NGO 配對（Phase 5：由前端搬到 server）----------
// 案件同 NGO 資料都係公開，所以唔使登入；待刪除案件同 firestore.rules 一樣只限 admin / NGO
// 只回傳 ngoId 同分數，NGO 嘅公開資料前端已經有（subscribeToNGOs）
const matchesRateLimitMiddleware = makeRateLimit("matches", 60, 60, "rateAction");
const NGO_CACHE_MS = 60_000;
let ngoCache: { at: number; list: MatchNgo[] } | null = null;

// ngodatail 好細，快取 60 秒，唔使每次配對都讀晒（機構改容量最多遲 1 分鐘反映）
async function getMatchNgos(): Promise<MatchNgo[]> {
  if (ngoCache && Date.now() - ngoCache.at < NGO_CACHE_MS) return ngoCache.list;
  const snap = await getAdminDb().collection("ngodatail").get();
  const list = snap.docs.map((d) => toMatchNgo(d.id, d.data())).filter((n): n is MatchNgo => n !== null);
  ngoCache = { at: Date.now(), list };
  return list;
}

app.get("/api/cases/:caseId/matches", matchesRateLimitMiddleware, async (req: Request, res: Response) => {
  const caseId = String(req.params.caseId ?? "");
  if (!CASE_ID_RE.test(caseId)) {
    res.status(400).json({ error: errMsg(req, "badCaseId") });
    return;
  }

  try {
    const snap = await getAdminDb().collection("case").doc(caseId).get();
    const d = snap.data();
    let visible = snap.exists && NORMAL_STATUSES.includes(d?.status);
    if (snap.exists && !visible) {
      const authInfo = await getAuthInfo(req);
      visible = authInfo?.role === "admin" || authInfo?.role === "ngo";
    }
    const lat = Number(d?.location?.lat);
    const lng = Number(d?.location?.lng);
    if (!visible || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(404).json({ error: errMsg(req, "caseNotFound") });
      return;
    }

    const level: UrgencyLevel = d?.urgency === "P0" || d?.urgency === "P2" ? d.urgency : "P1";
    // 每次即場按觀察重新計（規則改咗舊案件都跟新規則）；aiAnalysis.matching 係分析嗰陣嘅紀錄
    const matching = deriveMatching(d?.aiAnalysis ?? d?.geminiResponse ?? null, d?.animalType, level);
    const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 3));
    const matches = rankNgos(await getMatchNgos(), { lat, lng, level, matching }, limit);
    res.json({
      matches,
      requiredCapabilities: matching.requiredCapabilities,
      speciesMismatch: matching.speciesMismatch,
      species: matching.species,
      version: `${MATCHING_VERSION}/${matching.rulesVersion}`,
    });
  } catch (err) {
    console.error("[Matches] error:", (err as any)?.code, (err as Error).message);
    res.status(500).json({ error: errMsg(req, "matchesFailed") });
  }
});

// ---------- 報案人帳戶（我的案件）----------
// 用報案電郵搵或者建立 Firebase Auth 帳戶，將案件記入 usercases/{uid}
// needsSetup = 帳戶未有任何登入方式（未設定密碼、未用過 Google），確認信要附設定密碼連結

async function linkCaseToReporter(
  caseId: string,
  email: string,
  loggedInUid: string | null
): Promise<{ uid: string; needsSetup: boolean }> {
  const auth = getAdminAuth();
  let uid: string;
  let needsSetup: boolean;
  try {
    const u = await auth.getUserByEmail(email);
    uid = u.uid;
    needsSetup = u.providerData.length === 0;
  } catch (err: any) {
    if (err?.code !== "auth/user-not-found") throw err;
    uid = (await auth.createUser({ email, emailVerified: false, disabled: false })).uid;
    needsSetup = true;
  }

  const ids = new Set([uid]);
  if (loggedInUid && loggedInUid !== "anonymous" && UID_RE.test(loggedInUid)) ids.add(loggedInUid);

  const db = getAdminDb();
  await Promise.all(
    [...ids].map((id) =>
      db.collection("usercases").doc(id).set(
        { caseIds: FieldValue.arrayUnion(caseId), updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      )
    )
  );
  return { uid, needsSetup };
}

// ---------- 確認信（電郵由 server 自己讀，唔信前端）----------

app.post("/api/cases/send-confirmation-email", emailIpRateLimitMiddleware, async (req: Request, res: Response) => {
  const caseId = req.body?.caseId;
  if (typeof caseId !== "string" || !CASE_ID_RE.test(caseId)) {
    res.status(400).json({ error: errMsg(req, "badCaseId") });
    return;
  }

  try {
    const caseRef = getAdminDb().collection("case").doc(caseId);
    const [caseSnap, contactSnap] = await Promise.all([
      caseRef.get(),
      caseRef.collection("private").doc("contact").get(),
    ]);
    if (!caseSnap.exists || !contactSnap.exists) {
      res.status(404).json({ error: errMsg(req, "caseNotFound") });
      return;
    }
    if (!isFreshCase(caseSnap.data())) {
      res.status(409).json({ error: errMsg(req, "confirmTooLate") });
      return;
    }

    const contact = contactSnap.data() ?? {};
    const email = cleanStr(contact.reporterEmail, 254).toLowerCase();
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: errMsg(req, "noValidEmail") });
      return;
    }
    if (!(await claimOnce("email", caseId))) {
      res.status(409).json({ error: errMsg(req, "confirmAlreadySent") });
      return;
    }

    // 優先用報案時記低嘅語言，冇就跟 request
    const lang = typeof contact.lang === "string" && contact.lang ? toAppLang(contact.lang) : reqLang(req);
    const baseUrl = getPublicBaseUrl(req);
    const trackingUrl = `${baseUrl}/?caseId=${encodeURIComponent(caseId)}`;

    // 開帳戶／記錄案件失敗都照寄確認信，唔好影響報案
    let accountPart = "";
    try {
      const createdByUid = typeof contact.createdByUid === "string" ? contact.createdByUid : null;
      const { needsSetup } = await linkCaseToReporter(caseId, email, createdByUid);
      if (needsSetup) {
        const link = await makeSetPasswordLink(email, baseUrl);
        accountPart = tr(lang, "server.email.confirm.accountSetup", { link });
      } else {
        accountPart = tr(lang, "server.email.confirm.accountLogin", { baseUrl });
      }
    } catch (err) {
      console.warn("[Reporter account] link failed:", (err as any)?.code, (err as Error).message);
    }

    const subject = tr(lang, "server.email.confirm.subject", { caseId });
    const text = tr(lang, "server.email.confirm.body", { caseId, trackingUrl, accountPart });

    const { simulated } = await sendMail(email, subject, text);
    res.json({ success: true, simulated });
  } catch (err) {
    console.error("Email notification error:", (err as any)?.code, (err as Error).message);
    res.status(500).json({ error: errMsg(req, "confirmFailed") });
  }
});

// ---------- 通知 NGO（目前模擬）----------
// admin：任何案件都可以派送；報案人（未登入）：只限建立後 15 分鐘內、每宗案件一次

app.post("/api/ngo/notify", dispatchRateLimitMiddleware, async (req: Request, res: Response) => {
  const { reportId, ngoId } = req.body ?? {};
  if (typeof reportId !== "string" || !CASE_ID_RE.test(reportId) ||
      typeof ngoId !== "string" || !CASE_ID_RE.test(ngoId)) {
    res.status(400).json({ error: errMsg(req, "badDispatchInput") });
    return;
  }

  try {
    const db = getAdminDb();
    const caseRef = db.collection("case").doc(reportId);
    const [authInfo, caseSnap, ngoSnap, contactSnap] = await Promise.all([
      getAuthInfo(req),
      caseRef.get(),
      db.collection("ngodatail").doc(ngoId).get(),
      caseRef.collection("private").doc("contact").get(),
    ]);
    const adminUid = authInfo?.role === "admin" ? authInfo.uid : null;
    if (!caseSnap.exists || !ngoSnap.exists) {
      res.status(404).json({ error: errMsg(req, "caseOrNgoNotFound") });
      return;
    }

    const caseData = caseSnap.data() ?? {};
    if (!adminUid) {
      if (!isFreshCase(caseData)) {
        res.status(403).json({ error: errMsg(req, "dispatchAdminOnly") });
        return;
      }
      if (caseData.dispatchedToNGO || !(await claimOnce("dispatch", reportId))) {
        res.status(409).json({ error: errMsg(req, "alreadyDispatched") });
        return;
      }
    }

    const ngo = ngoSnap.data() ?? {};
    const contact = contactSnap.data() ?? {};
    const dispatchedAt = new Date().toISOString();
    const dispatchedToNGO = {
      ngoId,
      ngoName: cleanStr(ngo.name, 200), // 機構名由資料庫讀，唔信前端
      dispatchedAt,
      status: "sent",
      simulated: true,
    };

    await caseRef.update({
      dispatchedToNGO,
      ...(adminUid && caseData.status === "pending" ? { status: "in_progress" } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // TODO：將來喺呢度接真正推送，報案人電話直接用 contact.reporterPhone
    console.log(
      `[NGO DISPATCH - SIMULATED] case ${reportId} → ${ngoId} (${adminUid ? "admin" : "reporter"}), 有電話: ${!!contact.reporterPhone}`
    );
    res.json({
      simulated: true,
      receiptId: `DISPATCH-${Date.now().toString(36).toUpperCase()}`,
      dispatchedAt,
      dispatchedToNGO,
      notice: tr(reqLang(req), "server.misc.dispatchSimulated"),
    });
  } catch (err) {
    console.error("[NGO notify] error:", (err as Error).message);
    res.status(500).json({ error: errMsg(req, "dispatchFailed") });
  }
});

// ---------- NGO 帳戶（admin 建立／移除） ----------
// 帳戶資料放 ngouser/{uid}（rules 唔准前端寫），登入電郵唔會放入公開嘅 ngodatail

async function requireAdmin(req: Request, res: Response): Promise<AuthInfo | null> {
  const authInfo = await getAuthInfo(req);
  if (authInfo?.role !== "admin") {
    res.status(403).json({ error: errMsg(req, "adminOnly") });
    return null;
  }
  return authInfo;
}

// 產生「設定密碼」連結
async function makeSetPasswordLink(email: string, baseUrl: string): Promise<string> {
  // Firebase 只負責整連結；抽出 oobCode 駁去自己嘅 /set-password 頁
  // 唔再傳 continue URL，所以唔會再撞 unauthorized-continue-uri
  const raw = await getAdminAuth().generatePasswordResetLink(email);
  const oobCode = new URL(raw).searchParams.get("oobCode");
  if (!oobCode) throw new Error("generatePasswordResetLink: oobCode missing");
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/set-password?oobCode=${encodeURIComponent(oobCode)}`;
}

// ---------- 會員資料（5A）----------
// userprofiles/{uid}：姓、名、帳戶名（姓名唔公開）
// usernames/{帳戶名細楷}：防重複；transaction 保證兩個人唔會同時搶到同一個名
const MEMBER_USERNAME_RE = /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N}_\-.!@#$%&*+=?~^()[\]]{2,30}$/u;
const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "pawpulse", "ngo", "system", "support", "root", "moderator", "official",
  "管理員", "管理员", "系統", "系统", "官方", "客服", "版主",
]);
const USERNAME_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 日只可以改 1 次帳戶名

class ProfileSetupError extends Error {
  status: number;
  code: string;
  nextChangeAt?: number;
  constructor(status: number, code: string, nextChangeAt?: number) {
    super(code);
    this.status = status;
    this.code = code;
    this.nextChangeAt = nextChangeAt;
  }
}

app.post("/api/profile", emailIpRateLimitMiddleware, async (req: Request, res: Response) => {
  const authInfo = await getAuthInfo(req);
  if (!authInfo) {
    res.status(401).json({ error: errMsg(req, "loginRequired"), code: "unauthenticated" });
    return;
  }

  const firstName = cleanStr(req.body?.firstName, 50).trim();
  const lastName = cleanStr(req.body?.lastName, 50).trim();
  const username = cleanStr(req.body?.username, 60).normalize("NFKC").trim();
  const key = username.toLowerCase();

  if (!firstName || !lastName) {
    res.status(400).json({ error: errMsg(req, "nameRequired"), code: "name_required" });
    return;
  }
  // __xxx__ 係 Firestore 保留嘅文件 ID 格式
  if (!MEMBER_USERNAME_RE.test(username) || RESERVED_USERNAMES.has(key) || /^__.*__$/.test(key)) {
    res.status(400).json({ error: errMsg(req, "usernameInvalid"), code: "username_invalid" });
    return;
  }

  const db = getAdminDb();
  const profileRef = db.collection("userprofiles").doc(authInfo.uid);
  const nameRef = db.collection("usernames").doc(key);

  try {
    let didRename = false;
    await db.runTransaction(async (tx) => {
      const [profileSnap, nameSnap] = await Promise.all([tx.get(profileRef), tx.get(nameRef)]);

      const oldUsername = profileSnap.exists ? profileSnap.get("username") : null;
      const oldKey = profileSnap.exists ? profileSnap.get("usernameLower") : null;
      // 第一次設定唔計；之後改名（包括淨係改大細楷）要隔 30 日
      const isRename = typeof oldUsername === "string" && oldUsername !== "" && oldUsername !== username;
      didRename = isRename;
      if (isRename) {
        const last = profileSnap.get("usernameChangedAt");
        if (last instanceof Timestamp) {
          const next = last.toMillis() + USERNAME_COOLDOWN_MS;
          if (Date.now() < next) throw new ProfileSetupError(429, "username_cooldown", next);
        }
      }
      if (nameSnap.exists && nameSnap.get("uid") !== authInfo.uid) {
        throw new ProfileSetupError(409, "username_taken");
      }

      const now = FieldValue.serverTimestamp();
      // 舊名即刻釋放
      if (isRename && typeof oldKey === "string" && oldKey !== "" && oldKey !== key) {
        tx.delete(db.collection("usernames").doc(oldKey));
      }
      tx.set(nameRef, { uid: authInfo.uid, username, createdAt: now }, { merge: true });
      tx.set(
        profileRef,
        {
          firstName,
          lastName,
          username,
          usernameLower: key,
          email: authInfo.email ?? null,
          updatedAt: now,
          ...(profileSnap.exists ? {} : { createdAt: now, usernameChangedAt: null }),
          ...(isRename ? { usernameChangedAt: now } : {}),
        },
        { merge: true }
      );
    });

    if (didRename) await renameCommentAuthor(authInfo.uid, username);
    res.json({ success: true, profile: { firstName, lastName, username } });
  } catch (err) {
    if (err instanceof ProfileSetupError) {
      res.status(err.status).json({ error: err.code, code: err.code, nextChangeAt: err.nextChangeAt ?? null });
      return;
    }
    console.error("[Profile] save failed:", (err as any)?.code, (err as Error).message);
    res.status(500).json({ error: errMsg(req, "profileSaveFailed"), code: "save_failed" });
  }
});

app.post("/api/admin/ngo-accounts", adminRateLimitMiddleware, async (req: Request, res: Response) => {
  const authInfo = await requireAdmin(req, res);
  if (!authInfo) return;

  const email = cleanStr(req.body?.email ?? req.body?.loginEmail, 254).toLowerCase();
  const ngoId = req.body?.ngoId;
  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ error: errMsg(req, "badLoginEmail") });
    return;
  }
  if (typeof ngoId !== "string" || !CASE_ID_RE.test(ngoId)) {
    res.status(400).json({ error: errMsg(req, "badNgoId") });
    return;
  }

  try {
    const db = getAdminDb();
    const ngoSnap = await db.collection("ngodatail").doc(ngoId).get();
    if (!ngoSnap.exists) {
      res.status(404).json({ error: errMsg(req, "ngoNotFound") });
      return;
    }
    const ngoName = cleanStr(ngoSnap.data()?.name, 200);

    // 搵或者建立 Firebase Auth 帳戶
    let uid: string;
    try {
      uid = (await getAdminAuth().getUserByEmail(email)).uid;
    } catch (err: any) {
      if (err?.code !== "auth/user-not-found") throw err;
      uid = (await getAdminAuth().createUser({ email, emailVerified: false, disabled: false })).uid;
    }

    const [adminDoc, ngoUserDoc] = await Promise.all([
      db.collection("adminuser").doc(uid).get(),
      db.collection("ngouser").doc(uid).get(),
    ]);
    if (adminDoc.exists) {
      res.status(409).json({ error: errMsg(req, "emailIsAdmin") });
      return;
    }

    let resent = false;
    if (ngoUserDoc.exists) {
      if (ngoUserDoc.data()?.ngoId !== ngoId) {
        res.status(409).json({ error: errMsg(req, "emailOtherNgo") });
        return;
      }
      resent = true; // 同一間機構：重新寄設定密碼連結
    } else {
      const countSnap = await db.collection("ngouser").where("ngoId", "==", ngoId).count().get();
      if (countSnap.data().count >= MAX_NGO_ACCOUNTS) {
        res.status(409).json({ error: errMsg(req, "ngoAccountLimit", { max: MAX_NGO_ACCOUNTS }) });
        return;
      }
      await db.collection("ngouser").doc(uid).set({
        uid,
        email,
        ngoId,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: authInfo.uid,
      });
      // 令佢舊嘅登入 token 失效，下次登入就會攞到 NGO 身份
      await getAdminAuth().revokeRefreshTokens(uid).catch(() => undefined);
    }

    // NGO 職員未有語言紀錄，跟 admin 建立帳戶時嘅介面語言
    const lang = reqLang(req);
    const baseUrl = getPublicBaseUrl(req);
    const link = await makeSetPasswordLink(email, baseUrl);
    const subject = tr(lang, "server.email.ngoAccount.subject");
    const text = tr(lang, "server.email.ngoAccount.body", { ngoName, email, link, baseUrl });

    const { simulated } = await sendMail(email, subject, text);
    console.log(`[NGO account] ${resent ? "resent" : "created"} ${maskEmail(email)} → ${ngoId} by ${authInfo.uid}`);
    res.json({ success: true, uid, email, ngoId, resent, simulated });
  } catch (err) {
    console.error("[NGO account create] error:", (err as any)?.code, (err as Error).message);
    res.status(500).json({ error: errMsg(req, "ngoAccountCreateFailed") });
  }
});

// 移除單一帳戶：支援 DELETE /api/admin/ngo-accounts/{uid} 或者 body { uid }
app.delete(
  ["/api/admin/ngo-accounts/:uid", "/api/admin/ngo-accounts"],
  adminRateLimitMiddleware,
  async (req: Request, res: Response) => {
    const authInfo = await requireAdmin(req, res);
    if (!authInfo) return;

    const uid = String(req.params.uid ?? req.body?.uid ?? "");
    if (!UID_RE.test(uid)) {
      res.status(400).json({ error: errMsg(req, "badUid") });
      return;
    }

    try {
      const ref = getAdminDb().collection("ngouser").doc(uid);
      const snap = await ref.get();
      if (!snap.exists) {
        res.status(404).json({ error: errMsg(req, "ngoAccountNotFound") });
        return;
      }
      await ref.delete();
      // 即刻踢走：已登入嘅 token 失效（verifyIdToken 有 checkRevoked）
      await getAdminAuth().revokeRefreshTokens(uid).catch(() => undefined);

      console.log(`[NGO account] removed ${uid} by ${authInfo.uid}`);
      res.json({ success: true });
    } catch (err) {
      console.error("[NGO account delete] error:", (err as Error).message);
      res.status(500).json({ error: errMsg(req, "ngoAccountDeleteFailed") });
    }
  }
);

// 刪除機構：連同佢所有登入帳戶一齊刪（rules 唔准前端寫 ngouser，所以一定要經 server）
app.delete("/api/admin/ngos/:ngoId", adminRateLimitMiddleware, async (req: Request, res: Response) => {
  const authInfo = await requireAdmin(req, res);
  if (!authInfo) return;

  const ngoId = String(req.params.ngoId ?? "");
  if (!CASE_ID_RE.test(ngoId)) {
    res.status(400).json({ error: errMsg(req, "badNgoId") });
    return;
  }

  try {
    const db = getAdminDb();
    const accounts = await db.collection("ngouser").where("ngoId", "==", ngoId).get();

    const batch = db.batch();
    accounts.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(db.collection("ngodatail").doc(ngoId));
    await batch.commit();

    await Promise.all(
      accounts.docs.map((d) => getAdminAuth().revokeRefreshTokens(d.id).catch(() => undefined))
    );

    console.log(`[Admin] Deleted NGO ${ngoId} (+${accounts.size} accounts) by ${authInfo.uid}`);
    res.json({ success: true, removedAccounts: accounts.size });
  } catch (err) {
    console.error("[Admin delete NGO] error:", (err as Error).message);
    res.status(500).json({ error: errMsg(req, "ngoDeleteFailed") });
  }
});

// ---------- 報案人聯絡資料（5E 通知用）----------
// 電郵：先用報案時填嘅聯絡電郵，冇就用登入帳戶電郵
// 語言：報案時記低嘅 lang；舊案件冇就用中文
async function getReporterContact(caseId: string): Promise<{ email: string | null; lang: AppLang }> {
  const snap = await getAdminDb().collection("case").doc(caseId).collection("private").doc("contact").get();
  const d = snap.data() ?? {};
  let email: string | null = null;
  for (const v of [d.reporterEmail, d.accountEmail]) {
    const e = cleanStr(v, 254).toLowerCase();
    if (EMAIL_RE.test(e)) {
      email = e;
      break;
    }
  }
  return { email, lang: toAppLang(d.lang) };
}

// ---------- NGO 接手案件 ----------
// 用 transaction 防止兩間 NGO 同時搶同一宗案件；接手後寄信通知報案人

app.post("/api/cases/:caseId/accept", caseActionRateLimitMiddleware, async (req: Request, res: Response) => {
  const caseId = String(req.params.caseId ?? "");
  if (!CASE_ID_RE.test(caseId)) {
    res.status(400).json({ error: errMsg(req, "badCaseId") });
    return;
  }

  const authInfo = await getAuthInfo(req);
  if (authInfo?.role !== "ngo" || !authInfo.ngoId) {
    res.status(403).json({ error: errMsg(req, "ngoOnly") });
    return;
  }
  const ngoId = authInfo.ngoId;

  try {
    const db = getAdminDb();
    const caseRef = db.collection("case").doc(caseId);
    const ngoSnap = await db.collection("ngodatail").doc(ngoId).get();
    if (!ngoSnap.exists) {
      res.status(404).json({ error: errMsg(req, "ownNgoNotFound") });
      return;
    }
    const ngo = ngoSnap.data() ?? {};

    // 公開資料（case 文件人人可讀），所以唔放 NGO 職員嘅登入電郵
    const acceptedBy = {
      ngoId,
      ngoName: cleanStr(ngo.name, 200),
      acceptedByUid: authInfo.uid,
      acceptedAt: new Date().toISOString(),
    };

    const pre = await caseRef.get();
    if (pre.data()?.status === "pending_deletion") {
      res.status(409).json({ error: errMsg(req, "pendingDeletion"), code: "pending_deletion" });
      return;
    }

    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists) return { code: 404 as const };
      const d = snap.data() ?? {};
      if (d.acceptedBy) {
        return { code: 409 as const, mine: d.acceptedBy?.ngoId === ngoId };
      }
      if (d.status === "rescued" || d.status === "closed") return { code: 410 as const };
      tx.update(caseRef, {
        acceptedBy,
        status: "in_progress",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { code: 200 as const };
    });

    if (outcome.code === 404) {
      res.status(404).json({ error: errMsg(req, "caseNotFound") });
      return;
    }
    if (outcome.code === 409) {
      res.status(409).json({ error: errMsg(req, outcome.mine ? "alreadyAcceptedMine" : "alreadyAcceptedOther") });
      return;
    }
    if (outcome.code === 410) {
      res.status(409).json({ error: errMsg(req, "caseFinished") });
      return;
    }

    // 寄信通知報案人（用報案人嘅語言）；寄唔到唔影響接手結果
    let emailSent = false;
    let simulated = false;
    try {
      const { email: reporterEmail, lang } = await getReporterContact(caseId);
      if (reporterEmail) {
        const trackingUrl = `${getPublicBaseUrl(req)}/?caseId=${encodeURIComponent(caseId)}`;
        const hotline = cleanStr(ngo.hotline, 50);
        const whatsapp = cleanStr(ngo.whatsapp, 50);
        const publicEmail = cleanStr(ngo.publicEmail, 254);
        const website = cleanStr(ngo.website, 300);

        const info = [
          tr(lang, "server.email.accepted.org", { v: acceptedBy.ngoName }),
          hotline && tr(lang, "server.email.accepted.phone", { v: hotline }),
          whatsapp && tr(lang, "server.email.accepted.whatsapp", { v: whatsapp }),
          publicEmail && tr(lang, "server.email.accepted.email", { v: publicEmail }),
          website && tr(lang, "server.email.accepted.website", { v: website }),
        ]
          .filter(Boolean)
          .join("\n");

        const subject = tr(lang, "server.email.accepted.subject", { caseId });
        const text = tr(lang, "server.email.accepted.body", { caseId, info, trackingUrl });

        simulated = (await sendMail(reporterEmail, subject, text)).simulated;
        emailSent = true;
      }
    } catch (err) {
      console.warn("[Accept] 通知報案人失敗:", (err as Error).message);
    }

    console.log(`[Accept] case ${caseId} accepted by NGO ${ngoId} (${authInfo.uid})`);
    res.json({ success: true, acceptedBy, emailSent, simulated });
  } catch (err) {
    console.error("[Accept] error:", (err as Error).message);
    res.status(500).json({ error: errMsg(req, "acceptFailed") });
  }
});

// ---------- 更新案件進度 ----------
// admin：任何案件、任何狀態；ngo：只可以改自己機構接手咗嘅案件

const CASE_STATUSES = new Set(["pending", "in_progress", "rescued", "closed"]);
const NGO_ALLOWED_STATUSES = new Set(["in_progress", "rescued", "closed"]);

// 狀態改變：寄 email 俾報案人（用報案人嘅語言）；失敗唔影響更新結果
async function emailReporterStatus(req: Request, caseId: string, status: string, title: string, ngoName?: string) {
  try {
    const { email, lang } = await getReporterContact(caseId);
    if (!email) return;
    const vars = {
      caseId,
      title,
      status: statusLabel(lang, status),
      ngoLine: ngoName ? tr(lang, "server.email.status.ngoLine", { ngo: ngoName }) : "",
      trackingUrl: `${getPublicBaseUrl(req)}/?caseId=${encodeURIComponent(caseId)}`,
    };
    await sendMail(email, tr(lang, "server.email.status.subject", vars), tr(lang, "server.email.status.body", vars));
  } catch (err) {
    console.warn("[Notify] status email failed:", (err as Error).message);
  }
}

app.post("/api/cases/:caseId/status", caseActionRateLimitMiddleware, async (req: Request, res: Response) => {
  const caseId = String(req.params.caseId ?? "");
  const status = req.body?.status;
  if (!CASE_ID_RE.test(caseId)) {
    res.status(400).json({ error: errMsg(req, "badCaseId") });
    return;
  }
  if (typeof status !== "string" || !CASE_STATUSES.has(status)) {
    res.status(400).json({ error: errMsg(req, "badStatus") });
    return;
  }

  const authInfo = await getAuthInfo(req);
  if (authInfo?.role !== "admin" && authInfo?.role !== "ngo") {
    res.status(403).json({ error: errMsg(req, "noPermission") });
    return;
  }
  if (authInfo.role === "ngo" && !NGO_ALLOWED_STATUSES.has(status)) {
    res.status(403).json({ error: errMsg(req, "ngoNoPending") });
    return;
  }

  try {
    const caseRef = getAdminDb().collection("case").doc(caseId);
    const outcome = await getAdminDb().runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists) return { code: 404 as const };
      const d = snap.data() ?? {};
      if (authInfo.role === "ngo" && d.acceptedBy?.ngoId !== authInfo.ngoId) return { code: 403 as const };
      tx.update(caseRef, { status, updatedAt: FieldValue.serverTimestamp() });
      return {
        code: 200 as const,
        changed: d.status !== status,
        title: String(d.title ?? ""),
        ngoName: d.acceptedBy?.ngoName ? String(d.acceptedBy.ngoName) : undefined,
      };
    });

    if (outcome.code === 404) {
      res.status(404).json({ error: errMsg(req, "caseNotFound") });
      return;
    }
    if (outcome.code === 403) {
      res.status(403).json({ error: errMsg(req, "notAcceptingNgo") });
      return;
    }

    // 狀態真係變咗先寄信（重複撳同一個狀態唔會寄）
    if (outcome.changed) await emailReporterStatus(req, caseId, status, outcome.title, outcome.ngoName);

    console.log(`[Status] case ${caseId} → ${status} by ${authInfo.role} ${authInfo.uid}`);
    res.json({ success: true, status });
  } catch (err) {
    console.error("[Status] error:", (err as Error).message);
    res.status(500).json({ error: errMsg(req, "statusUpdateFailed") });
  }
});

// ---------- NGO 對 AI 結果嘅回饋（Phase 6）----------
// 權限同更新進度一樣：admin 任何案件；NGO 只可以回饋自己機構接手咗嘅案件
// 可以重複提交（覆蓋），revisions 記低改過幾多次；評估用 scripts/eval.ts 以外，亦可以用嚟睇實際表現
app.post("/api/cases/:caseId/ai-feedback", caseActionRateLimitMiddleware, async (req: Request, res: Response) => {
  const caseId = String(req.params.caseId ?? "");
  if (!CASE_ID_RE.test(caseId)) {
    res.status(400).json({ error: errMsg(req, "badCaseId") });
    return;
  }
  const input = parseFeedback(req.body);
  if (!input) {
    res.status(400).json({ error: errMsg(req, "badFeedback") });
    return;
  }

  const authInfo = await getAuthInfo(req);
  if (authInfo?.role !== "admin" && authInfo?.role !== "ngo") {
    res.status(403).json({ error: errMsg(req, "noPermission") });
    return;
  }

  try {
    const db = getAdminDb();
    const caseRef = db.collection("case").doc(caseId);
    const feedbackRef = caseRef.collection("private").doc("aiFeedback");
    const aiRunRef = caseRef.collection("private").doc("aiRun");

    const code = await db.runTransaction(async (tx) => {
      const [caseSnap, prevSnap, aiRunSnap] = await tx.getAll(caseRef, feedbackRef, aiRunRef);
      if (!caseSnap.exists) return 404 as const;
      const d = caseSnap.data() ?? {};
      if (authInfo.role === "ngo" && (!authInfo.ngoId || d.acceptedBy?.ngoId !== authInfo.ngoId)) return 403 as const;

      const prev = prevSnap.data();
      tx.set(feedbackRef, {
        ...input,
        submittedByUid: authInfo.uid,
        role: authInfo.role,
        ngoId: authInfo.role === "ngo" ? authInfo.ngoId : null,
        // 第一次提交嗰陣嘅 AI 預測（之後重新分析都唔改，咁先知道當時 AI 估成點）
        prediction: prev?.prediction ?? predictionSnapshot(d, aiRunSnap.data()),
        revisions: (Number(prev?.revisions) || 0) + 1,
        createdAt: prev?.createdAt ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return 200 as const;
    });

    if (code === 404) {
      res.status(404).json({ error: errMsg(req, "caseNotFound") });
      return;
    }
    if (code === 403) {
      res.status(403).json({ error: errMsg(req, "notAcceptingNgo") });
      return;
    }
    console.log(`[Feedback] case ${caseId} by ${authInfo.role} ${authInfo.uid}: ${input.actualUrgency}/${input.actualSpecies}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[Feedback] error:", (err as any)?.code, (err as Error).message);
    res.status(500).json({ error: errMsg(req, "feedbackFailed") });
  }
});

// ---------- 報案人修改案件（5B-1）----------
// 報案人可以移走舊相（Storage 保留，原本嗰版存喺 private/firstVersion），再加新相
// 新相放喺同一個資料夾嘅空位（0–9.jpg）；案件同時最多顯示 5 張，第 1 張係封面

// 報案人 = usercases/{uid} 有呢宗案件，或者報案時登入咗嘅 uid
async function isCaseReporter(uid: string, caseId: string): Promise<boolean> {
  const db = getAdminDb();
  const [uc, contact] = await Promise.all([
    db.collection("usercases").doc(uid).get(),
    db.collection("case").doc(caseId).collection("private").doc("contact").get(),
  ]);
  const ids = uc.data()?.caseIds;
  if (Array.isArray(ids) && ids.includes(caseId)) return true;
  return contact.data()?.createdByUid === uid;
}

function cleanLocation(v: any): { lat: number; lng: number; address: string; district?: string } | null {
  const lat = Number(v?.lat);
  const lng = Number(v?.lng);
  const address = cleanStr(v?.address, 300);
  const district = cleanStr(v?.district, 100);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || !address) {
    return null;
  }
  return { lat, lng, address, ...(district && { district }) };
}

// 網址由 server 用 Storage metadata 自己砌，唔信前端傳嚟嘅網址
async function storedPhotoEntry(
  bucket: NonNullable<ReturnType<typeof getAdminBucket>>,
  p: string
): Promise<{ url: string; path: string } | null> {
  try {
    const [meta] = await bucket.file(p).getMetadata();
    if (meta.contentType !== "image/jpeg" || Number(meta.size) >= MAX_PHOTO_BYTES) return null;
    const token = String(meta.metadata?.firebaseStorageDownloadTokens ?? "").split(",")[0];
    if (!token) return null;
    const url =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
      `${encodeURIComponent(p)}?alt=media&token=${token}`;
    return { url, path: p };
  } catch {
    return null;
  }
}
type PhotoEntry = { url: string; path: string };

app.post("/api/cases/:caseId/edit", caseActionRateLimitMiddleware, async (req: Request, res: Response) => {
  const caseId = String(req.params.caseId ?? "");
  if (!CASE_ID_RE.test(caseId)) {
    res.status(400).json({ error: "bad_input", code: "bad_input" });
    return;
  }
  const authInfo = await getAuthInfo(req);
  if (!authInfo) {
    res.status(401).json({ error: "unauthenticated", code: "unauthenticated" });
    return;
  }
  const bucket = getAdminBucket();
  if (!bucket) {
    res.status(503).json({ error: errMsg(req, "storageNotConfigured") });
    return;
  }

  const b = req.body ?? {};
  const title = cleanStr(b.title, 200);
  const description = typeof b.description === "string" ? b.description.trim().slice(0, 2000) : "";
  const animalType = typeof b.animalType === "string" && ALLOWED_ANIMAL_HINTS.has(b.animalType) ? b.animalType : null;
  const customAnimalName = animalType === "other" ? cleanStr(b.customAnimalName, 100) : "";
  const tags: string[] = Array.isArray(b.tags)
    ? Array.from(new Set((b.tags as unknown[]).filter((x): x is string => typeof x === "string" && TAG_RE.test(x)))).slice(0, 10)
    : [];
  const location = cleanLocation(b.location);
  const rawPaths: unknown[] = Array.isArray(b.newPhotoPaths) ? b.newPhotoPaths : [];
  // keepPaths：保留嘅舊相（次序 = 新次序）；舊版前端冇傳就全部保留
  const rawKeep: unknown[] | null = Array.isArray(b.keepPaths) ? b.keepPaths : null;

  if (
    !title || !description || !animalType || !location ||
    rawPaths.length > MAX_CASE_PHOTOS ||
    (rawKeep !== null && rawKeep.length > MAX_CASE_PHOTOS)
  ) {
    res.status(400).json({ error: "bad_input", code: "bad_input" });
    return;
  }

  const folder = `animal-reports/${caseId}/`;
  const isOwnPath = (p: unknown): p is string =>
    typeof p === "string" && p.startsWith(folder) && PHOTO_FILE_RE.test(p.slice(folder.length));

  const newPaths = Array.from(new Set(rawPaths.filter(isOwnPath)));
  const keepPaths = rawKeep === null ? null : Array.from(new Set(rawKeep.filter(isOwnPath)));
  if (newPaths.length !== rawPaths.length || (keepPaths !== null && keepPaths.length !== rawKeep!.length)) {
    res.status(400).json({ error: "bad_photos", code: "bad_photos" });
    return;
  }

  try {
    if (!(await isCaseReporter(authInfo.uid, caseId))) {
      res.status(403).json({ error: "not_owner", code: "not_owner" });
      return;
    }

    // 新相要真係喺 Storage 入面（Storage 讀寫唔放入 transaction）
    const newEntries = await Promise.all(newPaths.map((p) => storedPhotoEntry(bucket, p)));
    if (newEntries.some((e) => !e)) {
      res.status(400).json({ error: "bad_photos", code: "bad_photos" });
      return;
    }
    const added = newEntries as PhotoEntry[];

    const db = getAdminDb();
    const caseRef = db.collection("case").doc(caseId);

    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists) return { code: "not_found" as const };
      const d = snap.data() ?? {};
      if (d.acceptedBy) return { code: "case_accepted" as const };
      if (d.status !== "pending") return { code: "case_locked" as const };
      const created = d.createdAt instanceof Timestamp ? d.createdAt.toMillis() : 0;
      if (!created || Date.now() - created > EDIT_WINDOW_MS) return { code: "edit_expired" as const };
      if ((Number(d.editCount) || 0) >= MAX_REPORTER_EDITS) return { code: "edit_used" as const };

      // 目前案件嘅相（只信屬於呢宗案件資料夾嘅路徑）
      const ownPaths = casePhotoPaths(caseId, d);
      const current: PhotoEntry[] = (Array.isArray(d.photos) ? d.photos : [])
        .filter((p: any) => typeof p?.url === "string" && ownPaths.includes(p?.path))
        .map((p: any) => ({ url: p.url as string, path: p.path as string }));

      // 保留邊幾張：一定要係目前案件已有嘅相
      const keep: PhotoEntry[] = [];
      for (const p of keepPaths ?? current.map((c) => c.path)) {
        const hit = current.find((c) => c.path === p);
        if (!hit) return { code: "bad_photos" as const };
        keep.push(hit);
      }

      // 新相唔可以用返目前案件任何一張相嘅路徑（包括移走咗嗰啲）
      if (added.some((a) => current.some((c) => c.path === a.path))) return { code: "bad_photos" as const };

      const photos = [...keep, ...added];
      if (photos.length === 0 || photos.length > MAX_CASE_PHOTOS) return { code: "bad_photos" as const };

      // 第 1 版放 private（只有 admin／接手 NGO 讀到）；photos 記低原本全部相
      tx.set(caseRef.collection("private").doc("firstVersion"), {
        title: d.title ?? null,
        animalType: d.animalType ?? null,
        customAnimalName: d.customAnimalName ?? null,
        tags: d.tags ?? null,
        description: d.description ?? null,
        location: d.location ?? null,
        photos: current,
        photoUrl: d.photoUrl ?? null,
        storagePath: d.storagePath ?? null,
        urgency: d.urgency ?? null,
        aiAnalysis: d.aiAnalysis ?? null,
        savedAt: FieldValue.serverTimestamp(),
      });

      tx.update(caseRef, {
        title,
        animalType,
        customAnimalName: customAnimalName || FieldValue.delete(),
        tags: tags.length ? tags : FieldValue.delete(),
        description,
        location,
        photos,
        photoUrl: photos[0].url,
        storagePath: photos[0].path,
        editCount: FieldValue.increment(1),
        editedAt: new Date().toISOString(),
        // 新內容未分析之前唔好留住舊結果；geminiResponse 都要清，否則 docToReport 會用返舊嘅
        aiAnalysis: null,
        geminiResponse: null,
        urgency: "P1",
        // 新內容要重新分析：前端即刻顯示「分析中」
        aiStatus: "queued",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { code: "ok" as const, photos, removed: current.length - keep.length };
    });

    if (outcome.code !== "ok") {
      const status = outcome.code === "not_found" ? 404 : outcome.code === "bad_photos" ? 400 : 409;
      res.status(status).json({ error: outcome.code, code: outcome.code });
      return;
    }

    // 再問 Gemini（同建立案件用同一個流程）；失敗、超額度、出 exception 都唔影響修改結果
    // 有 Cloud Tasks 就排隊（即刻回應）；冇設定或者排唔到隊就喺 request 入面直接分析
    let urgency: string = "P1";
    let analyzed = false;
    let queued = false;
    try {
      const lang = resolveLang(req, b.lang);
      let runInline = !TASKS_ENABLED;
      if (TASKS_ENABLED) {
        const q = await queueAnalysis(caseId, "edit", lang);
        queued = q.status === "queued";
        runInline = q.status === "enqueue_failed";
        if (q.status === "skipped") console.warn(`[Edit] 案件 ${caseId} 修改後未排隊分析：${q.reason}`);
      }
      if (runInline) {
        // 修改嘅 transaction 已經將 aiStatus 設為 queued
        const ai = await analyzeCase(caseId, "edit", { lang, statusOwned: true });
        if (ai.status === "done") {
          urgency = ai.urgency;
          analyzed = true;
        } else {
          console.warn(`[Edit] 案件 ${caseId} 修改後未分析：${ai.status === "skipped" ? ai.reason : ai.errorKind}`);
        }
      }
    } catch (err) {
      console.warn(`[Edit] 案件 ${caseId} 修改後 AI 分析出錯:`, (err as Error)?.message);
    }

    console.log(
      `[Edit] case ${caseId} edited by reporter ${authInfo.uid} (+${newPaths.length} / -${outcome.removed} photos)`
    );
    res.json({ success: true, urgency, noResponse: !analyzed && !queued, queued });
  } catch (err) {
    console.error("[Edit] error:", (err as any)?.code, (err as Error).message);
    res.status(500).json({ error: "save_failed", code: "save_failed" });
  }
});

// ---------- 管理員電郵清單（5B-2 / 5B-3 共用）----------
// 來源：adminuser 文件嘅 email 欄位 + 環境變數 ADMIN_NOTIFY_EMAIL（可選，逗號分隔）
async function getAdminEmails(): Promise<string[]> {
  const out = new Set<string>();
  for (const e of String(process.env.ADMIN_NOTIFY_EMAIL ?? "").split(",")) {
    const v = e.trim().toLowerCase();
    if (EMAIL_RE.test(v)) out.add(v);
  }
  try {
    const snap = await getAdminDb().collection("adminuser").get();
    snap.forEach((d) => {
      const v = String(d.data()?.email ?? "").trim().toLowerCase();
      if (EMAIL_RE.test(v)) out.add(v);
    });
  } catch (err) {
    console.warn("[AdminEmails] read failed:", (err as Error).message);
  }
  return Array.from(out);
}

// 寄俾 admin 嘅信一律用預設語言（中文）
function adminCaseLink(caseId: string): string {
  const base = String(process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return base
    ? `${base}/?caseId=${encodeURIComponent(caseId)}`
    : tr(APP_DEFAULT_LANG, "server.email.common.caseIdFallback", { caseId });
}

// ---------- 報案人申請刪除（5B-2）----------
// 報案人冇刪除權；只會將狀態改做 pending_deletion，再寄信通知 admin
app.post("/api/cases/:caseId/delete-request", caseActionRateLimitMiddleware, async (req: Request, res: Response) => {
  const caseId = String(req.params.caseId ?? "");
  if (!CASE_ID_RE.test(caseId)) {
    res.status(400).json({ error: "bad_input", code: "bad_input" });
    return;
  }
  const authInfo = await getAuthInfo(req);
  if (!authInfo) {
    res.status(401).json({ error: "unauthenticated", code: "unauthenticated" });
    return;
  }

  const b = req.body ?? {};
  const reason = typeof b.reason === "string" && DELETE_REASONS.has(b.reason) ? b.reason : null;
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) : "";
  if (!reason || (reason === "other" && !note)) {
    res.status(400).json({ error: "bad_input", code: "bad_input" });
    return;
  }

  try {
    if (!(await isCaseReporter(authInfo.uid, caseId))) {
      res.status(403).json({ error: "not_owner", code: "not_owner" });
      return;
    }

    const db = getAdminDb();
    const caseRef = db.collection("case").doc(caseId);
    const requestedAt = new Date().toISOString();

    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists) return { code: "not_found" as const };
      const d = snap.data() ?? {};
      if (d.status === "pending_deletion") return { code: "already_requested" as const };
      if (d.acceptedBy) return { code: "case_accepted" as const };
      if (d.status !== "pending") return { code: "case_locked" as const };

      tx.update(caseRef, {
        status: "pending_deletion",
        deletionRequest: {
          reason,
          note: note || null,
          requestedByUid: authInfo.uid,
          requestedAt,
          prevStatus: d.status,
        },
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { code: "ok" as const, title: String(d.title ?? "") };
    });

    if (outcome.code !== "ok") {
      const status = outcome.code === "not_found" ? 404 : 409;
      res.status(status).json({ error: outcome.code, code: outcome.code });
      return;
    }

    // 寄信俾 admin（失敗唔影響申請結果）
    try {
      const to = await getAdminEmails();
      if (to.length === 0) {
        console.warn(`[DeleteRequest] 搵唔到 admin 電郵，案件 ${caseId} 冇寄通知`);
      } else {
        const L = APP_DEFAULT_LANG;
        const text = tr(L, "server.email.deleteRequest.body", {
          caseId,
          title: outcome.title,
          reason: trOr(L, `server.labels.deleteReason.${reason}`, reason),
          note: note || tr(L, "server.email.common.none"),
          requester: authInfo.email || authInfo.uid,
          time: requestedAt,
          link: adminCaseLink(caseId),
        });
        await sendMail(to.join(", "), tr(L, "server.email.deleteRequest.subject", { caseId }), text);
      }
    } catch (err) {
      console.error("[DeleteRequest] email failed:", (err as Error).message);
    }

    console.log(`[DeleteRequest] case ${caseId} → pending_deletion (${reason}) by ${authInfo.uid}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[DeleteRequest] error:", (err as any)?.code, (err as Error).message);
    res.status(500).json({ error: "save_failed", code: "save_failed" });
  }
});

// ---------- 5E：留言通知報案人 ----------

// 報案人帳戶：登入咗報案嘅 uid + 已連結呢宗案件嘅帳戶
async function getReporterUids(caseId: string): Promise<string[]> {
  const db = getAdminDb();
  const [contact, linked] = await Promise.all([
    db.collection("case").doc(caseId).collection("private").doc("contact").get(),
    db.collection("usercases").where("caseIds", "array-contains", caseId).limit(10).get(),
  ]);
  const ids = new Set(linked.docs.map((d) => d.id));
  const c = contact.data()?.createdByUid;
  if (typeof c === "string" && c !== "anonymous" && UID_RE.test(c)) ids.add(c);
  return [...ids];
}

// 有人留言：喺報案人嘅 usercases 加未讀（自己留言唔通知自己）；失敗唔影響留言
async function notifyReporterOfComment(caseId: string, commenterUid: string, authorName: string, text: string) {
  try {
    const uids = (await getReporterUids(caseId)).filter((u) => u !== commenterUid);
    if (uids.length === 0) return;
    const db = getAdminDb();
    const batch = db.batch();
    for (const uid of uids) {
      batch.set(
        db.collection("usercases").doc(uid),
        {
          caseIds: FieldValue.arrayUnion(caseId),
          unread: {
            [caseId]: {
              count: FieldValue.increment(1),
              lastBy: authorName,
              preview: text.slice(0, 80),
              lastAt: FieldValue.serverTimestamp(),
            },
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    await batch.commit();
  } catch (err) {
    console.warn("[Notify] comment notify failed:", (err as Error).message);
  }
}

// ---------- 5D：案件留言 ----------
// 留言只可以經 server 寫（rules 禁止 client 寫），身份同內容全部由 server 檢查
const COMMENT_MAX_LEN = 1000;
const COMMENT_ID_RE = /^[A-Za-z0-9]{1,40}$/;
const commentRateLimitMiddleware = makeRateLimit("comment", 10, 60, "rateComment");

// 保留換行，刪走其他控制字元；連續多過 2 個空行縮返做 2 個
function cleanCommentText(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 改名之後，將呢個會員所有舊留言嘅名一齊更新（NGO / admin 留言唔用帳戶名，唔使改）
// 需要 comments.uid 嘅「集合群組」索引；未建索引會失敗，但只係 log 警告，唔影響改名本身
async function renameCommentAuthor(uid: string, username: string): Promise<void> {
  try {
    const db = getAdminDb();
    const snap = await db.collectionGroup("comments").where("uid", "==", uid).get();
    if (snap.empty) return;
    const writer = db.bulkWriter();
    snap.docs.forEach((d) => {
      if (d.data().role === "user") writer.update(d.ref, { authorName: username });
    });
    await writer.close();
  } catch (err) {
    console.warn("[Comments] rename update failed:", err);
  }
}

app.post("/api/cases/:caseId/comments", commentRateLimitMiddleware, async (req: Request, res: Response) => {
  try {
    const caseId = String(req.params.caseId || "");
    if (!CASE_ID_RE.test(caseId)) {
      res.status(400).json({ error: errMsg(req, "badCaseId"), code: "not_found" });
      return;
    }

    const authInfo = await getAuthInfo(req);
    if (!authInfo) {
      res.status(401).json({ error: errMsg(req, "loginRequired"), code: "login_required" });
      return;
    }

    const text = cleanCommentText(req.body?.text);
    if (!text) {
      res.status(400).json({ error: errMsg(req, "commentEmpty"), code: "empty" });
      return;
    }
    if (text.length > COMMENT_MAX_LEN) {
      res.status(400).json({ error: errMsg(req, "commentTooLong"), code: "too_long" });
      return;
    }

    const rawParent = req.body?.parentId;
    const parentId = rawParent === undefined || rawParent === null || rawParent === "" ? null : String(rawParent);
    if (parentId !== null && !COMMENT_ID_RE.test(parentId)) {
      res.status(400).json({ error: errMsg(req, "badParent"), code: "bad_parent" });
      return;
    }

    const db = getAdminDb();
    const caseRef = db.collection("case").doc(caseId);
    const caseSnap = await caseRef.get();
    if (!caseSnap.exists) {
      res.status(404).json({ error: errMsg(req, "caseNotFound"), code: "not_found" });
      return;
    }
    if (caseSnap.data()?.status === "pending_deletion" && authInfo.role !== "admin") {
      res.status(409).json({ error: errMsg(req, "pendingDeletion"), code: "pending_deletion" });
      return;
    }

    // 顯示名：會員用帳戶名；NGO 用機構名；admin 由前端顯示「PawPulse 管理員」
    let authorName: string | null = null;
    if (authInfo.role === "user") {
      const authUser = await getAdminAuth().getUser(authInfo.uid);
      if (!authUser.emailVerified) {
        res.status(403).json({ error: errMsg(req, "emailUnverified"), code: "email_unverified" });
        return;
      }
      const profileSnap = await db.collection("userprofiles").doc(authInfo.uid).get();
      const username = profileSnap.exists ? profileSnap.data()?.username : null;
      if (typeof username !== "string" || !username) {
        res.status(403).json({ error: errMsg(req, "profileRequired"), code: "profile_required" });
        return;
      }
      authorName = username;
    } else if (authInfo.role === "ngo" && authInfo.ngoId) {
      const ngoSnap = await db.collection("ngodatail").doc(authInfo.ngoId).get();
      const ngoName = ngoSnap.exists ? ngoSnap.data()?.name : null;
      authorName = typeof ngoName === "string" && ngoName ? ngoName : null;
    }

    // 回覆只可以掛喺同一宗案件嘅「主留言」下面（得一層）
    if (parentId) {
      const parentSnap = await caseRef.collection("comments").doc(parentId).get();
      if (!parentSnap.exists || parentSnap.data()?.parentId) {
        res.status(400).json({ error: errMsg(req, "badParent"), code: "bad_parent" });
        return;
      }
    }

    // 報案人標籤：登入咗報案（createdByUid），或者案件已連結到佢個帳戶（usercases）
    const [contactSnap, userCasesSnap] = await Promise.all([
      caseRef.collection("private").doc("contact").get(),
      db.collection("usercases").doc(authInfo.uid).get(),
    ]);
    const linkedIds = userCasesSnap.data()?.caseIds;
    const isReporter =
      contactSnap.data()?.createdByUid === authInfo.uid ||
      (Array.isArray(linkedIds) && linkedIds.includes(caseId));

    const ref = caseRef.collection("comments").doc();
    await ref.set({
      id: ref.id,
      uid: authInfo.uid,
      role: authInfo.role,
      authorName,
      ngoId: authInfo.role === "ngo" ? authInfo.ngoId : null,
      isReporter,
      text,
      parentId,
      deleted: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    await notifyReporterOfComment(
      caseId,
      authInfo.uid,
      authorName ?? (authInfo.role === "admin" ? tr(APP_DEFAULT_LANG, "server.misc.adminName") : ""),
      text
    );
    res.json({ success: true, id: ref.id });
  } catch (err) {
    console.error("[Comments] post failed:", err);
    res.status(500).json({ error: errMsg(req, "commentFailed"), code: "unknown" });
  }
});

app.delete("/api/cases/:caseId/comments/:commentId", commentRateLimitMiddleware, async (req: Request, res: Response) => {
  try {
    const caseId = String(req.params.caseId || "");
    const commentId = String(req.params.commentId || "");
    if (!CASE_ID_RE.test(caseId) || !COMMENT_ID_RE.test(commentId)) {
      res.status(400).json({ error: errMsg(req, "commentNotFound"), code: "not_found" });
      return;
    }

    const authInfo = await getAuthInfo(req);
    if (!authInfo) {
      res.status(401).json({ error: errMsg(req, "loginRequired"), code: "login_required" });
      return;
    }

    const ref = getAdminDb().collection("case").doc(caseId).collection("comments").doc(commentId);
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(404).json({ error: errMsg(req, "commentNotFound"), code: "not_found" });
      return;
    }
    const data = snap.data() || {};
    if (data.uid !== authInfo.uid && authInfo.role !== "admin") {
      res.status(403).json({ error: errMsg(req, "commentForbidden"), code: "forbidden" });
      return;
    }
    if (data.deleted) {
      res.json({ success: true });
      return;
    }

    // 軟刪除：清空內容但保留文件，下面嘅回覆唔會無咗主留言
    await ref.update({
      deleted: true,
      text: "",
      deletedAt: FieldValue.serverTimestamp(),
      deletedBy: data.uid === authInfo.uid ? "author" : "admin",
    });
    res.json({ success: true });
  } catch (err) {
    console.error("[Comments] delete failed:", err);
    res.status(500).json({ error: errMsg(req, "commentDeleteFailed"), code: "unknown" });
  }
});

// ---------- 5E：報案人打開案件，清走未讀 ----------
app.post("/api/cases/:caseId/read", caseActionRateLimitMiddleware, async (req: Request, res: Response) => {
  const caseId = String(req.params.caseId ?? "");
  if (!CASE_ID_RE.test(caseId)) {
    res.status(400).json({ error: "bad_input", code: "bad_input" });
    return;
  }
  const authInfo = await getAuthInfo(req);
  if (!authInfo) {
    res.status(401).json({ error: "unauthenticated", code: "unauthenticated" });
    return;
  }
  try {
    await getAdminDb().collection("usercases").doc(authInfo.uid).set(
      { unread: { [caseId]: FieldValue.delete() } },
      { merge: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error("[Read] error:", (err as Error).message);
    res.status(500).json({ error: "save_failed", code: "save_failed" });
  }
});

// ---------- admin 還原待刪除案件 ----------
app.post("/api/admin/cases/:caseId/restore", adminRateLimitMiddleware, async (req: Request, res: Response) => {
  const caseId = String(req.params.caseId ?? "");
  if (!CASE_ID_RE.test(caseId)) {
    res.status(400).json({ error: "bad_input", code: "bad_input" });
    return;
  }
  const authInfo = await getAuthInfo(req);
  if (authInfo?.role !== "admin") {
    res.status(403).json({ error: errMsg(req, "restoreAdminOnly"), code: "forbidden" });
    return;
  }
  try {
    const db = getAdminDb();
    const caseRef = db.collection("case").doc(caseId);
    const code = await db.runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists) return "not_found";
      const d = snap.data() ?? {};
      if (d.status !== "pending_deletion") return "not_pending_deletion";
      const prev = d.deletionRequest?.prevStatus;
      tx.update(caseRef, {
        status: NORMAL_STATUSES.includes(prev) ? prev : "pending",
        deletionRequest: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return "ok";
    });
    if (code !== "ok") {
      res.status(code === "not_found" ? 404 : 409).json({ error: code, code });
      return;
    }
    console.log(`[Restore] case ${caseId} restored by admin ${authInfo.uid}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[Restore] error:", (err as Error).message);
    res.status(500).json({ error: "save_failed", code: "save_failed" });
  }
});

// ---------- 報案人聯絡管理員（5B-3）----------
// 訊息先存入 adminmessages（寄信失敗都有紀錄），再寄信俾所有 admin
app.post("/api/cases/:caseId/contact-admin", emailIpRateLimitMiddleware, async (req: Request, res: Response) => {
  const caseId = String(req.params.caseId ?? "");
  if (!CASE_ID_RE.test(caseId)) {
    res.status(400).json({ error: "bad_input", code: "bad_input" });
    return;
  }
  const authInfo = await getAuthInfo(req);
  if (!authInfo) {
    res.status(401).json({ error: "unauthenticated", code: "unauthenticated" });
    return;
  }

  const b = req.body ?? {};
  const category = typeof b.category === "string" && CONTACT_CATEGORIES.has(b.category) ? b.category : null;
  const message = typeof b.message === "string" ? b.message.trim().slice(0, 1000) : "";
  if (!category || !message) {
    res.status(400).json({ error: "bad_input", code: "bad_input" });
    return;
  }

  try {
    if (!(await isCaseReporter(authInfo.uid, caseId))) {
      res.status(403).json({ error: "not_owner", code: "not_owner" });
      return;
    }

    const db = getAdminDb();
    const snap = await db.collection("case").doc(caseId).get();
    if (!snap.exists) {
      res.status(404).json({ error: "not_found", code: "not_found" });
      return;
    }
    const d = snap.data() ?? {};
    const sentAt = new Date().toISOString();

    const ref = await db.collection("adminmessages").add({
      caseId,
      uid: authInfo.uid,
      email: authInfo.email ?? null,
      category,
      message,
      handled: false,
      createdAt: FieldValue.serverTimestamp(),
    });

    // 寄信俾 admin（失敗唔影響結果，訊息已經存咗）
    try {
      const to = await getAdminEmails();
      if (to.length === 0) {
        console.warn(`[ContactAdmin] 搵唔到 admin 電郵，訊息 ${ref.id} 冇寄通知`);
      } else {
        const L = APP_DEFAULT_LANG;
        const categoryLabel = trOr(L, `server.labels.contactCategory.${category}`, category);
        const text = tr(L, "server.email.contactAdmin.body", {
          category: categoryLabel,
          caseId,
          title: String(d.title ?? ""),
          status: d.status ? statusLabel(L, String(d.status)) : "",
          ngo: d.acceptedBy?.ngoName ? String(d.acceptedBy.ngoName) : tr(L, "server.email.common.notYet"),
          email: authInfo.email || tr(L, "server.email.common.noEmail"),
          time: sentAt,
          messageId: ref.id,
          message,
          link: adminCaseLink(caseId),
        });
        const replyTo = authInfo.email && EMAIL_RE.test(authInfo.email) ? authInfo.email : undefined;
        await sendMail(
          to.join(", "),
          tr(L, "server.email.contactAdmin.subject", { category: categoryLabel, caseId }),
          text,
          { replyTo }
        );
      }
    } catch (err) {
      console.error("[ContactAdmin] email failed:", (err as Error).message);
    }

    console.log(`[ContactAdmin] case ${caseId} (${category}) from ${authInfo.uid}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[ContactAdmin] error:", (err as any)?.code, (err as Error).message);
    res.status(500).json({ error: "save_failed", code: "save_failed" });
  }
});

// ---------- 刪除案件（admin；案件、聯絡資料、相片一齊刪）----------

app.delete("/api/admin/cases/:caseId", adminRateLimitMiddleware, async (req: Request, res: Response) => {
  const caseId = String(req.params.caseId ?? "");
  if (!CASE_ID_RE.test(caseId)) {
    res.status(400).json({ error: errMsg(req, "badCaseId") });
    return;
  }

  const authInfo = await requireAdmin(req, res);
  if (!authInfo) return;

  try {
    const db = getAdminDb();
    const caseRef = db.collection("case").doc(caseId);

    const batch = db.batch();
    batch.delete(caseRef.collection("private").doc("contact"));
    batch.delete(caseRef.collection("private").doc("firstVersion"));
    batch.delete(caseRef.collection("private").doc("aiRun"));
    batch.delete(caseRef.collection("private").doc("aiFeedback"));
    batch.delete(caseRef);
    // analyze / analyzeEdit = AI 分析鎖（server/ai/runLock.ts）；email / dispatch = claimOnce
    for (const kind of ["analyze", "analyzeEdit", "email", "dispatch"]) {
      batch.delete(db.collection("serverLocks").doc(`${kind}_${caseId}`));
    }
    await batch.commit();

    // 成個資料夾刪（尾嗰個 "/" 防止誤刪 ID 開頭一樣嘅其他案件）
    const bucket = getAdminBucket();
    if (bucket) {
      await bucket.deleteFiles({ prefix: `animal-reports/${caseId}/` });
    }

    // 連留言一齊刪（子集合唔會跟住案件文件自動刪走）
    await db.recursiveDelete(caseRef.collection("comments"));

    console.log(`[Admin] Deleted case ${caseId} (contact + photos + comments) by ${authInfo.uid}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[Admin delete] error:", (err as Error).message);
    res.status(500).json({ error: errMsg(req, "deleteFailed") });
  }
});

// ---------- 啟動 ----------

async function startServer() {
  // 未定義嘅 API 路徑一律回 JSON 404，唔好交俾前端 SPA 回傳 HTML
  app.use("/api", (req: Request, res: Response) => {
    res.status(404).json({ error: errMsg(req, "apiNotFound") });
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // SPA fallback（Express 4 / 5 都適用）
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET") {
        next();
        return;
      }
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`PawPulse server listening on http://0.0.0.0:${PORT}`);
    if (!STORAGE_BUCKET) console.warn("[Firebase] FIREBASE_STORAGE_BUCKET 未設定：AI 分析同後備上傳會失敗");
    if (!getMailer()) console.warn("[Email] GMAIL_USER / GMAIL_APP_PASSWORD 未設定：電郵只會模擬（印喺 terminal）");
  });
}

startServer();
