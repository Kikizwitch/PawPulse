// 案件共用常數同相片讀取（server.ts 同 server/ai 共用）
import { Timestamp } from "firebase-admin/firestore";
import type { AdminBucket } from "./firebaseAdmin";

export const ALLOWED_ANIMAL_HINTS = new Set(["cat", "dog", "bird", "other"]);
export const FRESH_CASE_WINDOW_MS = 15 * 60 * 1000; // 案件建立後 15 分鐘內先可以做 AI 分析、寄信、報案人派送
export const MAX_CASE_PHOTOS = 5;     // 案件同時顯示最多 5 張
export const MAX_STORED_PHOTOS = 10;  // Storage 每宗案件最多 10 個位（0–9.jpg）：報案 5 + 修改 5
export const PHOTO_FILE_RE = /^[0-9]\.jpg$/;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

// 案件相片路徑：只接受 photos[].path 入面屬於呢宗案件資料夾嘅路徑，唔信 Firestore 入面任意字串
export function casePhotoPaths(caseId: string, data: Record<string, any> | undefined): string[] {
  const folder = `animal-reports/${caseId}/`;
  const isOwn = (p: unknown): p is string =>
    typeof p === "string" && p.startsWith(folder) && PHOTO_FILE_RE.test(p.slice(folder.length));

  const list: string[] = Array.isArray(data?.photos)
    ? data!.photos.map((x: any) => x?.path).filter(isOwn)
    : [];
  return Array.from(new Set(list)).slice(0, MAX_CASE_PHOTOS);
}

// 由 Storage 讀相；pos = 喺 photos[] 嘅位置（0 = 封面）。讀唔到或者格式唔啱嘅就略過
export type LoadedPhoto = { pos: number; data: string };

export async function loadCasePhotos(bucket: AdminBucket, paths: string[]): Promise<LoadedPhoto[]> {
  const results = await Promise.all(
    paths.map(async (p, pos): Promise<LoadedPhoto | null> => {
      try {
        const file = bucket.file(p);
        const [meta] = await file.getMetadata();
        if (meta.contentType !== "image/jpeg" || Number(meta.size) >= MAX_PHOTO_BYTES) {
          console.warn(`[Analyze] 略過格式唔啱嘅相片 ${p}`);
          return null;
        }
        const [buffer] = await file.download();
        return { pos, data: buffer.toString("base64") };
      } catch (err: any) {
        if (err?.code !== 404) console.warn(`[Analyze] 讀取相片失敗 ${p}:`, err?.message);
        return null;
      }
    })
  );
  return results.filter((x): x is LoadedPhoto => x !== null);
}

export function isFreshCase(data: Record<string, any> | undefined): boolean {
  const ts = data?.createdAt;
  return ts instanceof Timestamp && Date.now() - ts.toMillis() < FRESH_CASE_WINDOW_MS;
}
