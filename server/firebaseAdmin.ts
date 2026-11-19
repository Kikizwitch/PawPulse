// ---------- Firebase Admin（Firestore + Storage + Auth）----------
// server.ts 同 server/ai 共用；Cloud Run 會自動用服務帳戶，本機要先執行 gcloud auth application-default login
import "./env";
import { initializeApp, getApps, App } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

export const STORAGE_BUCKET = (process.env.FIREBASE_STORAGE_BUCKET || "").replace(/^gs:\/\//, "").trim();
const FIREBASE_PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "pawpulseai").trim();
// 冇設定就用 PawPulse 嘅資料庫，唔好連去 (default)
const FIRESTORE_DATABASE_ID = (
  process.env.FIRESTORE_DATABASE_ID || "ai-studio-pawpules-eda4ba81-50a4-4f01-905a-f931c3008e87"
).trim();

function getAdminApp(): App {
  return (
    getApps()[0] ??
    initializeApp({
      ...(FIREBASE_PROJECT_ID && { projectId: FIREBASE_PROJECT_ID }),
      ...(STORAGE_BUCKET && { storageBucket: STORAGE_BUCKET }),
    })
  );
}

let adminDb: Firestore | null = null;
export function getAdminDb(): Firestore {
  if (!adminDb) {
    const a = getAdminApp();
    adminDb = FIRESTORE_DATABASE_ID ? getFirestore(a, FIRESTORE_DATABASE_ID) : getFirestore(a);
  }
  return adminDb;
}

export function getAdminAuth() {
  return getAuth(getAdminApp());
}

export function getAdminBucket() {
  if (!STORAGE_BUCKET) return null;
  return getStorage(getAdminApp()).bucket();
}

export type AdminBucket = NonNullable<ReturnType<typeof getAdminBucket>>;
