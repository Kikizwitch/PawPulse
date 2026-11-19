// 清洗唔信任嘅輸入（用戶 request、Gemini 輸出）：只接受字串，去頭尾空白再截長度

export function cleanStr(v: unknown, max = 300): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function cleanList(v: unknown, maxItems = 8, maxLen = 200): string[] {
  return Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim() !== "")
        .slice(0, maxItems)
        .map((x) => x.trim().slice(0, maxLen))
    : [];
}
