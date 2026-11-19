// 評估指標（純函數）：scripts/eval.ts 收集結果之後喺度計
// 最重要嘅指標：真正 P0 個案被判低咗（under-triage）嘅比例——漏咗危急個案比誤判穩定個案危險得多
import type { UrgencyLevel } from "../../../src/types";

export interface EvalExpected {
  urgency?: UrgencyLevel;
  species?: string;
  animalVisible?: boolean;
  imageUsable?: boolean;
}

/** 一次分析嘅結果 */
export interface EvalRecord {
  caseId: string;
  category: string | null;
  run: number;
  expected: EvalExpected;
  ok: boolean;
  errorKind: string | null;
  /** 系統實際會用嘅等級：分析失敗時係 P1（同 production 後備一樣） */
  level: UrgencyLevel;
  species: string | null;
  animalVisible: boolean | null;
  imageUsable: boolean | null;
  needsHumanReview: boolean | null;
  latencyMs: number;
  tokens: { prompt: number; output: number; total: number };
}

export interface Prices {
  /** 每 100 萬個輸入 token 嘅價錢（USD） */
  inputPerM: number;
  /** 每 100 萬個輸出 token（包括 thinking）嘅價錢（USD） */
  outputPerM: number;
}

const LEVELS: UrgencyLevel[] = ["P0", "P1", "P2"];
// 數字越細越緊急
const RANK: Record<UrgencyLevel, number> = { P0: 0, P1: 1, P2: 2 };

const ratio = (num: number, den: number) => (den === 0 ? null : num / den);

/** 最近排名法百分位（p = 0..100） */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface EvalMetrics {
  runs: number;
  cases: number;
  okRate: number | null;
  errors: Record<string, number>;
  schemaFailureRate: number | null;
  urgency: {
    scored: number;
    accuracy: number | null;
    /** confusion[expected][predicted] */
    confusion: Record<UrgencyLevel, Record<UrgencyLevel, number>>;
    underTriageRate: number | null;
    overTriageRate: number | null;
  };
  /** 主要指標 */
  p0: { total: number; underTriaged: number; rate: number | null; caseIds: string[] };
  species: { scored: number; accuracy: number | null; unknownRate: number | null };
  gate: { animalVisible: { scored: number; accuracy: number | null }; imageUsable: { scored: number; accuracy: number | null } };
  humanReviewRate: number | null;
  latency: { p50: number | null; p95: number | null; max: number | null };
  tokens: { prompt: number; output: number; total: number; meanPerRun: number | null };
  costUsd: { total: number; perRun: number } | null;
  /** repeat > 1：每宗案件幾次分析等級都一樣嘅比例 */
  consistency: { casesWithRepeats: number; rate: number | null } | null;
  byCategory: { category: string; runs: number; accuracy: number | null; p0UnderTriaged: number; errors: number }[];
}

