// NGO 接手後回饋 AI 結果：實際物種、實際緊急程度、建議有冇用（存喺 private/aiFeedback，經 server 寫）
// 用嚟評估同改善 AI；唔會改變案件本身嘅緊急程度
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ClipboardCheck, Loader2 } from 'lucide-react';
import type { AdviceUseful, AiFeedback, AnimalType, StrayReport, UrgencyLevel } from '../types';
import { fetchAiFeedback, submitAiFeedback } from '../services/caseService';
import { animalLabel } from '../utils/caseLabels';
import { speciesLabel } from '../utils/aiAnalysis';

const SPECIES: (AnimalType | 'unknown')[] = ['cat', 'dog', 'bird', 'other', 'unknown'];
const URGENCY: UrgencyLevel[] = ['P0', 'P1', 'P2'];
const ADVICE: AdviceUseful[] = ['yes', 'partly', 'no', 'not_applicable'];
const NOTE_MAX = 500;

interface Props {
  report: StrayReport;
}

export const AiFeedbackForm: React.FC<Props> = ({ report }) => {
  const { t } = useTranslation(); // animalLabel() 跟語言即時更新
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // 錯誤只記翻譯 key，轉語言會跟住轉
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [form, setForm] = useState<AiFeedback>({
    actualSpecies: report.animalType,
    actualUrgency: report.urgency,
    adviceUseful: 'yes',
    note: '',
  });

  // 打開先讀之前提交過嘅回饋
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    fetchAiFeedback(report.id).then((prev) => {
      if (cancelled) return;
      if (prev) {
        setForm(prev);
        setSaved(true);
      }
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open, loaded, report.id]);

  const set = <K extends keyof AiFeedback>(k: K, v: AiFeedback[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrorKey(null);
    try {
      await submitAiFeedback(report.id, form);
      setSaved(true);
    } catch {
      setErrorKey('aiFeedback.saveFailed');
    } finally {
      setSaving(false);
    }
  };

  const aiSpecies = report.aiAnalysis ? speciesLabel(report.aiAnalysis, t) : '';
  const optionCls = (on: boolean) =>
    `px-2.5 py-1 rounded-lg text-2xs font-bold border transition-colors cursor-pointer ${
      on ? 'bg-stone-900 text-white border-stone-900' : 'bg-white text-stone-700 border-stone-300 hover:bg-stone-100'
    }`;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-2xs font-bold text-brand-700 hover:underline cursor-pointer"
      >
        <ClipboardCheck className="w-3.5 h-3.5" />
        {t('aiFeedback.open')}
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-stone-200 bg-stone-50 p-3 space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="font-bold text-stone-900">{t('aiFeedback.title')}</p>
        <button type="button" onClick={() => setOpen(false)} className="text-2xs text-stone-500 hover:underline cursor-pointer">
          {t('aiFeedback.close')}
        </button>
      </div>
      <p className="text-2xs text-stone-500">{t('aiFeedback.hint')}</p>

      {!loaded ? (
        <p className="flex items-center gap-1.5 text-stone-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {t('aiFeedback.loading')}
        </p>
      ) : (
        <>
          <fieldset className="space-y-1.5">
            <legend className="font-semibold text-stone-800">{t('aiFeedback.species')}</legend>
            <p className="text-2xs text-stone-500">
              {t('aiFeedback.aiSaid', { value: aiSpecies || t('aiFeedback.noAi') })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SPECIES.map((s) => (
                <button key={s} type="button" aria-pressed={form.actualSpecies === s} onClick={() => set('actualSpecies', s)} className={optionCls(form.actualSpecies === s)}>
                  {s === 'unknown' ? t('aiFeedback.speciesUnknown') : animalLabel(s)}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-1.5">
            <legend className="font-semibold text-stone-800">{t('aiFeedback.urgency')}</legend>
            <p className="text-2xs text-stone-500">{t('aiFeedback.aiSaid', { value: report.urgency })}</p>
            <div className="flex flex-wrap gap-1.5">
              {URGENCY.map((u) => (
                <button key={u} type="button" aria-pressed={form.actualUrgency === u} onClick={() => set('actualUrgency', u)} className={optionCls(form.actualUrgency === u)}>
                  {t(`aiCard.urgency.${u}.label`)}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-1.5">
            <legend className="font-semibold text-stone-800">{t('aiFeedback.advice')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {ADVICE.map((a) => (
                <button key={a} type="button" aria-pressed={form.adviceUseful === a} onClick={() => set('adviceUseful', a)} className={optionCls(form.adviceUseful === a)}>
                  {t(`aiFeedback.adviceOption.${a}`)}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="block space-y-1">
            <span className="font-semibold text-stone-800">{t('aiFeedback.note')}</span>
            <textarea
              value={form.note}
              maxLength={NOTE_MAX}
              onChange={(e) => set('note', e.target.value)}
              placeholder={t('aiFeedback.notePlaceholder')}
              rows={2}
              className="w-full px-2.5 py-1.5 bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-stone-950 font-bold cursor-pointer"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {saved ? t('aiFeedback.update') : t('aiFeedback.submit')}
            </button>
            {saved && !saving && (
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {t('aiFeedback.saved')}
              </span>
            )}
            {errorKey && <span className="text-rose-700">{t(errorKey)}</span>}
          </div>
        </>
      )}
    </form>
  );
};
