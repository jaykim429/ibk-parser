/**
 * 로컬 내규 매칭 — 격리 컬렉션(regulations_ibk_test) 대상 벡터 검색.
 *
 * 서버의 /match/hybrid는 고정 컬렉션(regulations)만 조회하므로,
 * 137개 IBK 내규를 적재한 격리 컬렉션은 우리가 직접 검색한다.
 *   쿼리 임베딩(동일 Qwen3-8B) → Qdrant 코사인 검색 → 후보.
 * (기존 regulations 컬렉션·라이브 프론트는 미접촉)
 */
import { embedQuery } from "./embedding";
import { enrichWithSource } from "./regulation-source";
import { config } from "./config";
import type { Candidate } from "./server";

const QDRANT = config.qdrantUrl;
const COLL = config.ibkRegCollection;

/** 벡터(코사인) 검색 — Qdrant payload 기반 raw 후보(보강 전, 코사인 순서) */
export async function vectorSearch(query: string, topK = config.vectorTopK): Promise<Candidate[]> {
  const vector = await embedQuery(query);

  const r = await fetch(`${QDRANT}/collections/${COLL}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vector, limit: topK, with_payload: true }),
    signal: AbortSignal.timeout(config.qdrantTimeoutMs),
  });
  if (!r.ok) {
    throw new Error(`내규 검색 실패 (Qdrant HTTP ${r.status}). 컬렉션 '${COLL}' 인덱싱 여부를 확인하세요.`);
  }
  const result: Array<{ score: number; payload: Record<string, unknown> }> =
    (await r.json()).result ?? [];

  return result.map((p) => {
    const pl = p.payload ?? {};
    const score = p.score ?? 0;
    return {
      regulation_id: Number(pl.regulation_id ?? 0),
      regulation_name: String(pl.regulation_name ?? ""),
      jo: pl.jo ? String(pl.jo) : undefined,
      jo_title: pl.jo_title ? String(pl.jo_title) : undefined,
      type: pl.type ? String(pl.type) : undefined,
      byeolpyo: pl.byeolpyo ? String(pl.byeolpyo) : undefined,
      department: pl.department ? String(pl.department) : undefined,
      regulation_content: String(pl.regulation_content ?? ""),
      hybrid_score: score,
      final_score: score,
      importance:
        score > config.vectorHighThreshold
          ? "high"
          : score > config.vectorMediumThreshold
            ? "medium"
            : "low",
      match_source: "vector",
    } as Candidate;
  });
}

/** 벡터 검색 + 원본 전문 보강 (단독 사용 시) */
export async function matchLocal(query: string, topK = 25): Promise<Candidate[]> {
  return enrichWithSource(await vectorSearch(query, topK));
}
