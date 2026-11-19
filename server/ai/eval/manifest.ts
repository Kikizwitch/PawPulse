// 評估資料集嘅 manifest（eval-data/manifest.json，唔入 git；範本見 docs/ai-pipeline/eval-manifest.example.json）
import path from "path";
import { z } from "zod";

const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

export const EvalCaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** 分類（例如 no_animal、blurry、dead、injection），報告會分類統計 */
  category: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
  /** 相片路徑（相對 manifest 所在資料夾），最多 5 張，必須係 JPEG（同 production 一樣） */
  photos: z.array(z.string().min(1)).min(1).max(5),
  reportedAnimal: z.enum(["cat", "dog", "bird", "other"]),
  description: z.string().max(2000).default(""),
  tags: z.array(z.enum(["stray", "injured", "trapped", "juvenile", "adult"])).max(5).default([]),
  lang: z.string().regex(LANG_RE).default("zh-HK"),
  /** 正確答案（由人填）；冇填嘅項目唔計分 */
  expected: z.object({
    urgency: z.enum(["P0", "P1", "P2"]).optional(),
    species: z.enum(["cat", "dog", "bird", "other", "unknown"]).optional(),
    animalVisible: z.boolean().optional(),
    imageUsable: z.boolean().optional(),
  }),
  notes: z.string().max(1000).optional(),
});

export const EvalManifestSchema = z
  .object({
    version: z.literal(1),
    cases: z.array(EvalCaseSchema).min(1),
  })
  .refine((m) => new Set(m.cases.map((c) => c.id)).size === m.cases.length, { message: "case id 唔可以重複" });

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalManifest = z.infer<typeof EvalManifestSchema>;

/** 驗證 manifest；錯就 throw 一句講清楚邊度錯 */
export function parseManifest(json: unknown): EvalManifest {
  const r = EvalManifestSchema.safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`manifest 唔啱：${i?.path.join(".") || "(root)"} ${i?.message ?? ""}`.trim());
  }
  return r.data;
}

/** 相片路徑一定要喺 manifest 資料夾入面（唔可以用 ../ 走出去讀其他檔案） */
export function resolvePhotoPath(manifestDir: string, rel: string): string {
  const root = path.resolve(manifestDir);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`相片路徑走出咗資料集資料夾：${rel}`);
  }
  return full;
}
