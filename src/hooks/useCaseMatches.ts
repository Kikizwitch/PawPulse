// 案件嘅 NGO 配對（排名喺 server 做：GET /api/cases/:caseId/matches）
// 案件嘅緊急程度／AI 結果改咗、或者 NGO 資料（容量、能力）改咗，就重新攞
import { useEffect, useState } from 'react';
import type { NgoCapability } from '../config/ngoCapabilities';
import { fetchCaseMatches, mergeMatches, type CaseMatch } from '../services/caseService';
import type { NGOOrganization, StrayReport } from '../types';

export interface CaseMatchesState {
  matchedNGOs: NGOOrganization[];
  requiredCapabilities: NgoCapability[];
  speciesMismatch: boolean;
  loading: boolean;
  /** true = 攞唔到配對（顯示「暫時未能配對」，唔可以當冇機構） */
  error: boolean;
}

export function useCaseMatches(report: StrayReport | null, ngos: NGOOrganization[]): CaseMatchesState {
  const [matches, setMatches] = useState<CaseMatch[]>([]);
  const [required, setRequired] = useState<NgoCapability[]>([]);
  const [mismatch, setMismatch] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const caseId = report?.id ?? null;
  const caseKey = report ? `${report.urgency}|${report.aiAnalysis?.analyzedAt ?? ''}|${report.animalType}` : '';
  // 只有影響排名嘅 NGO 欄位改咗先重新攞
  const ngoKey = ngos
    .map((n) => `${n.id}:${n.capacityStatus ?? ''}:${(n.capabilities ?? []).join(',')}:${n.hasEmergencyRescue ? 1 : 0}`)
    .join('|');

  useEffect(() => {
    if (!caseId) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchCaseMatches(caseId)
      .then((r) => {
        if (cancelled) return;
        setMatches(r.matches);
        setRequired(r.requiredCapabilities);
        setMismatch(r.speciesMismatch);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[Matches] fetch failed:', err);
        setMatches([]);
        setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId, caseKey, ngoKey]);

  return {
    matchedNGOs: mergeMatches(ngos, matches),
    requiredCapabilities: required,
    speciesMismatch: mismatch,
    loading,
    error,
  };
}
