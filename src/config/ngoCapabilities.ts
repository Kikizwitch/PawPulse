// NGO 能力（capabilities）：結構化標籤，用嚟同案件需要配對
// 同 specialties（自由文字，只係顯示用）分開；server（server/matching.ts）同前端（後台、配對結果）共用
// 顯示文字喺 locales 嘅 capability.*；firestore.rules 嘅 ngodatail 規則有同一份清單，改呢度要一齊改

export const NGO_CAPABILITIES = [
  'emergency_vet', // 可以即時處理危急（P0）個案
  'surgery',       // 可以做手術（骨折等）
  'neonate_care',  // 初生動物照顧（人手餵奶）
  'trapping',      // 捕捉唔可以徒手處理嘅動物、解救被困動物
  'transport',     // 可以到現場接動物
  'skin_parasite', // 皮膚病、蛆蟲處理
  'shelter',       // 長期收容
] as const;

export type NgoCapability = (typeof NGO_CAPABILITIES)[number];

export function isNgoCapability(v: unknown): v is NgoCapability {
  return typeof v === 'string' && (NGO_CAPABILITIES as readonly string[]).includes(v);
}

/** 由 Firestore 讀出嚟嘅值唔信：只保留認得嘅、去重、跟清單次序 */
export function cleanCapabilities(v: unknown): NgoCapability[] {
  if (!Array.isArray(v)) return [];
  const set = new Set(v.filter(isNgoCapability));
  return NGO_CAPABILITIES.filter((c) => set.has(c));
}
