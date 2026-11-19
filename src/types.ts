import type { NgoCapability } from './config/ngoCapabilities';

// ⚠️ 已加入 'bird'，同 firestore.rules 及 entities schema 對齊。
// 如果產品範圍確實不打算處理雀鳥案件，請反過來喺 Rules／schema 移除 bird。
export type AnimalType = 'cat' | 'dog' | 'bird' | 'other';
// 報案人喺「現場狀況」揀嘅標籤（可以揀多個），用嚟喺地圖同個案頁篩選
export type CaseTag = 'stray' | 'injured' | 'trapped' | 'juvenile' | 'adult';

export type UrgencyLevel = 'P0' | 'P1' | 'P2'; // P0: 極度緊急(重傷/瀕危), P1: 需醫療關注(骨折/明顯傷病), P2: 穩定(走失/幼崽/普通救助)

// ⚠️ 已移除 'analyzed' 與 'dispatched'，因為目前 firestore.rules 嘅
// isValidCase() 只接受 pending/in_progress/rescued/closed 四個值，
// 寫入其他兩個值會被 Firestore 直接拒絕。如果你有計劃將來引入
// 更細緻嘅分階段狀態，請同時擴充 firestore.rules 嘅 enum。
export type CaseStatus = 'pending' | 'in_progress' | 'rescued' | 'closed' | 'pending_deletion';

export type NGOCapacityStatus = 'available' | 'busy' | 'full';

/**
 * AI 分析進度（只由 server 寫；報案時必須冇或者係 null）
 * queued = 已排隊；running = 分析中；done = 完成；failed = 失敗（案件維持 P1）；skipped = 冇分析（例如超出每日額度）
 */
export type AiStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';
export const AI_STATUSES: AiStatus[] = ['queued', 'running', 'done', 'failed', 'skipped'];

export interface LocationCoords {
  lat: number;
  lng: number;
  address: string;
  district?: string;
}

// ---------- AI 觀察結果（schemaVersion 3 起）----------
// 值嘅清單由 server/ai/findings.ts（Zod）定義；兩邊唔一致 lint 會失敗
export type TriState = 'yes' | 'no' | 'unknown';

/** Gate：張相用唔用得 */
export interface AIGate {
  animalVisible: boolean;
  imageUsable: boolean;
  speciesCategory: AnimalType | 'unknown';
}

/** Observe：AI 睇到啲乜；睇唔清就係 unknown */
export interface AIFindings {
  ageClass: 'neonate' | 'juvenile' | 'adult' | 'senior' | 'unknown';
  consciousness: 'alert' | 'dull' | 'unresponsive' | 'appears_dead' | 'unknown';
  mobility: 'normal' | 'limping' | 'unable_to_stand' | 'unknown';
  bleeding: 'none' | 'minor' | 'heavy' | 'unknown';
  breathingDistress: 'none' | 'mild' | 'severe' | 'unknown';
  traumaVehicle: TriState;
  traumaFall: TriState;
  traumaBite: TriState;
  traumaEntrapment: TriState;
  wounds: 'none' | 'present' | 'unknown';
  woundTypes: ('open_wound' | 'fracture_deformity' | 'burn' | 'eye_injury' | 'skin_disease' | 'maggots' | 'other')[];
  bodyCondition: 'emaciated' | 'thin' | 'normal' | 'overweight' | 'unknown';
}

/** 證據：觀察喺邊張相睇到（photo = 案件 photos[] 位置，0 = 封面） */
export interface AIEvidence {
  finding: keyof AIFindings;
  photo: number;
}

/** 由程式（server/ai/triage.ts）決定嘅緊急程度，唔係 AI 決定 */
export interface AITriage {
  /** 原因代碼；顯示文字喺 locales 嘅 triage.reason.* */
  reasonCodes: string[];
  needsHumanReview: boolean;
  /** 規則表版本，例如 triage.v1 */
  rulesVersion: string;
  /** AI 自己建議嘅等級（只可以提高，唔可以降低） */
  modelSuggestion: UrgencyLevel | null;
}

