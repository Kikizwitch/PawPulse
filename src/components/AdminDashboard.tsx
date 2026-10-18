import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StrayReport, NGOOrganization, CaseStatus, AnimalType, NGOCapacityStatus, NgoAccount } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { monitoring, SystemLogEvent } from '../utils/monitoring';
import {
  ShieldCheck,
  Building2,
  Trash2,
  Plus,
  Clock,
  Terminal,
  RefreshCw,
  LogOut,
  Mail,
  Activity,
  X,
  Globe,
  UserPlus,
  KeyRound,
} from 'lucide-react';
import {
  fetchCaseContact,
  ReporterContactInfo,
  createNgoAccount,
  deleteNgoAccount,
  subscribeToNgoAccounts,
} from '../services/caseService';
import AddressAutocomplete from './AddressAutocomplete';
import { isCoverSensitive } from '../utils/sensitivePhotos';
import { getApiLang, getAppLang } from '../i18n';

interface AdminDashboardProps {
  reports: StrayReport[];
  ngos: NGOOrganization[];
  onSelectReport: (report: StrayReport) => void; // 按標題開啟個案詳情
  onUpdateCaseStatus: (caseId: string, status: CaseStatus) => void;
  onDeleteCase: (caseId: string) => void;
  onUpdateNGOCapacity: (ngoId: string, capacity: NGOCapacityStatus) => void;
  onCreateNGO: (ngo: NGOOrganization) => Promise<boolean>; // true = 已寫入 Firestore
  onDeleteNGO: (ngoId: string) => void;
}

