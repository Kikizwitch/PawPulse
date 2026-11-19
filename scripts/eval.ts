// AI 評估：用本機資料集（eval-data/，唔入 git）跑同 production 一樣嘅分析流程（runAnalysis），唔寫 Firestore
//   npm run eval                              # 用 eval-data/manifest.json
//   npm run eval -- --manifest path/to/manifest.json --repeat 3 --concurrency 2
//   npm run eval -- --only case-01,case-02 --observe-twice --max-p0-under-triage 0
// 需要 GEMINI_API_KEY（.env.local）；會用 Gemini 額度，但唔扣 AI_DAILY_LIMIT
// 改 prompt、schema、triage 規則或者 model 之前同之後都要跑一次，比較報告
import "../server/env";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";
import { ADVICE_LIBRARY_VERSION } from "../src/config/adviceLibrary";
import type { LoadedPhoto } from "../server/cases";
import { MAX_PHOTO_BYTES } from "../server/cases";
import { GEMINI_MODEL, SCHEMA_VERSION, getGeminiApiKey } from "../server/ai/config";
import { parseManifest, resolvePhotoPath, type EvalCase } from "../server/ai/eval/manifest";
import { computeMetrics, renderMarkdown, type EvalMeta, type EvalRecord, type Prices } from "../server/ai/eval/metrics";
import { AiCallError, type AiUsage } from "../server/ai/client";
import { runAnalysis } from "../server/ai/pipeline";
import { PROMPT_VERSION } from "../server/ai/prompts/analyze.v3";
import { RULES_VERSION } from "../server/ai/triage";

