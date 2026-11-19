// NGO 配對（由前端搬到 server）：按距離、物種、緊急程度、能力、容量計分
// 純函數，唔讀寫 Firestore；GET /api/cases/:caseId/matches 用佢
//
// ======================= 計分表（非工程人員都可以審閱）=======================
// ⚠️ 待救援團隊審核：分數係工程團隊草擬（距離同物種嘅分數沿用舊版前端）
import { cleanCapabilities, type NgoCapability } from "../src/config/ngoCapabilities";
import type { AIMatching, AnimalType, NGOCapacityStatus, UrgencyLevel } from "../src/types";

export const SCORE = {
  base: 100,
  perKm: -3.5,            // 每公里扣分
  acceptsSpecies: 25,     // 接收呢個物種（物種唔一致時，接收其中一種就算）
  rejectsSpecies: -40,
  p0Emergency: 35,        // P0 案件：有 24 小時緊急救援
  p0NoEmergency: -25,
  capabilityMatch: 12,    // 案件需要而機構有嘅每種能力
  capabilityMissing: -8,  // 案件需要而機構冇嘅每種能力（機構未標記能力就唔扣）
  busy: -15,
  full: -50,
  min: 10,
  max: 99,
} as const;

/** 估計車程：每公里 2.5 分鐘，最少 5 分鐘（粗略估計，唔係真實路線） */
export const DRIVE_MINS_PER_KM = 2.5;
// ===========================================================================

export const MATCHING_VERSION = "ranking.v1";

/** 配對用嘅 NGO 資料（由 Firestore 讀出嚟後清洗） */
export interface MatchNgo {
  id: string;
  lat: number;
  lng: number;
  acceptedAnimals: string[];
  hasEmergencyRescue: boolean;
  capacityStatus: NGOCapacityStatus;
  /** null = 機構未標記能力 */
  capabilities: NgoCapability[] | null;
}

export interface MatchContext {
  lat: number;
  lng: number;
  level: UrgencyLevel;
  matching: AIMatching;
}

export interface MatchResult {
  ngoId: string;
  matchScore: number;
  distanceKm: number;
  driveTimeMins: number;
  matchedCapabilities: NgoCapability[];
  missingCapabilities: NgoCapability[];
  /** 加減分原因（log 同除錯用） */
  reasons: string[];
}

export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

/** Firestore 嘅 ngodatail 文件 → MatchNgo；座標唔啱就回傳 null（唔參與配對） */
export function toMatchNgo(id: string, d: Record<string, unknown> | undefined): MatchNgo | null {
  const lat = Number(d?.lat);
  const lng = Number(d?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const cap = d?.capacityStatus;
  return {
    id,
    lat,
    lng,
    acceptedAnimals: Array.isArray(d?.acceptedAnimals) ? d!.acceptedAnimals.filter((x): x is string => typeof x === "string") : [],
    hasEmergencyRescue: d?.hasEmergencyRescue === true,
    capacityStatus: cap === "busy" || cap === "full" ? cap : "available",
    capabilities: Array.isArray(d?.capabilities) ? cleanCapabilities(d!.capabilities) : null,
  };
}

export function scoreNgo(ngo: MatchNgo, ctx: MatchContext): MatchResult {
  const reasons: string[] = [];
  const km = distanceKm(ctx.lat, ctx.lng, ngo.lat, ngo.lng);
  let score: number = SCORE.base + km * SCORE.perKm;

  const species: AnimalType[] = ctx.matching.species;
  if (species.some((s) => ngo.acceptedAnimals.includes(s))) {
    score += SCORE.acceptsSpecies;
    reasons.push("accepts_species");
  } else {
    score += SCORE.rejectsSpecies;
    reasons.push("species_not_accepted");
  }

  if (ctx.level === "P0") {
    score += ngo.hasEmergencyRescue ? SCORE.p0Emergency : SCORE.p0NoEmergency;
    reasons.push(ngo.hasEmergencyRescue ? "emergency_rescue" : "no_emergency_rescue");
  }

  const matched: NgoCapability[] = [];
  const missing: NgoCapability[] = [];
  if (ngo.capabilities === null) {
    if (ctx.matching.requiredCapabilities.length > 0) reasons.push("capabilities_untagged");
  } else {
    for (const c of ctx.matching.requiredCapabilities) {
      if (ngo.capabilities.includes(c)) {
        matched.push(c);
        score += SCORE.capabilityMatch;
      } else {
        missing.push(c);
        score += SCORE.capabilityMissing;
      }
    }
  }

  if (ngo.capacityStatus === "busy") {
    score += SCORE.busy;
    reasons.push("busy");
  } else if (ngo.capacityStatus === "full") {
    score += SCORE.full;
    reasons.push("full");
  }

  return {
    ngoId: ngo.id,
    matchScore: Math.max(SCORE.min, Math.min(SCORE.max, Math.round(score))),
    distanceKm: km,
    driveTimeMins: Math.max(5, Math.round(km * DRIVE_MINS_PER_KM)),
    matchedCapabilities: matched,
    missingCapabilities: missing,
    reasons,
  };
}

/** 排名：分數高先；同分就近先；再同就按 ID（結果穩定） */
export function rankNgos(ngos: MatchNgo[], ctx: MatchContext, limit = 3): MatchResult[] {
  return ngos
    .map((n) => scoreNgo(n, ctx))
    .sort((a, b) => b.matchScore - a.matchScore || a.distanceKm - b.distanceKm || a.ngoId.localeCompare(b.ngoId))
    .slice(0, limit);
}