const ANIMAL_TYPES: AnimalType[] = ['cat', 'dog', 'bird', 'other'];
const CASE_STATUS_OPTIONS: CaseStatus[] = ['pending', 'in_progress', 'rescued', 'closed'];
const CAPACITY_OPTIONS: NGOCapacityStatus[] = ['available', 'busy', 'full'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LOGIN_EMAILS = 5;
const INPUT_CLS =
  'w-full p-2.5 bg-stone-50 border border-stone-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-500';

// 網站連結只接受 http(s)，防止 javascript: 之類的連結
const safeWebsite = (url?: string) => (url && /^https?:\/\//i.test(url) ? url : null);

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-2xs font-bold uppercase tracking-wider text-stone-400 pt-2">{children}</p>
);

const CAPACITY_BADGE: Record<string, string> = {
  available: 'bg-emerald-100 text-emerald-800',
  busy: 'bg-amber-100 text-amber-800',
  full: 'bg-rose-100 text-rose-800',
};
const CAPACITY_ACTIVE: Record<string, string> = {
  available: 'bg-emerald-600 text-white',
  busy: 'bg-amber-600 text-white',
  full: 'bg-rose-600 text-white',
};

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  reports,
  ngos,
  onSelectReport,
  onUpdateCaseStatus,
  onDeleteCase,
  onUpdateNGOCapacity,
  onCreateNGO,
  onDeleteNGO,
}) => {
  const { t } = useTranslation();
  const { user, isAdmin, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<'cases' | 'ngos' | 'logs'>('cases');
  const [logs, setLogs] = useState<SystemLogEvent[]>(monitoring.getRecentLogs());
  const [showAddNGOModal, setShowAddNGOModal] = useState(false);
  const [savingNGO, setSavingNGO] = useState(false);

  // 機構資料（公開）
  const [newNGOName, setNewNGOName] = useState('');
  const [newNGOEnglishName, setNewNGOEnglishName] = useState('');
  const [newNGOHotline, setNewNGOHotline] = useState('');
  const [newNGOWhatsapp, setNewNGOWhatsapp] = useState('');
  const [newNGOPublicEmail, setNewNGOPublicEmail] = useState('');
  const [newNGOWebsite, setNewNGOWebsite] = useState('');
  const [newNGOAddress, setNewNGOAddress] = useState('');
  const [newNGODistrict, setNewNGODistrict] = useState('');
  const [newNGOLat, setNewNGOLat] = useState('');
  const [newNGOLng, setNewNGOLng] = useState('');
  const [newNGOOperatingHours, setNewNGOOperatingHours] = useState(() => t('adminDashboard.form.defaultHours'));
  const [newNGO24h, setNewNGO24h] = useState(true);
  const [newNGOSpecialties, setNewNGOSpecialties] = useState(() => t('adminDashboard.form.defaultSpecialties'));
  const [newNGOAcceptedAnimals, setNewNGOAcceptedAnimals] = useState<AnimalType[]>(['cat', 'dog']);

  // 登入帳戶（不公開）
  const [newLoginEmails, setNewLoginEmails] = useState<string[]>(['']);
  const [ngoAccounts, setNgoAccounts] = useState<NgoAccount[]>([]);
  const [addAccountInput, setAddAccountInput] = useState<Record<string, string>>({});
  const [busyAccountKey, setBusyAccountKey] = useState<string | null>(null);

  const [revealedContacts, setRevealedContacts] = useState<Record<string, ReporterContactInfo | null>>({});
  const [loadingContactId, setLoadingContactId] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    return subscribeToNgoAccounts(setNgoAccounts, (err) => console.warn('NGO accounts sync warning:', err));
  }, [isAdmin]);

  const accountsByNgo = useMemo(() => {
    const map: Record<string, NgoAccount[]> = {};
    for (const a of ngoAccounts) (map[a.ngoId] ||= []).push(a);
    return map;
  }, [ngoAccounts]);

  const animalName = (a: string) => t(`adminDashboard.animals.${a}`, { defaultValue: a });

  const handleRefreshLogs = () => {
    setLogs(monitoring.getRecentLogs());
  };

  const toggleAcceptedAnimal = (type: AnimalType) => {
    setNewNGOAcceptedAnimals((prev) =>
      prev.includes(type) ? prev.filter((x) => x !== type) : [...prev, type]
    );
  };

  const resetNGOForm = () => {
    setNewNGOName('');
    setNewNGOEnglishName('');
    setNewNGOHotline('');
    setNewNGOWhatsapp('');
    setNewNGOPublicEmail('');
    setNewNGOWebsite('');
    setNewNGOAddress('');
    setNewNGODistrict('');
    setNewNGOLat('');
    setNewNGOLng('');
    setNewNGOOperatingHours(t('adminDashboard.form.defaultHours'));
    setNewNGO24h(true);
    setNewNGOSpecialties(t('adminDashboard.form.defaultSpecialties'));
    setNewNGOAcceptedAnimals(['cat', 'dog']);
    setNewLoginEmails(['']);
  };

  const closeAddNGOModal = () => {
    if (savingNGO) return;
    setShowAddNGOModal(false);
  };

  // 逐個電郵建立帳戶，收集結果
  const createAccounts = async (ngoId: string, emails: string[]) => {
    const links: string[] = [];
    const failed: string[] = [];
    for (const email of emails) {
      try {
        const r = await createNgoAccount(ngoId, email, getAppLang());
        if (!r.emailed && r.link) links.push(`${email}\n${r.link}`);
      } catch (err: any) {
        failed.push(t('adminDashboard.accounts.failedItem', { email, error: err?.message || String(err) }));
      }
    }
    return { links, failed };
  };

  const reportAccountResults = (links: string[], failed: string[]) => {
    if (links.length > 0) {
      console.info('[NGO accounts] simulated mail mode, set-password links:\n\n' + links.join('\n\n'));
    }
    const msgs: string[] = [];
    if (failed.length > 0) msgs.push(`${t('adminDashboard.accounts.failedHeader')}\n${failed.join('\n')}`);
    if (links.length > 0) msgs.push(t('adminDashboard.accounts.simulated'));
    if (msgs.length > 0) alert(msgs.join('\n\n'));
  };

  const handleSaveNewNGO = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingNGO) return;

    if (!newNGOName.trim() || !newNGOHotline.trim()) {
      alert(t('adminDashboard.errors.required'));
      return;
    }

    const parsedLat = parseFloat(newNGOLat);
    const parsedLng = parseFloat(newNGOLng);
    if (
      !Number.isFinite(parsedLat) || parsedLat < -90 || parsedLat > 90 ||
      !Number.isFinite(parsedLng) || parsedLng < -180 || parsedLng > 180
    ) {
      alert(t('adminDashboard.errors.location'));
      return;
    }

    const publicEmail = newNGOPublicEmail.trim();
    if (publicEmail && !EMAIL_RE.test(publicEmail)) {
      alert(t('adminDashboard.errors.publicEmail'));
      return;
    }

    const website = newNGOWebsite.trim();
    if (website && !safeWebsite(website)) {
      alert(t('adminDashboard.errors.website'));
      return;
    }

    // 登入電郵：去空白、轉小寫、去重複
    const loginEmails = Array.from(
      new Set<string>(newLoginEmails.map((s) => s.trim().toLowerCase()).filter(Boolean))
    );
    const badEmail = loginEmails.find((s) => !EMAIL_RE.test(s));
    if (badEmail) {
      alert(t('adminDashboard.accounts.invalidEmailWith', { email: badEmail }));
      return;
    }

    const ngoId = `ngo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const newOrg: NGOOrganization = {
      id: ngoId,
      name: newNGOName.trim(),
      englishName: newNGOEnglishName.trim() || newNGOName.trim(),
      hotline: newNGOHotline.trim(),
      whatsapp: newNGOWhatsapp.replace(/\D/g, '') || undefined,
      publicEmail: publicEmail || undefined,
      website: website || undefined,
      address: newNGOAddress.trim(),
      district: newNGODistrict.trim() || t('adminDashboard.form.districtPending'),
      lat: parsedLat,
      lng: parsedLng,
      acceptedAnimals: newNGOAcceptedAnimals.length > 0 ? newNGOAcceptedAnimals : ['cat', 'dog', 'other'],
      // 中英文逗號及頓號都接受
      specialties: newNGOSpecialties
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean),
      operatingHours: newNGOOperatingHours.trim(),
      hasEmergencyRescue: newNGO24h,
      capacityStatus: 'available',
    };

    setSavingNGO(true);
    try {
      // 1. 先建立機構；失敗就停止（App.tsx 已提示）
      const ok = await onCreateNGO(newOrg);
      if (!ok) return;

      // 2. 再建立登入帳戶；失敗不影響機構資料，之後可在機構卡片再新增
      const { links, failed } = await createAccounts(ngoId, loginEmails);
      setShowAddNGOModal(false);
      resetNGOForm();
      reportAccountResults(links, failed);
    } finally {
      setSavingNGO(false);
    }
  };

  const handleAddAccount = async (ngoId: string) => {
    const email = (addAccountInput[ngoId] || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      alert(t('adminDashboard.accounts.invalidEmail'));
      return;
    }
    setBusyAccountKey(`add:${ngoId}`);
    const { links, failed } = await createAccounts(ngoId, [email]);
    setBusyAccountKey(null);
    if (failed.length === 0) setAddAccountInput((prev) => ({ ...prev, [ngoId]: '' }));
    reportAccountResults(links, failed);
  };

  const handleRemoveAccount = async (account: NgoAccount) => {
    if (!confirm(t('adminDashboard.accounts.confirmRemove', { email: account.email || account.uid }))) return;
    setBusyAccountKey(account.uid);
    try {
      await deleteNgoAccount(account.uid);
    } catch (err: any) {
      alert(t('adminDashboard.accounts.removeFailed', { error: err?.message || String(err) }));
    } finally {
      setBusyAccountKey(null);
    }
  };

  const updateLoginEmail = (index: number, value: string) => {
    setNewLoginEmails((prev) => prev.map((v, i) => (i === index ? value : v)));
  };

  const removeLoginEmailRow = (index: number) => {
    setNewLoginEmails((prev) => (prev.length <= 1 ? [''] : prev.filter((_, i) => i !== index)));
  };

  // 用 `caseId in revealedContacts` 分辨「未讀取」與「讀取後確認沒有資料（null）」
  const handleRevealContact = async (caseId: string) => {
    if (caseId in revealedContacts) return;
    setLoadingContactId(caseId);
    const data = await fetchCaseContact(caseId);
    setRevealedContacts((prev) => ({ ...prev, [caseId]: data }));
    setLoadingContactId(null);
  };

  // App.tsx 只會在 admin 身分時顯示此頁；這裡再檢查一次
  if (!user || !isAdmin) return null;

  const tabClass = (tab: typeof activeTab) =>
    `px-4 py-2 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 cursor-pointer ${
      activeTab === tab ? 'bg-stone-900 text-white shadow-xs' : 'bg-white text-stone-700 hover:bg-stone-100 border border-stone-200'
    }`;

  return (
    <div className="space-y-6" id="admin-dashboard-view">
      <div className="bg-stone-900 text-white rounded-3xl p-6 shadow-xl border border-stone-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-brand-500/20 border border-brand-500/30 flex items-center justify-center text-brand-400 shrink-0">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold tracking-tight">{t('adminDashboard.headerTitle')}</h2>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-brand-500 text-stone-950">
                {t('adminDashboard.badge')}
              </span>
            </div>
            <p className="text-xs text-stone-400 mt-0.5">{t('adminDashboard.headerSubtitle')}</p>
          </div>
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <p className="text-xs font-bold text-stone-200">{user.displayName || user.email}</p>
              <p className="text-2xs text-stone-400">{user.email}</p>
            </div>
            {user.photoURL && (
              <img src={user.photoURL} alt="avatar" className="w-9 h-9 rounded-full border border-stone-700" referrerPolicy="no-referrer" />
            )}
            <button
              onClick={signOut}
              className="px-3 py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-semibold flex items-center gap-1.5 transition-colors border border-stone-700 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              {t('adminDashboard.signOut')}
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-stone-200 pb-3 flex-wrap">
        <button onClick={() => setActiveTab('cases')} className={tabClass('cases')}>
          {t('adminDashboard.tabs.cases', { n: reports.length })}
        </button>
        <button onClick={() => setActiveTab('ngos')} className={tabClass('ngos')}>
          {t('adminDashboard.tabs.ngos', { n: ngos.length })}
        </button>
        <button
          onClick={() => {
            setActiveTab('logs');
            handleRefreshLogs();
          }}
          className={tabClass('logs')}
        >
          <Terminal className="w-3.5 h-3.5" />
          {t('adminDashboard.tabs.logs')}
        </button>
      </div>

      {activeTab === 'cases' && (
        <div className="bg-white rounded-3xl border border-stone-200 shadow-xs overflow-hidden">
          <div className="p-4 border-b border-stone-200 bg-stone-50 flex items-center justify-between">
            <span className="text-xs font-bold text-stone-700">{t('adminDashboard.cases.tableTitle')}</span>
            <span className="text-2xs text-stone-500 font-mono">{t('adminDashboard.cases.tableMeta', { n: reports.length })}</span>
          </div>

          {reports.length === 0 ? (
            <div className="p-12 text-center text-stone-500 space-y-2">
              <p className="text-sm font-bold text-stone-800">{t('adminDashboard.cases.emptyTitle')}</p>
              <p className="text-xs text-stone-400">{t('adminDashboard.cases.emptyBody')}</p>
            </div>
          ) : (
            <div className="divide-y divide-stone-100">
              {reports.map((c) => {
                const hasFetchedContact = c.id in revealedContacts;
                const fetchedContact = revealedContacts[c.id];

                return (
                  <div key={c.id} className="p-4 hover:bg-stone-50/80 transition-colors flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <img
                        src={c.photoUrl}
                        alt={c.title}
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                        }}
                        className={`w-12 h-12 rounded-lg object-cover ${isCoverSensitive(c) ? 'blur-md scale-110' : ''}`}
                      />
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            type="button"
                            onClick={() => onSelectReport(c)}
                            title={t('adminDashboard.viewDetails')}
                            className="font-bold text-sm text-stone-900 text-left hover:underline cursor-pointer"
                          >
                            {c.title}
                          </button>
                          <span className={`px-2 py-0.5 rounded-full text-2xs font-bold text-white ${
                            c.urgency === 'P0' ? 'bg-rose-600' : c.urgency === 'P1' ? 'bg-amber-500' : 'bg-emerald-600'
                          }`}>
                            {c.urgency}
                          </span>
                          <span className="text-2xs text-stone-500 font-mono">ID: {c.id}</span>
                        </div>

                        <p className="text-xs text-stone-600 line-clamp-1 mt-0.5">{c.description}</p>
                        <div className="flex items-center gap-3 text-2xs text-stone-500 mt-1 flex-wrap">
                          {hasFetchedContact ? (
                            fetchedContact ? (
                              <>
                                <span>
                                  {t('adminDashboard.cases.reporter', {
                                    name: fetchedContact.reporterName || t('adminDashboard.cases.notProvided'),
                                    phone: fetchedContact.reporterPhone || t('adminDashboard.cases.noPhone'),
                                  })}
                                </span>
                                {fetchedContact.reporterEmail && (
                                  <span className="flex items-center gap-1 text-blue-600">
                                    <Mail className="w-3 h-3" />
                                    {fetchedContact.reporterEmail}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-stone-400">{t('adminDashboard.cases.contactFailed')}</span>
                            )
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleRevealContact(c.id)}
                              disabled={loadingContactId === c.id}
                              className="text-2xs text-brand-700 font-bold underline hover:text-brand-800 cursor-pointer disabled:opacity-50"
                            >
                              {loadingContactId === c.id
                                ? t('adminDashboard.cases.loading')
                                : `👁 ${t('adminDashboard.cases.revealContact')}`}
                            </button>
                          )}
                          <span>{t('adminDashboard.cases.location', { address: c.location.address })}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 w-full sm:w-auto shrink-0 justify-end">
                      <select
                        value={c.status}
                        onChange={(e) => onUpdateCaseStatus(c.id, e.target.value as CaseStatus)}
                        className="px-2.5 py-1.5 rounded-xl text-xs bg-stone-50 border border-stone-300 font-medium focus:ring-2 focus:ring-brand-500 focus:outline-none"
                      >
                        {CASE_STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>
                            {t(`adminDashboard.status.${s}`)}
                          </option>
                        ))}
                      </select>

                      <button
                        onClick={() => {
                          if (confirm(t('adminDashboard.cases.confirmDelete', { id: c.id }))) {
                            onDeleteCase(c.id);
                          }
                        }}
                        className="p-2 rounded-xl text-rose-600 hover:bg-rose-50 transition-colors border border-rose-200 cursor-pointer"
                        title={t('adminDashboard.cases.deleteTitle')}
                        aria-label={t('adminDashboard.cases.deleteTitle')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeTab === 'ngos' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between bg-white rounded-2xl p-4 border border-stone-200 gap-3">
            <div>
              <h3 className="font-bold text-sm text-stone-900">{t('adminDashboard.ngos.title')}</h3>
              <p className="text-2xs text-stone-500">{t('adminDashboard.ngos.subtitle')}</p>
            </div>
            <button
              onClick={() => setShowAddNGOModal(true)}
              className="px-3.5 py-2 rounded-xl bg-brand-500 hover:bg-brand-600 text-stone-950 text-xs font-bold flex items-center gap-1.5 transition-colors shadow-xs cursor-pointer shrink-0"
            >
              <Plus className="w-4 h-4" />
              {t('adminDashboard.ngos.add')}
            </button>
          </div>

          {ngos.length === 0 ? (
            <div className="bg-white rounded-3xl border border-stone-200 p-12 text-center text-stone-500 space-y-3">
              <Building2 className="w-10 h-10 text-stone-300 mx-auto" />
              <p className="text-sm font-bold text-stone-800">{t('adminDashboard.ngos.emptyTitle')}</p>
              <p className="text-xs text-stone-400">{t('adminDashboard.ngos.emptyBody')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {ngos.map((ngo) => {
                const accounts = accountsByNgo[ngo.id] || [];
                const website = safeWebsite(ngo.website);
                const adding = busyAccountKey === `add:${ngo.id}`;
                const capacity = ngo.capacityStatus || 'available';
                const animals = (ngo.acceptedAnimals || []).map(animalName).join(t('adminDashboard.listSeparator'));

                return (
                  <div key={ngo.id} className="bg-white rounded-3xl p-5 border border-stone-200 shadow-xs space-y-3 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h4 className="font-bold text-sm text-stone-900">{ngo.name}</h4>
                        <p className="text-2xs text-stone-500">{ngo.englishName}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`px-2.5 py-0.5 rounded-full text-2xs font-bold ${CAPACITY_BADGE[capacity] ?? CAPACITY_BADGE.available}`}>
                          {t(`adminDashboard.ngos.capacity.${capacity}`)}
                        </span>
                        <button
                          onClick={() => {
                            const extra =
                              accounts.length > 0
                                ? `\n${t('adminDashboard.ngos.confirmDeleteAccounts', { n: accounts.length })}`
                                : '';
                            if (confirm(t('adminDashboard.ngos.confirmDelete', { name: ngo.name }) + extra)) {
                              onDeleteNGO(ngo.id);
                            }
                          }}
                          className="p-1 rounded-lg text-rose-500 hover:bg-rose-50 transition-colors cursor-pointer"
                          title={t('adminDashboard.ngos.deleteTitle')}
                          aria-label={t('adminDashboard.ngos.deleteTitle')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="text-xs text-stone-600 space-y-1 break-words">
                      <p>📍 {t('adminDashboard.ngos.address', { address: ngo.address, district: ngo.district })}</p>
                      <p>
                        📞 {t('adminDashboard.ngos.hotline', { hotline: ngo.hotline })}
                        {ngo.whatsapp ? t('adminDashboard.ngos.whatsapp', { whatsapp: ngo.whatsapp }) : ''}
                      </p>
                      {ngo.publicEmail && (
                        <p className="flex items-center gap-1"><Mail className="w-3 h-3 shrink-0" />{ngo.publicEmail}</p>
                      )}
                      {website && (
                        <p className="flex items-center gap-1 min-w-0">
                          <Globe className="w-3 h-3 shrink-0" />
                          <a href={website} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline truncate">
                            {website}
                          </a>
                        </p>
                      )}
                      <p>
                        <Clock className="w-3 h-3 inline mr-1" />
                        {t('adminDashboard.ngos.hours', { hours: ngo.operatingHours })}
                      </p>
                      <p>🐾 {t('adminDashboard.ngos.accepts', { animals: animals || t('adminDashboard.ngos.notSet') })}</p>
                    </div>

                    {/* 登入帳戶（不公開） */}
                    <div className="pt-2 border-t border-stone-100 space-y-2">
                      <p className="text-2xs font-bold text-stone-500 flex items-center gap-1">
                        <KeyRound className="w-3 h-3" />
                        {t('adminDashboard.accounts.title', { n: accounts.length })}
                      </p>
                      {accounts.length === 0 ? (
                        <p className="text-2xs text-stone-400">{t('adminDashboard.accounts.empty')}</p>
                      ) : (
                        <ul className="space-y-1">
                          {accounts.map((a) => (
                            <li key={a.uid} className="flex items-center justify-between gap-2 text-xs bg-stone-50 rounded-lg px-2.5 py-1.5">
                              <span className="truncate">{a.email || a.uid}</span>
                              <button
                                type="button"
                                onClick={() => handleRemoveAccount(a)}
                                disabled={busyAccountKey === a.uid}
                                className="text-rose-500 hover:text-rose-700 disabled:opacity-40 cursor-pointer shrink-0"
                                title={t('adminDashboard.accounts.removeTitle')}
                                aria-label={t('adminDashboard.accounts.removeTitle')}
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="flex items-center gap-1.5">
                        <input
                          type="email"
                          value={addAccountInput[ngo.id] || ''}
                          onChange={(e) => setAddAccountInput((prev) => ({ ...prev, [ngo.id]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddAccount(ngo.id);
                            }
                          }}
                          placeholder={t('adminDashboard.accounts.addPlaceholder')}
                          className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-stone-50 border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                        <button
                          type="button"
                          onClick={() => handleAddAccount(ngo.id)}
                          disabled={adding}
                          className="px-2.5 py-1.5 rounded-lg bg-stone-900 text-white text-2xs font-bold flex items-center gap-1 disabled:opacity-50 cursor-pointer shrink-0"
                        >
                          <UserPlus className="w-3.5 h-3.5" />
                          {adding ? t('adminDashboard.accounts.processing') : t('adminDashboard.accounts.add')}
                        </button>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-stone-100 flex items-center justify-between flex-wrap gap-2">
                      <span className="text-2xs font-bold text-stone-500">{t('adminDashboard.ngos.capacityLabel')}</span>
                      <div className="flex items-center gap-1.5">
                        {CAPACITY_OPTIONS.map((opt) => (
                          <button
                            key={opt}
                            onClick={() => onUpdateNGOCapacity(ngo.id, opt)}
                            className={`px-2.5 py-1 rounded-lg text-2xs font-bold transition-colors cursor-pointer ${
                              capacity === opt ? CAPACITY_ACTIVE[opt] : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                            }`}
                          >
                            {t(`adminDashboard.ngos.capacityButton.${opt}`)}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeTab === 'logs' && (
        <div className="bg-stone-950 text-stone-200 rounded-3xl p-5 border border-stone-800 shadow-xl space-y-4 font-mono">
          <div className="flex items-center justify-between border-b border-stone-800 pb-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-bold text-stone-100">{t('adminDashboard.logs.title')}</span>
            </div>
            <button
              onClick={handleRefreshLogs}
              className="flex items-center gap-1 px-3 py-1 rounded-lg bg-stone-800 hover:bg-stone-700 text-2xs text-stone-300 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              {t('adminDashboard.logs.refresh')}
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto space-y-2 text-2xs pr-1">
            {logs.length === 0 ? (
              <p className="text-stone-500 py-4 text-center">{t('adminDashboard.logs.empty')}</p>
            ) : (
              logs.map((log) => (
                <div
                  key={log.id}
                  className={`p-2.5 rounded-xl border ${
                    log.level === 'error' ? 'bg-rose-950/40 border-rose-800/60 text-rose-200'
                      : log.level === 'warn' ? 'bg-amber-950/40 border-amber-800/60 text-amber-200'
                      : 'bg-stone-900 border-stone-800 text-stone-300'
                  }`}
                >
                  <div className="flex items-center justify-between text-2xs text-stone-400 mb-1">
                    <span className="font-bold uppercase tracking-wider text-brand-400">[{log.category}]</span>
                    <span>{new Date(log.timestamp).toLocaleTimeString(getApiLang())}</span>
                  </div>
                  <p className="font-sans font-medium">{log.message}</p>
                  {log.details && (
                    <pre className="mt-1.5 p-2 rounded-lg bg-black/40 text-stone-300 text-3xs overflow-x-auto whitespace-pre-wrap">
                      {typeof log.details === 'string' ? log.details : JSON.stringify(log.details, null, 2)}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {showAddNGOModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-3xl p-6 max-w-lg w-full shadow-2xl border border-stone-200 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-stone-200 pb-3">
              <div className="flex items-center gap-2">
                <Building2 className="w-5 h-5 text-brand-600" />
                <h3 className="font-bold text-base text-stone-900">{t('adminDashboard.form.title')}</h3>
              </div>
              <button
                onClick={closeAddNGOModal}
                disabled={savingNGO}
                aria-label={t('adminDashboard.form.cancel')}
                className="text-stone-400 hover:text-stone-600 font-bold disabled:opacity-40"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveNewNGO} className="space-y-3.5 text-xs text-stone-700">
              <SectionTitle>{t('adminDashboard.form.sectionBasic')}</SectionTitle>
              <div>
                <label className="block font-bold mb-1">{t('adminDashboard.form.name')}</label>
                <input type="text" value={newNGOName} onChange={(e) => setNewNGOName(e.target.value)} placeholder={t('adminDashboard.form.namePlaceholder')} maxLength={100} className={INPUT_CLS} required />
              </div>
              <div>
                <label className="block font-bold mb-1">{t('adminDashboard.form.englishName')}</label>
                <input type="text" value={newNGOEnglishName} onChange={(e) => setNewNGOEnglishName(e.target.value)} placeholder={t('adminDashboard.form.englishNamePlaceholder')} maxLength={100} className={INPUT_CLS} />
              </div>

              <SectionTitle>{t('adminDashboard.form.sectionContact')}</SectionTitle>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold mb-1">{t('adminDashboard.form.hotline')}</label>
                  <input type="tel" value={newNGOHotline} onChange={(e) => setNewNGOHotline(e.target.value)} placeholder={t('adminDashboard.form.hotlinePlaceholder')} className={INPUT_CLS} required />
                </div>
                <div>
                  <label className="block font-bold mb-1">{t('adminDashboard.form.whatsapp')}</label>
                  <input type="tel" value={newNGOWhatsapp} onChange={(e) => setNewNGOWhatsapp(e.target.value)} placeholder={t('adminDashboard.form.whatsappPlaceholder')} className={INPUT_CLS} />
                </div>
                <div>
                  <label className="block font-bold mb-1">{t('adminDashboard.form.publicEmail')}</label>
                  <input type="email" value={newNGOPublicEmail} onChange={(e) => setNewNGOPublicEmail(e.target.value)} placeholder={t('adminDashboard.form.publicEmailPlaceholder')} maxLength={200} className={INPUT_CLS} />
                </div>
                <div>
                  <label className="block font-bold mb-1">{t('adminDashboard.form.website')}</label>
                  <input type="url" value={newNGOWebsite} onChange={(e) => setNewNGOWebsite(e.target.value)} placeholder="https://..." maxLength={300} className={INPUT_CLS} />
                </div>
              </div>

              <SectionTitle>{t('adminDashboard.form.sectionLocation')}</SectionTitle>
              <div>
                <label className="block font-bold mb-1">{t('adminDashboard.form.address')}</label>
                <AddressAutocomplete
                  value={newNGOAddress}
                  onChange={setNewNGOAddress}
                  onSelect={(p) => {
                    setNewNGOAddress(p.address);
                    setNewNGOLat(String(p.lat));
                    setNewNGOLng(String(p.lng));
                    setNewNGODistrict(p.district || '');
                  }}
                  onEnter={() => {}}
                  bias={null}
                  placeholder={t('adminDashboard.form.addressPlaceholder')}
                />
                <p className="text-2xs text-stone-400 mt-1">{t('adminDashboard.form.addressHint')}</p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-bold mb-1">{t('adminDashboard.form.district')}</label>
                  <input type="text" value={newNGODistrict} onChange={(e) => setNewNGODistrict(e.target.value)} placeholder={t('adminDashboard.form.districtPlaceholder')} className={INPUT_CLS} />
                </div>
                <div>
                  <label className="block font-bold mb-1">{t('adminDashboard.form.lat')}</label>
                  <input type="text" value={newNGOLat} onChange={(e) => setNewNGOLat(e.target.value)} placeholder={t('adminDashboard.form.autoFill')} className={INPUT_CLS} />
                </div>
                <div>
                  <label className="block font-bold mb-1">{t('adminDashboard.form.lng')}</label>
                  <input type="text" value={newNGOLng} onChange={(e) => setNewNGOLng(e.target.value)} placeholder={t('adminDashboard.form.autoFill')} className={INPUT_CLS} />
                </div>
              </div>

              <SectionTitle>{t('adminDashboard.form.sectionService')}</SectionTitle>
              <div>
                <label className="block font-bold mb-1.5">{t('adminDashboard.form.acceptedAnimals')}</label>
                <div className="flex flex-wrap gap-3">
                  {ANIMAL_TYPES.map((type) => (
                    <label key={type} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={newNGOAcceptedAnimals.includes(type)}
                        onChange={() => toggleAcceptedAnimal(type)}
                        className="rounded text-brand-600 focus:ring-brand-500"
                      />
                      {animalName(type)}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block font-bold mb-1">{t('adminDashboard.form.specialties')}</label>
                <input type="text" value={newNGOSpecialties} onChange={(e) => setNewNGOSpecialties(e.target.value)} placeholder={t('adminDashboard.form.specialtiesPlaceholder')} className={INPUT_CLS} />
              </div>
              <div>
                <label className="block font-bold mb-1">{t('adminDashboard.form.hours')}</label>
                <input type="text" value={newNGOOperatingHours} onChange={(e) => setNewNGOOperatingHours(e.target.value)} placeholder={t('adminDashboard.form.hoursPlaceholder')} className={INPUT_CLS} />
              </div>
              <div className="flex items-center gap-2 pt-1">
                <input type="checkbox" id="ngo-24h-cb" checked={newNGO24h} onChange={(e) => setNewNGO24h(e.target.checked)} className="rounded text-brand-600 focus:ring-brand-500" />
                <label htmlFor="ngo-24h-cb" className="font-bold cursor-pointer">{t('adminDashboard.form.emergency24h')}</label>
              </div>

              <SectionTitle>{t('adminDashboard.form.sectionAccounts')}</SectionTitle>
              <p className="text-2xs text-stone-500 -mt-2">{t('adminDashboard.form.accountsHint')}</p>
              <div className="space-y-2">
                {newLoginEmails.map((value, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="email"
                      value={value}
                      onChange={(e) => updateLoginEmail(i, e.target.value)}
                      placeholder={t('adminDashboard.form.loginEmailPlaceholder')}
                      maxLength={200}
                      className={INPUT_CLS}
                    />
                    <button
                      type="button"
                      onClick={() => removeLoginEmailRow(i)}
                      className="p-2 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer shrink-0"
                      title={t('adminDashboard.form.remove')}
                      aria-label={t('adminDashboard.form.remove')}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                {newLoginEmails.length < MAX_LOGIN_EMAILS && (
                  <button
                    type="button"
                    onClick={() => setNewLoginEmails((prev) => [...prev, ''])}
                    className="text-2xs font-bold text-brand-700 hover:text-brand-800 flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {t('adminDashboard.form.addAccountRow', { max: MAX_LOGIN_EMAILS })}
                  </button>
                )}
              </div>

              <div className="pt-3 border-t border-stone-200 flex items-center justify-end gap-2">
                <button type="button" onClick={closeAddNGOModal} disabled={savingNGO} className="px-4 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold disabled:opacity-50">
                  {t('adminDashboard.form.cancel')}
                </button>
                <button type="submit" disabled={savingNGO} className="px-5 py-2 rounded-xl bg-brand-500 hover:bg-brand-600 text-stone-950 font-bold shadow-xs cursor-pointer disabled:opacity-50">
                  {savingNGO ? t('adminDashboard.form.saving') : t('adminDashboard.form.save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
