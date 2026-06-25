/**
 * 로컬 인메모리 캐시 (DB 적재 없음)
 * 같은 파일(내용 해시)을 다시 올리면 파이프라인 재실행 없이 즉시 반환.
 * 프로세스 재시작 시 비워짐 — 테스트 용도에 충분.
 */
import crypto from "node:crypto";
import { config } from "./config";

type Entry = { value: unknown; at: number };
const store = new Map<string, Entry>();
const MAX_ENTRIES = config.cacheMaxEntries;

export function hashBuffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

export function getCached<T>(key: string): T | undefined {
  return store.get(key)?.value as T | undefined;
}

export function setCached(key: string, value: unknown): void {
  if (store.size >= MAX_ENTRIES) {
    // 가장 오래된 항목 제거
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    store.forEach((entry, entryKey) => {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = entryKey;
      }
    });
    if (oldestKey) store.delete(oldestKey);
  }
  store.set(key, { value, at: Date.now() });
}
