import React from 'react';
import { useTranslation } from 'react-i18next';
import { AIAnalysisResult } from '../types';
import { getApiLang } from '../i18n';
import { animalLabel } from '../utils/caseLabels';
import {
  adviceView,
  injurySummary,
  isStructured,
  reasonLabels,
  speciesLabel,
  unknownFindings,
  type AdviceItem,
} from '../utils/aiAnalysis';
import { Sparkles, AlertTriangle, ShieldCheck, Wrench, HeartHandshake, AlertCircle, Activity } from 'lucide-react';

interface AIAnalysisCardProps {
  analysis: AIAnalysisResult;
  compact?: boolean;
}

const URGENCY_STYLE = {
  P0: { badgeClass: 'bg-rose-600 text-white animate-pulse', bgClass: 'bg-rose-50 border-rose-200' },
  P1: { badgeClass: 'bg-brand-500 text-white', bgClass: 'bg-brand-50 border-brand-200' },
  P2: { badgeClass: 'bg-emerald-600 text-white', bgClass: 'bg-emerald-50 border-emerald-200' },
} as const;

type Level = keyof typeof URGENCY_STYLE;

export const AIAnalysisCard: React.FC<AIAnalysisCardProps> = ({ analysis, compact = false }) => {
  const { t } = useTranslation();

  const level: Level =
    analysis.urgencyLevel === 'P0' || analysis.urgencyLevel === 'P1' ? analysis.urgencyLevel : 'P2';
  const style = URGENCY_STYLE[level];
  const urgencyLabel = t(`aiCard.urgency.${level}.label`);

  // 第 3 版：緊急度由程式規則決定，顯示原因代碼同 AI 觀察；舊版：顯示 AI 寫嘅文字
  const structured = isStructured(analysis);
  const reasons = reasonLabels(analysis, t);
  const safeInjuries = injurySummary(analysis, t);
  const species = speciesLabel(analysis, t);
  const needsReview = structured && analysis.triage?.needsHumanReview === true;
  const unknowns = structured ? unknownFindings(analysis, t) : [];
  const uncertainty = structured ? analysis.uncertainty : undefined;
  const hasUncertainty =
    !!uncertainty && typeof uncertainty.unknownFindings === 'number' && typeof uncertainty.totalFindings === 'number';
  const modelSuggestion = structured ? analysis.triage?.modelSuggestion : null;
  const mismatchSpecies = Array.isArray(analysis.matching?.species) ? analysis.matching!.species : [];
  const speciesMismatch = analysis.matching?.speciesMismatch === true && mismatchSpecies.length === 2;
  // 建議：第 4 版用建議庫（逐條有審核狀態）；舊版用 AI 寫嘅文字
  const advice = adviceView(analysis, t);
  const anyPending = [...advice.firstAid, ...advice.equipment, ...advice.precautions].some((i) => i.pendingReview);
  // 建議庫嘅條目未經獸醫審核：每個分類標題旁邊顯示「待獸醫審核」（舊版 AI 文字已經有另一句提示）
  const pendingBadge = (items: AdviceItem[]) =>
    advice.source === 'library' && items.some((i) => i.pendingReview) ? (
      <span className="ml-1 px-1.5 py-0.5 text-2xs font-semibold text-amber-800 bg-amber-100 border border-amber-300 rounded">
        {t('advice.pendingReview')}
      </span>
    ) : null;
  // 信心百分比只係舊格式（冇 schemaVersion）先有：嗰個數係 AI 自己作嘅，新結果唔再顯示
  const legacyConfidence =
    !analysis.schemaVersion && typeof analysis.confidenceScore === 'number' && Number.isFinite(analysis.confidenceScore)
      ? analysis.confidenceScore
      : null;

  const analyzedTimeLabel = (() => {
    const d = new Date(analysis.analyzedAt);
    return Number.isNaN(d.getTime())
      ? t('aiCard.unknownTime')
      : d.toLocaleTimeString(getApiLang(), { hour: '2-digit', minute: '2-digit' });
  })();

  const reason = reasons[0] || t('aiCard.noReason');

  if (compact) {
    return (
      <div className={`rounded-xl p-3 border ${style.bgClass}`} id="ai-analysis-compact">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-stone-700">
            <Sparkles className="w-3.5 h-3.5 text-brand-600" />
            <span>{t('aiCard.compactTitle')}</span>
          </div>
          <span className={`px-2 py-0.5 text-xs font-bold rounded-full ${style.badgeClass}`}>{urgencyLabel}</span>
        </div>
        <p className="text-xs text-stone-700 mb-1">
          <strong className="text-stone-900">{species || t('aiCard.unknownSpecies')}</strong>
          {analysis.estimatedBreed ? ` (${analysis.estimatedBreed})` : ''}
        </p>
        <p className="text-xs text-stone-600 line-clamp-2">{reason}</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden" id="ai-analysis-card">
      <div className="bg-gradient-to-r from-stone-900 via-stone-800 to-stone-900 text-white px-5 py-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-brand-500/20 text-brand-400 flex items-center justify-center border border-brand-500/30 shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-sm tracking-wide flex items-center gap-2 flex-wrap">
              {t('aiCard.title')}
              {legacyConfidence !== null && (
                <span className="text-xs font-normal text-stone-400">
                  {t('aiCard.confidence', { pct: Math.round(legacyConfidence * 100) })}
                </span>
              )}
            </h3>
            <p className="text-xs text-stone-300">{t('aiCard.analyzedAt', { time: analyzedTimeLabel })}</p>
          </div>
        </div>

        <div className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide shadow-sm shrink-0 ${style.badgeClass}`}>
          {urgencyLabel}
        </div>
      </div>

      <div className="p-5 space-y-4">
        <p className="text-2xs text-stone-500">{t(`aiCard.urgency.${level}.sub`)}</p>

        {/* 物種唔一致（第 5 版）：配對時兩個物種都會考慮 */}
        {speciesMismatch && (
          <div className="flex items-start gap-2 text-xs text-sky-900 bg-sky-50 border border-sky-200 rounded-xl p-3">
            <AlertCircle className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
            <span className="leading-relaxed">
              {t('aiCard.speciesMismatch', { reported: animalLabel(mismatchSpecies[0]), ai: animalLabel(mismatchSpecies[1]) })}
            </span>
          </div>
        )}

        {needsReview && (
          <div className="flex items-start gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-xl p-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <span className="leading-relaxed font-medium">{t('triage.needsReview')}</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-3 border-b border-stone-100">
          <div className="bg-stone-50 rounded-xl p-3 border border-stone-200/60">
            <span className="text-xs font-medium text-stone-500 block mb-0.5">{t('aiCard.species')}</span>
            <span className="text-sm font-bold text-stone-900">{species || t('aiCard.unknown')}</span>
          </div>
          <div className="bg-stone-50 rounded-xl p-3 border border-stone-200/60">
            <span className="text-xs font-medium text-stone-500 block mb-0.5">{t('aiCard.breed')}</span>
            <span className="text-sm font-semibold text-stone-800">{analysis.estimatedBreed || t('aiCard.unknown')}</span>
          </div>
        </div>

        {analysis.appearanceDescription && (
          <div className="text-xs text-stone-600 bg-stone-50/70 p-3 rounded-xl border border-stone-200/50">
            <strong className="text-stone-800">{t('aiCard.appearance')}</strong>
            {analysis.appearanceDescription}
          </div>
        )}

        <div className={`p-3.5 rounded-xl border ${style.bgClass}`}>
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs font-bold text-stone-900 mb-0.5">
                {structured ? t('triage.reasonsTitle') : t('aiCard.reasonTitle')}
              </p>
              {structured && reasons.length > 0 ? (
                <ul className="list-disc pl-4 space-y-0.5">
                  {reasons.map((r, idx) => (
                    <li key={idx} className="text-xs text-stone-700 leading-relaxed">{r}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-stone-700 leading-relaxed">{reason}</p>
              )}
              {structured && (
                <p className="text-2xs text-stone-500 mt-1.5">
                  {typeof analysis.triage?.rulesVersion === 'string' &&
                    t('triage.rulesVersion', { version: analysis.triage.rulesVersion })}
                  {modelSuggestion && ` · ${t('triage.modelSuggestion', { level: modelSuggestion })}`}
                </p>
              )}
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center gap-1.5 text-xs font-bold text-stone-900 mb-2">
            <Activity className="w-4 h-4 text-rose-600" />
            <span>
              {structured
                ? t('triage.findingsTitle', { n: safeInjuries.length })
                : t('aiCard.injuries', { n: safeInjuries.length })}
            </span>
          </div>
          {safeInjuries.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {safeInjuries.map((injury, idx) => (
                <div key={idx} className="flex items-center gap-2 text-xs text-stone-800 bg-rose-50/60 border border-rose-100 px-3 py-2 rounded-lg">
                  <div className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
                  <span>{injury}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-stone-400">{structured ? t('triage.noNotable') : t('aiCard.noInjuries')}</p>
          )}
          {/* 取代舊嘅信心分數：有幾多項睇唔清 */}
          {hasUncertainty && (
            <p className="text-2xs text-stone-500 mt-2">
              {uncertainty!.unknownFindings > 0
                ? t('triage.uncertainty', { unknown: uncertainty!.unknownFindings, total: uncertainty!.totalFindings })
                : t('triage.allDetermined')}
              {unknowns.length > 0 && ` — ${t('triage.unknownList', { list: unknowns.join(t('aiCard.listSeparator')) })}`}
            </p>
          )}
        </div>

        {/* AI 補充說明（第 4 版）：獨立顯示，標明係 AI 生成 */}
        {advice.aiNote && (
          <div className="text-xs bg-violet-50/70 border border-violet-200 rounded-xl p-3">
            <div className="flex items-center gap-1.5 font-bold text-violet-900 mb-0.5">
              <Sparkles className="w-3.5 h-3.5 text-violet-600" />
              <span>{t('advice.aiNoteTitle')}</span>
            </div>
            <p className="text-stone-700 leading-relaxed">{advice.aiNote}</p>
            <p className="text-2xs text-violet-700/80 mt-1">{t('advice.aiNoteHint')}</p>
          </div>
        )}

        {/* 建議來源：建議庫（PawPulse 擬定，逐條顯示審核狀態）或者舊版 AI 文字（一律未審核） */}
        <p className="text-2xs text-stone-500 italic">
          {advice.source === 'library' ? anyPending && t('advice.pendingReviewHint') : t('aiCard.aiAdviceNote')}
        </p>

        <div>
          <div className="flex items-center gap-1.5 text-xs font-bold text-stone-900 mb-2">
            <Wrench className="w-4 h-4 text-blue-600" />
            <span>{t('aiCard.equipment')}</span>
            {pendingBadge(advice.equipment)}
          </div>
          {advice.equipment.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {advice.equipment.map((eq, idx) => (
                <span key={idx} className="px-2.5 py-1 text-xs font-medium text-blue-800 bg-blue-50 border border-blue-200 rounded-lg">
                  ✓ {eq.text}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-stone-400">{t('aiCard.noEquipment')}</p>
          )}
        </div>

        <div className="bg-emerald-50/70 border border-emerald-200/80 rounded-xl p-3.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-900 mb-2">
            <HeartHandshake className="w-4 h-4 text-emerald-700" />
            <span>{t('aiCard.firstAid')}</span>
            {pendingBadge(advice.firstAid)}
          </div>
          {advice.firstAid.length > 0 ? (
            <ul className="space-y-1.5">
              {advice.firstAid.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2 text-xs text-emerald-900/90 leading-relaxed">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-emerald-700/70">{t('aiCard.noFirstAid')}</p>
          )}
        </div>

        {advice.precautions.length > 0 && (
          <div className="text-xs text-brand-800 bg-brand-50/80 border border-brand-200 rounded-xl p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-brand-600 shrink-0 mt-0.5" />
            <div className="leading-relaxed">
              <strong className="flex items-center gap-1.5 text-brand-900 mb-0.5">
                {t('aiCard.precautions')}
                {pendingBadge(advice.precautions)}
              </strong>
              {advice.precautions.map((p) => p.text).join(t('aiCard.listSeparator'))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