interface Args {
  manifest: string;
  out: string;
  concurrency: number;
  repeat: number;
  only: Set<string> | null;
  limit: number | null;
  observeTwice: boolean;
  maxP0UnderTriage: number | null;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const int = (name: string, fallback: number, min: number, max: number) => {
    const v = get(name);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} 要係 ${min}–${max} 嘅整數`);
    return n;
  };
  const manifest = path.resolve(get("manifest") ?? "eval-data/manifest.json");
  const only = get("only");
  const maxP0 = get("max-p0-under-triage");
  if (maxP0 !== undefined && !(Number(maxP0) >= 0 && Number(maxP0) <= 1)) throw new Error("--max-p0-under-triage 要係 0–1");
  return {
    manifest,
    out: path.resolve(get("out") ?? path.join(path.dirname(manifest), "reports")),
    concurrency: int("concurrency", 2, 1, 8),
    repeat: int("repeat", 1, 1, 10),
    only: only ? new Set(only.split(",").map((s) => s.trim()).filter(Boolean)) : null,
    limit: get("limit") === undefined ? null : int("limit", 0, 1, 10_000),
    observeTwice: argv.includes("--observe-twice"),
    maxP0UnderTriage: maxP0 === undefined ? null : Number(maxP0),
    verbose: argv.includes("--verbose"),
  };
}

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

// 同 production 一樣：只接受 JPEG、細過 5MB；位置 = 喺 photos 入面嘅次序
async function loadPhotos(dir: string, c: EvalCase): Promise<LoadedPhoto[]> {
  return Promise.all(
    c.photos.map(async (rel, pos) => {
      const file = resolvePhotoPath(dir, rel);
      const s = await stat(file);
      if (s.size >= MAX_PHOTO_BYTES) throw new Error(`${c.id}: ${rel} 大過 5MB（production 會拒絕）`);
      const buf = await readFile(file);
      if (!isJpeg(buf)) throw new Error(`${c.id}: ${rel} 唔係 JPEG（production 只接受 JPEG，請先轉檔）`);
      return { pos, data: buf.toString("base64") };
    })
  );
}

async function runCase(c: EvalCase, images: LoadedPhoto[], run: number, args: Args): Promise<EvalRecord> {
  const started = Date.now();
  const result = await runAnalysis(
    {
      images,
      totalPhotos: images.length,
      animalType: c.reportedAnimal,
      description: c.description,
      reporterTags: c.tags,
      lang: c.lang,
      caseId: `eval-${c.id}`,
    },
    { observeTwice: args.observeTwice, retry: args.verbose ? undefined : { log: () => undefined } }
  );
  const latencyMs = Date.now() - started;

  // token：成功 = 全部 call 加埋；失敗 = 有回應就用回應嘅用量，冇回應就用錯誤記低嘅用量（例如被擋）
  // tsconfig 冇開 strictNullChecks，要用 === false 先收窄到 union 嘅其中一款
  let usages: (AiUsage | null)[];
  let errorKind: string | null = null;
  if (result.ok === false) {
    errorKind = result.error.kind;
    usages = [result.call?.usage ?? (result.error instanceof AiCallError ? result.error.usage : null)];
  } else {
    usages = result.calls.map((x) => x.usage);
  }
  const sum = (k: keyof AiUsage) => usages.reduce((s, u) => s + (u?.[k] ?? 0), 0);
  const a = result.ok === true ? result.analysis : null;

  return {
    caseId: c.id,
    category: c.category ?? null,
    run,
    expected: c.expected,
    ok: result.ok,
    errorKind,
    // 分析失敗：production 會維持 P1
    level: a?.urgencyLevel ?? "P1",
    species: a?.gate?.speciesCategory ?? null,
    animalVisible: a?.gate?.animalVisible ?? null,
    imageUsable: a?.gate?.imageUsable ?? null,
    needsHumanReview: a?.triage?.needsHumanReview ?? null,
    latencyMs,
    tokens: {
      prompt: sum("promptTokens"),
      output: sum("candidatesTokens") + sum("thoughtsTokens"),
      total: sum("totalTokens"),
    },
  };
}

// 簡單嘅並行池：同一時間最多 n 個 Gemini 請求
async function pool<T>(items: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await items[i]();
      }
    })
  );
  return out;
}

function gitCommit(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

function prices(): Prices | undefined {
  const i = Number(process.env.EVAL_PRICE_INPUT_PER_M);
  const o = Number(process.env.EVAL_PRICE_OUTPUT_PER_M);
  return Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0 && process.env.EVAL_PRICE_INPUT_PER_M
    ? { inputPerM: i, outputPerM: o }
    : undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!getGeminiApiKey()) throw new Error("未設定 GEMINI_API_KEY（放喺 .env.local）");

  const raw = await readFile(args.manifest).catch(() => {
    throw new Error(`搵唔到 manifest：${args.manifest}\n範本：docs/ai-pipeline/eval-manifest.example.json`);
  });
  const manifest = parseManifest(JSON.parse(raw.toString("utf8")));
  const dir = path.dirname(args.manifest);
  let cases = manifest.cases.filter((c) => !args.only || args.only.has(c.id));
  if (args.limit) cases = cases.slice(0, args.limit);
  if (cases.length === 0) throw new Error("冇案件可以跑（檢查 --only）");

  // 先讀晒相：相片有問題就喺 call Gemini 之前停，唔好浪費額度
  const photos = new Map<string, LoadedPhoto[]>();
  for (const c of cases) photos.set(c.id, await loadPhotos(dir, c));

  const startedAt = new Date().toISOString();
  console.log(`Evaluating ${cases.length} cases × ${args.repeat} with ${GEMINI_MODEL} / ${PROMPT_VERSION} …`);
  let done = 0;
  const total = cases.length * args.repeat;
  const jobs = cases.flatMap((c) =>
    Array.from({ length: args.repeat }, (_, run) => async () => {
      const r = await runCase(c, photos.get(c.id)!, run + 1, args);
      done++;
      const mark = !r.ok ? `✗ ${r.errorKind}` : r.expected.urgency && r.expected.urgency !== r.level ? `≠ expected ${r.expected.urgency}` : "✓";
      console.log(`[${done}/${total}] ${c.id}#${run + 1}: ${r.level} ${mark} (${(r.latencyMs / 1000).toFixed(1)}s)`);
      return r;
    })
  );
  const records = await pool(jobs, args.concurrency);

  const metrics = computeMetrics(records, prices());
  const meta: EvalMeta = {
    startedAt,
    model: GEMINI_MODEL,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    rulesVersion: RULES_VERSION,
    adviceVersion: ADVICE_LIBRARY_VERSION,
    gitCommit: gitCommit(),
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
    observeTwice: args.observeTwice,
    repeat: args.repeat,
  };
  const md = renderMarkdown(metrics, meta);

  await mkdir(args.out, { recursive: true });
  const base = path.join(args.out, `${startedAt.replace(/[:.]/g, "-")}-${PROMPT_VERSION}`);
  await writeFile(`${base}.json`, JSON.stringify({ meta, metrics, records }, null, 2));
  await writeFile(`${base}.md`, md);
  console.log(`\n${md}\nReport: ${base}.md`);

  // CI／發佈前檢查：P0 漏判比例超過上限就失敗
  if (args.maxP0UnderTriage !== null && metrics.p0.rate !== null && metrics.p0.rate > args.maxP0UnderTriage) {
    console.error(`P0 under-triage ${(metrics.p0.rate * 100).toFixed(1)}% > allowed ${(args.maxP0UnderTriage * 100).toFixed(1)}%`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`eval failed: ${(err as Error).message}`);
  process.exit(2);
});