export function computeMetrics(records: EvalRecord[], prices?: Prices): EvalMetrics {
  const runs = records.length;
  const ok = records.filter((r) => r.ok);

  const errors: Record<string, number> = {};
  for (const r of records) if (!r.ok) errors[r.errorKind ?? "unknown"] = (errors[r.errorKind ?? "unknown"] ?? 0) + 1;

  // 緊急程度：失敗都計（系統會用 P1），因為報案人實際會見到呢個結果
  const scored = records.filter((r) => r.expected.urgency);
  const confusion = Object.fromEntries(
    LEVELS.map((e) => [e, Object.fromEntries(LEVELS.map((p) => [p, 0]))])
  ) as Record<UrgencyLevel, Record<UrgencyLevel, number>>;
  let correct = 0;
  let under = 0;
  let over = 0;
  for (const r of scored) {
    const e = r.expected.urgency!;
    confusion[e][r.level]++;
    if (r.level === e) correct++;
    else if (RANK[r.level] > RANK[e]) under++;
    else over++;
  }

  const p0Records = scored.filter((r) => r.expected.urgency === "P0");
  const p0Missed = p0Records.filter((r) => r.level !== "P0");

  // 物種、Gate：只計分析成功嘅
  const speciesScored = ok.filter((r) => r.expected.species);
  const visScored = ok.filter((r) => r.expected.animalVisible !== undefined);
  const useScored = ok.filter((r) => r.expected.imageUsable !== undefined);

  const latencies = records.map((r) => r.latencyMs).filter((v) => Number.isFinite(v) && v > 0);
  const tokens = records.reduce(
    (t, r) => ({ prompt: t.prompt + r.tokens.prompt, output: t.output + r.tokens.output, total: t.total + r.tokens.total }),
    { prompt: 0, output: 0, total: 0 }
  );
  const costTotal = prices ? (tokens.prompt * prices.inputPerM + tokens.output * prices.outputPerM) / 1_000_000 : null;

  // 一致性
  const byCase = new Map<string, EvalRecord[]>();
  for (const r of records) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
  const repeated = [...byCase.values()].filter((list) => list.length > 1);
  const consistency =
    repeated.length === 0
      ? null
      : { casesWithRepeats: repeated.length, rate: ratio(repeated.filter((l) => l.every((r) => r.level === l[0].level)).length, repeated.length) };

  const categories = [...new Set(records.map((r) => r.category ?? "(none)"))].sort();
  const byCategory = categories.map((category) => {
    const list = records.filter((r) => (r.category ?? "(none)") === category);
    const s = list.filter((r) => r.expected.urgency);
    return {
      category,
      runs: list.length,
      accuracy: ratio(s.filter((r) => r.level === r.expected.urgency).length, s.length),
      p0UnderTriaged: s.filter((r) => r.expected.urgency === "P0" && r.level !== "P0").length,
      errors: list.filter((r) => !r.ok).length,
    };
  });

  return {
    runs,
    cases: byCase.size,
    okRate: ratio(ok.length, runs),
    errors,
    schemaFailureRate: ratio(records.filter((r) => r.errorKind === "schema").length, runs),
    urgency: {
      scored: scored.length,
      accuracy: ratio(correct, scored.length),
      confusion,
      underTriageRate: ratio(under, scored.length),
      overTriageRate: ratio(over, scored.length),
    },
    p0: {
      total: p0Records.length,
      underTriaged: p0Missed.length,
      rate: ratio(p0Missed.length, p0Records.length),
      caseIds: [...new Set(p0Missed.map((r) => r.caseId))],
    },
    species: {
      scored: speciesScored.length,
      accuracy: ratio(speciesScored.filter((r) => r.species === r.expected.species).length, speciesScored.length),
      unknownRate: ratio(speciesScored.filter((r) => r.species === "unknown").length, speciesScored.length),
    },
    gate: {
      animalVisible: {
        scored: visScored.length,
        accuracy: ratio(visScored.filter((r) => r.animalVisible === r.expected.animalVisible).length, visScored.length),
      },
      imageUsable: {
        scored: useScored.length,
        accuracy: ratio(useScored.filter((r) => r.imageUsable === r.expected.imageUsable).length, useScored.length),
      },
    },
    humanReviewRate: ratio(ok.filter((r) => r.needsHumanReview === true).length, ok.length),
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length ? Math.max(...latencies) : null },
    tokens: { ...tokens, meanPerRun: ratio(tokens.total, runs) },
    costUsd: costTotal === null ? null : { total: costTotal, perRun: runs ? costTotal / runs : 0 },
    consistency,
    byCategory,
  };
}

// ---------- 報告 ----------

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const ms = (v: number | null) => (v === null ? "—" : `${(v / 1000).toFixed(2)} s`);

export interface EvalMeta {
  startedAt: string;
  model: string;
  promptVersion: string;
  schemaVersion: number;
  rulesVersion: string;
  adviceVersion: string;
  gitCommit: string | null;
  manifestSha256: string;
  observeTwice: boolean;
  repeat: number;
}

