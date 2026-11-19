// Zod → JSON Schema → Gemini responseJsonSchema（analyze.v3 起共用；v2 有自己一份，唔改舊版）
import { z } from "zod";

// Gemini responseJsonSchema 支援嘅關鍵字（@google/genai 2.25 type 註解列出嘅）+ 非標準嘅 propertyOrdering
export const GEMINI_SCHEMA_KEYWORDS = new Set([
  "$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum", "items",
  "prefixItems", "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf", "properties",
  "additionalProperties", "required", "propertyOrdering",
]);

const SAFE_INT = Number.MAX_SAFE_INTEGER;

// 刪 $schema、刪 z.int() 自動加嘅安全整數範圍、每個 object 加 propertyOrdering（= Gemini 生成次序）
function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "$schema") continue;
    if ((k === "minimum" && v === -SAFE_INT) || (k === "maximum" && v === SAFE_INT)) continue;
    out[k] =
      k === "properties"
        ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, clean(pv)]))
        : clean(v);
  }
  if (out.type === "object" && out.properties) out.propertyOrdering = Object.keys(out.properties as object);
  return out;
}

export function toGeminiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return clean(z.toJSONSchema(schema)) as Record<string, unknown>;
}
