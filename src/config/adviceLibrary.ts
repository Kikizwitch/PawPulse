// 建議庫：現場急救、救援裝備、注意事項（顯示文字喺 locales 嘅 advice.firstAid.* / advice.equipment.* / advice.precautions.*）
// server（server/ai/advice.ts 揀邊幾條）同前端（顯示「待獸醫審核」）都讀呢個檔
//
// ⚠️ 待獸醫審核：以下全部條目都係 PawPulse 團隊草擬，未經獸醫審核。
//    獸醫審核完一條，就將 status 改做 'vet_reviewed' 並填 reviewedAt（YYYY-MM-DD）；
//    改咗文字就要改返 'pending_vet_review'。前端會即時跟住顯示，舊案件都會更新
// 唔可以喺建議入面加任何電話號碼（緊急熱線只可以放 config/emergency.ts，而且要親自核實）

export const ADVICE_LIBRARY_VERSION = 'advice.v1';

export type AdviceCategory = 'firstAid' | 'equipment' | 'precautions';
export type AdviceReviewStatus = 'pending_vet_review' | 'vet_reviewed';

export interface AdviceEntry {
  status: AdviceReviewStatus;
  reviewedAt?: string;
}

const PENDING: AdviceEntry = { status: 'pending_vet_review' };

export const ADVICE_LIBRARY: Record<AdviceCategory, Record<string, AdviceEntry>> = {
  // 報案市民喺現場可以做／唔好做嘅嘢
  firstAid: {
    keep_distance: PENDING,
    urgent_contact_vet: PENDING,
    add_clearer_photo: PENDING,
    avoid_moving_spine: PENDING,
    gentle_pressure_bleeding: PENDING,
    keep_airway_clear: PENDING,
    do_not_shake_check_breathing: PENDING,
    possibly_deceased_no_bare_hands: PENDING,
    do_not_pull_free: PENDING,
    do_not_splint: PENDING,
    no_home_remedies: PENDING,
    do_not_touch_eye: PENDING,
    do_not_remove_maggots: PENDING,
    neonate_watch_for_mother: PENDING,
    neonate_keep_warm_no_milk: PENDING,
    keep_warm: PENDING,
    bird_dark_box: PENDING,
    do_not_chase: PENDING,
    no_food_water_medicine: PENDING,
    keep_quiet: PENDING,
    stay_and_observe: PENDING,
  },
  // NGO 救援隊要帶嘅裝備
  equipment: {
    gloves: PENDING,
    towel_blanket: PENDING,
    carrier: PENDING,
    slip_lead: PENDING,
    ventilated_box: PENDING,
    stretcher_board: PENDING,
    first_aid_kit: PENDING,
    cutting_tools: PENDING,
    heat_source: PENDING,
  },
  // 市民同救援人員嘅安全注意事項
  precautions: {
    bite_scratch_risk: PENDING,
    traffic_safety: PENDING,
    support_spine: PENDING,
    protect_injured_limb: PENDING,
    avoid_skin_contact: PENDING,
    deceased_handling: PENDING,
    bird_minimal_handling: PENDING,
    wash_hands: PENDING,
  },
};

export const ADVICE_CATEGORIES: AdviceCategory[] = ['firstAid', 'equipment', 'precautions'];

/** 呢條建議係咪仲未經獸醫審核；唔認得嘅代碼當未審核（fail-closed） */
export function isPendingReview(category: AdviceCategory, code: string): boolean {
  return ADVICE_LIBRARY[category]?.[code]?.status !== 'vet_reviewed';
}