export function renderMarkdown(m: EvalMetrics, meta: EvalMeta): string {
  const lines: string[] = [];
  lines.push(`# AI evaluation — ${meta.startedAt}`, "");
  lines.push(
    `Model \`${meta.model}\` · prompt \`${meta.promptVersion}\` · schema v${meta.schemaVersion} · rules \`${meta.rulesVersion}\` · advice \`${meta.adviceVersion}\``,
    `Commit \`${meta.gitCommit ?? "unknown"}\` · dataset sha256 \`${meta.manifestSha256.slice(0, 12)}\` · ${m.cases} cases × ${meta.repeat} = ${m.runs} runs${meta.observeTwice ? " · observe-twice" : ""}`,
    ""
  );
  // 有分析失敗：要好清楚咁講，否則 API key 錯咗都會睇落似 model 差
  const failed = m.runs - Math.round((m.okRate ?? 0) * m.runs);
  if (failed > 0) {
    lines.push(
      `> ⚠️ ${failed} of ${m.runs} runs failed (${Object.entries(m.errors).map(([k, v]) => `${k} ${v}`).join(", ")}). Failed runs count as P1, so the urgency metrics below include them.`,
      ""
    );
  }
  lines.push("## Primary metric", "");
  lines.push(
    `**P0 under-triage: ${pct(m.p0.rate)}** (${m.p0.underTriaged} of ${m.p0.total} runs on true-P0 cases were not P0)`,
    ""
  );
  if (m.p0.caseIds.length) lines.push(`Missed P0 cases: ${m.p0.caseIds.map((id) => `\`${id}\``).join(", ")}`, "");

  lines.push("## Urgency", "");
  lines.push(
    `Accuracy ${pct(m.urgency.accuracy)} · under-triage ${pct(m.urgency.underTriageRate)} · over-triage ${pct(m.urgency.overTriageRate)} (${m.urgency.scored} scored runs; failed runs count as P1, the production fallback)`,
    ""
  );
  lines.push("| expected ↓ / predicted → | P0 | P1 | P2 |", "|---|---|---|---|");
  for (const e of LEVELS) lines.push(`| **${e}** | ${LEVELS.map((p) => m.urgency.confusion[e][p]).join(" | ")} |`);
  lines.push("");

  lines.push("## Gate and species", "");
  lines.push("| Check | Accuracy | Scored |", "|---|---|---|");
  lines.push(`| Species | ${pct(m.species.accuracy)} (unknown ${pct(m.species.unknownRate)}) | ${m.species.scored} |`);
  lines.push(`| Animal visible | ${pct(m.gate.animalVisible.accuracy)} | ${m.gate.animalVisible.scored} |`);
  lines.push(`| Image usable | ${pct(m.gate.imageUsable.accuracy)} | ${m.gate.imageUsable.scored} |`, "");
  lines.push(`Human review flagged on ${pct(m.humanReviewRate)} of successful runs.`, "");

  lines.push("## Reliability and cost", "");
  lines.push(`- Success: ${pct(m.okRate)} · schema failures: ${pct(m.schemaFailureRate)}`);
  const errs = Object.entries(m.errors);
  if (errs.length) lines.push(`- Errors: ${errs.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  lines.push(`- Latency: p50 ${ms(m.latency.p50)} · p95 ${ms(m.latency.p95)} · max ${ms(m.latency.max)}`);
  lines.push(
    `- Tokens: ${m.tokens.total.toLocaleString("en")} total (${m.tokens.prompt.toLocaleString("en")} input, ${m.tokens.output.toLocaleString("en")} output incl. thinking) · ${m.tokens.meanPerRun === null ? "—" : Math.round(m.tokens.meanPerRun).toLocaleString("en")} per run`
  );
  lines.push(
    m.costUsd
      ? `- Cost: $${m.costUsd.total.toFixed(4)} total · $${m.costUsd.perRun.toFixed(5)} per run`
      : "- Cost: set EVAL_PRICE_INPUT_PER_M and EVAL_PRICE_OUTPUT_PER_M (USD per 1M tokens) to estimate"
  );
  if (m.consistency) lines.push(`- Consistency: ${pct(m.consistency.rate)} of ${m.consistency.casesWithRepeats} repeated cases gave the same level every run`);
  lines.push("");

  lines.push("## By category", "");
  lines.push("| Category | Runs | Urgency accuracy | P0 missed | Errors |", "|---|---|---|---|---|");
  for (const c of m.byCategory) lines.push(`| ${c.category} | ${c.runs} | ${pct(c.accuracy)} | ${c.p0UnderTriaged} | ${c.errors} |`);
  lines.push("");
  return lines.join("\n");
}
