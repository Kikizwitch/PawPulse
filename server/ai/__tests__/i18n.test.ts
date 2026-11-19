// 每個原因代碼、觀察欄位同觀察值都要有中英文顯示文字，加規則唔記得加翻譯會失敗
import { describe, expect, it } from 'vitest';
import zh from '../../../src/locales/zh.json';
import en from '../../../src/locales/en.json';
import { FINDING_FIELDS, FindingsSchema, GateSchema } from '../findings';
import { allReasonCodes } from '../triage';
import { ADVICE_CATEGORIES, ADVICE_LIBRARY } from '../../../src/config/adviceLibrary';
import { NGO_CAPABILITIES } from '../../../src/config/ngoCapabilities';

const LOCALES = { zh, en } as Record<string, any>;

// 四種 trauma 欄位共用同一組值嘅翻譯
const valueGroup = (field: string) => (field.startsWith('trauma') ? 'trauma' : field);

function enumValues(field: (typeof FINDING_FIELDS)[number]): string[] {
  const s = FindingsSchema.shape[field] as any;
  return field === 'woundTypes' ? s.element.options : s.options;
}

describe.each(Object.keys(LOCALES))('locale %s', (lang) => {
  const L = LOCALES[lang];

  it('每個原因代碼都有文字', () => {
    for (const code of allReasonCodes()) {
      expect(typeof L.triage.reason[code], code).toBe('string');
    }
  });

  it('冇多餘嘅原因代碼（規則表刪咗嘅要一齊刪翻譯）', () => {
    expect(Object.keys(L.triage.reason).sort()).toEqual([...allReasonCodes()].sort());
  });

  it('每個觀察欄位同值都有文字', () => {
    for (const f of FINDING_FIELDS) {
      expect(typeof L.aiFindings.field[f], f).toBe('string');
      for (const v of enumValues(f)) {
        expect(typeof L.aiFindings.value[valueGroup(f)][v], `${f}.${v}`).toBe('string');
      }
    }
  });

  it.each(ADVICE_CATEGORIES)('建議庫 %s：每條都有文字，冇多餘', (cat) => {
    expect(Object.keys(L.advice[cat]).sort()).toEqual(Object.keys(ADVICE_LIBRARY[cat]).sort());
    for (const text of Object.values(L.advice[cat])) expect(typeof text === 'string' && text.length > 0).toBe(true);
  });

  it('建議文字唔可以有電話號碼或者網址', () => {
    for (const cat of ADVICE_CATEGORIES) {
      for (const [code, text] of Object.entries(L.advice[cat] as Record<string, string>)) {
        expect(/\d(?:[\s\-().]*\d){5,}|https?:\/\/|www\./.test(text), `${cat}.${code}`).toBe(false);
      }
    }
  });

  it('NGO 能力：每個都有文字，冇多餘', () => {
    expect(Object.keys(L.capability).sort()).toEqual([...NGO_CAPABILITIES].sort());
  });

  it('每個物種都有文字', () => {
    for (const s of GateSchema.shape.speciesCategory.options) {
      expect(typeof L.aiFindings.species[s], s).toBe('string');
    }
  });
});