/** 取代舊嘅信心分數：有幾多項睇唔清、張相用唔用得 */
export interface AIUncertainty {
  unknownFindings: number;
  totalFindings: number;
  animalVisible: boolean;
  imageUsable: boolean;
}

/** 配對需要（第 5 版起，server/ai/capabilities.ts 按觀察計） */
export interface AIMatching {
  /** 案件可能需要嘅 NGO 能力 */
  requiredCapabilities: NgoCapability[];
  /** AI 判斷嘅物種同報案人揀嘅唔同（配對時兩個都考慮） */
  speciesMismatch: boolean;
  /** 配對時考慮嘅物種 */
  species: AnimalType[];
  rulesVersion: string;
}

/** 由建議庫揀出嘅建議代碼（第 4 版起）；文字喺 locales 嘅 advice.*，審核狀態喺 config/adviceLibrary.ts */
export interface AIAdvice {
  firstAid: string[];
  equipment: string[];
  precautions: string[];
  libraryVersion: string;
}

// AI 分析結果（由 server 寫入 case.aiAnalysis）。舊案件可能仲係舊格式，前端全部版本都要識顯示
// schemaVersion：冇 = 1（有 confidenceScore）；2 = 冇 confidenceScore；3 = 有 gate / findings / triage；
// 4 = 建議改用建議庫代碼（advice），AI 最多補充一句（aiNote）；5 = 加 matching（需要嘅 NGO 能力、物種唔一致）
export interface AIAnalysisResult {
  schemaVersion?: number;
  /** 第 1、2 版：AI 寫嘅品種文字；第 3 版改用 gate.speciesCategory */
  identifiedSpecies?: string;
  estimatedBreed: string;
  appearanceDescription: string;
  /** 第 1、2 版：AI 寫嘅傷勢文字；第 3 版改用 findings */
  apparentInjuries?: string[];
  /** 第 3 版起由 triage 決定 */
  urgencyLevel: UrgencyLevel;
  /** 第 1、2 版：AI 寫嘅原因；第 3 版改用 triage.reasonCodes */
  urgencyReason?: string;
  /** 第 1–3 版：AI 寫嘅建議文字（未經審核）；第 4 版改用 advice */
  rescueEquipment?: string[];
  firstAidAdvice?: string[];
  handlingPrecautions?: string[];
  /** 第 4 版：建議庫代碼 */
  advice?: AIAdvice;
  /** 第 4 版：AI 補充嘅一句說明（未經審核，前端要標明係 AI 生成）；冇就係空字串 */
  aiNote?: string;
  /** 第 5 版：配對需要 */
  matching?: AIMatching;
  gate?: AIGate;
  findings?: AIFindings;
  evidence?: AIEvidence[];
  triage?: AITriage;
  uncertainty?: AIUncertainty;
  /** 只有舊格式先有：AI 自己作嘅數字（0.70–0.99），唔係真正信心，新結果唔再寫 */
  confidenceScore?: number;
  /** 可能含血腥／令人不安畫面嘅相片位置（0 = 封面）；冇呢個欄位 = 未檢查，當有問題 */
  sensitivePhotos?: number[];
  analyzedAt: string;
}

export interface NGOOrganization {
  id: string;
  name: string;
  englishName: string;
  hotline: string;
  whatsapp?: string;
  publicEmail?: string;  // 公開電郵（報案人睇到），唔係登入用
  website?: string;      // 只接受 http(s):// 開頭
  address: string;
  district: string;
  lat: number;
  lng: number;
  acceptedAnimals: AnimalType[];
  /** 自由文字專長（只係顯示用） */
  specialties: string[];
  /** 結構化能力（配對用）；冇呢個欄位 = 未標記，配對時唔加分亦唔扣分 */
  capabilities?: NgoCapability[];
  operatingHours: string;
  hasEmergencyRescue: boolean;
  capacityStatus?: NGOCapacityStatus;
  // 以下由 server 配對（GET /api/cases/:caseId/matches）計出嚟，唔會儲存
  distanceKm?: number;
  driveTimeMins?: number;
  matchScore?: number;
  /** 案件需要而呢間機構有嘅能力 */
  matchedCapabilities?: NgoCapability[];
  /** 案件需要但呢間機構冇嘅能力（機構未標記能力就係空） */
  missingCapabilities?: NgoCapability[];
}

// 機構登入帳戶（ngouser/{uid}），只有 admin 同本人讀到
export interface NgoAccount {
  uid: string;
  email: string;
  ngoId: string;
}

export interface CasePhoto {
  url: string;   // Storage 下載網址
  path: string;  // animal-reports/{caseId}/{index}.jpg
}

/** NGO 接手紀錄（公開資料，唔放職員電郵） */
export interface CaseAcceptance {
  ngoId: string;
  ngoName: string;
  acceptedByUid: string;
  acceptedAt: string;
}

export type DeleteReason = 'duplicate' | 'resolved' | 'wrong_info' | 'privacy' | 'mistake' | 'other';
export type ContactCategory = 'update' | 'delete' | 'photo' | 'status' | 'other';

export interface DeletionRequest {
  reason: DeleteReason;
  note: string | null;
  requestedAt: string;
}

export interface StrayReport {
  id: string; // Case ID
  title: string;
  animalType: AnimalType;
  customAnimalName?: string;
  tags?: CaseTag[];
  photoUrl: string; // Cloud Storage public URL or served URL
  storagePath?: string; // Cloud Storage object path linked to this case
  photos: CasePhoto[];   // 全部相（第 1 張 = photoUrl 封面）
  acceptedBy?: CaseAcceptance;
  location: LocationCoords;
  description: string;
  reporterName: string;
  reporterPhone: string;
  reporterEmail?: string;
  createdByUid?: string;
  createdAt: string;
  status: CaseStatus;
  urgency: UrgencyLevel;
  /** 舊欄位：以前同 aiAnalysis 一模一樣，新結果唔再寫；docToReport 只用嚟補返舊案件嘅 aiAnalysis */
  geminiResponse?: AIAnalysisResult | null;
  aiAnalysis?: AIAnalysisResult | null;
  /** AI 分析進度；舊案件冇呢個欄位 */
  aiStatus?: AiStatus | null;
  matchedNGOs?: NGOOrganization[];
  editCount?: number;       // 報案人改咗幾多次（最多 1）
  editedAt?: string | null; // 最後修改時間（ISO）
  deletionRequest?: DeletionRequest | null; // 只有待刪除案件有
  dispatchedToNGO?: {
    ngoId: string;
    ngoName: string;
    dispatchedAt: string;
    status: 'sent' | 'acknowledged' | 'en_route' | 'arrived';
    // ⚠️ 新增：反映伺服器目前尚未串接真實推播服務嘅誠實標記，
    // 對應 server.ts /api/ngo/notify 回傳嘅 simulated 欄位
    simulated?: boolean;
  };
}

/** NGO 對 AI 結果嘅回饋：case/{caseId}/private/aiFeedback（只可以經 server 寫；admin 同接手咗嘅 NGO 讀到） */
export type AdviceUseful = 'yes' | 'partly' | 'no' | 'not_applicable';
export interface AiFeedback {
  actualSpecies: AnimalType | 'unknown';
  actualUrgency: UrgencyLevel;
  adviceUseful: AdviceUseful;
  note: string;
}

export type CommentRole = 'user' | 'ngo' | 'admin';

// case/{caseId}/comments/{id}：只可以經 server 寫
export interface CaseComment {
  id: string;
  uid: string;
  role: CommentRole;
  authorName: string | null; // admin 係 null，前端顯示「PawPulse 管理員」
  isReporter: boolean;
  text: string;
  parentId: string | null; // null = 主留言；回覆只得一層
  deleted: boolean;
  createdAt: string; // ISO
}


// 登入後嘅身份；未登入就係 null（唔係呢度其中一個值）
export type UserRole = 'user' | 'ngo' | 'admin';

/** 會員資料：userprofiles/{uid}（只有本人同 admin 讀得到；只可以經 server 寫） */
export interface MemberProfile {
  firstName: string;
  lastName: string;
  username: string;
  /** 上次改帳戶名嘅時間（毫秒）；第一次設定唔計，所以係 null */
  usernameChangedAt?: number | null;
}
