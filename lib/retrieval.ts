/**
 * 하이브리드 검색기 (OOP) — 벡터(Qdrant) + BM25(로컬)를 RRF로 융합.
 *
 *   retrieve(query): [BM25 ∥ 벡터] → RRF 융합(k) → 원본 전문 보강 → Candidate[]
 *
 * 클래스로 캡슐화해 파라미터(rrfK, topK 등)를 주입 가능하게 하고,
 * 다른 앱(compliance.ihopper.co.kr)에서 동일 인터페이스로 재사용한다.
 */
import { vectorSearch } from "./match-local";
import { bm25Search } from "./bm25-local";
import { enrichWithSource } from "./regulation-source";
import { config } from "./config";
import type { Candidate } from "./server";

export type RetrieverOptions = {
  rrfK: number;
  vectorTopK: number;
  bm25TopK: number;
  fuseTopK: number;
};

const keyOf = (c: { regulation_id?: number; type?: string; jo?: string }) =>
  `${c.regulation_id ?? 0}|${c.type ?? "조"}|${c.jo ?? ""}`;

export class HybridRetriever {
  private readonly opts: RetrieverOptions;

  constructor(opts: Partial<RetrieverOptions> = {}) {
    this.opts = {
      rrfK: opts.rrfK ?? config.rrfK,
      vectorTopK: opts.vectorTopK ?? config.vectorTopK,
      bm25TopK: opts.bm25TopK ?? config.bm25TopK,
      fuseTopK: opts.fuseTopK ?? config.matchTopK,
    };
  }

  /** RRF: score(d) = Σ 1/(k + rank_i(d)) */
  private fuse(vec: Candidate[], bm: Candidate[]): Candidate[] {
    const { rrfK, fuseTopK } = this.opts;
    const rrf = new Map<string, number>();
    const cand = new Map<string, Candidate>();

    vec.forEach((c, i) => {
      const k = keyOf(c);
      rrf.set(k, (rrf.get(k) ?? 0) + 1 / (rrfK + i + 1));
      if (!cand.has(k)) cand.set(k, c);
    });
    bm.forEach((c, i) => {
      const k = keyOf(c);
      rrf.set(k, (rrf.get(k) ?? 0) + 1 / (rrfK + i + 1));
      if (!cand.has(k)) cand.set(k, c);
      else cand.get(k)!.match_source = "hybrid";
    });

    return Array.from(rrf.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, fuseTopK)
      .map(([k, score]) => ({ ...cand.get(k)!, final_score: score }));
  }

  /** 단일 쿼리: 벡터+BM25 → RRF 융합 (보강 전) */
  private async rawRetrieve(query: string): Promise<Candidate[]> {
    const [vec, bmHits] = await Promise.all([
      vectorSearch(query, this.opts.vectorTopK),
      Promise.resolve(bm25Search(query, this.opts.bm25TopK)),
    ]);
    const bm: Candidate[] = bmHits.map((hit) => ({
      regulation_id: hit.rec.regId,
      regulation_name: hit.rec.regName,
      jo: hit.rec.jo || undefined,
      type: hit.rec.type || undefined,
      regulation_content: hit.rec.content,
      match_source: "bm25",
    }));
    return this.fuse(vec, bm);
  }

  async retrieve(query: string): Promise<Candidate[]> {
    return enrichWithSource(await this.rawRetrieve(query));
  }

  /**
   * 멀티쿼리(입력 문서 청킹): 변경 단위별 쿼리 결과를 키 기준으로 합산 융합.
   * 여러 변경점에서 공통으로 걸리는 내규는 가점 → 문서 전체 변경을 빠짐없이 커버.
   */
  async retrieveMany(queries: string[]): Promise<Candidate[]> {
    const uniq = Array.from(new Set(queries.map((q) => q.trim()).filter(Boolean)));
    if (uniq.length <= 1) return this.retrieve(uniq[0] ?? "");

    const lists = await Promise.all(uniq.map((q) => this.rawRetrieve(q)));
    const score = new Map<string, number>();
    const cand = new Map<string, Candidate>();
    for (const list of lists) {
      for (const c of list) {
        const k = keyOf(c);
        score.set(k, (score.get(k) ?? 0) + (c.final_score ?? 0));
        if (!cand.has(k)) cand.set(k, c);
        else if (c.match_source === "hybrid") cand.get(k)!.match_source = "hybrid";
      }
    }
    const fused = Array.from(score.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.opts.fuseTopK)
      .map(([k, s]) => ({ ...cand.get(k)!, final_score: s }));
    return enrichWithSource(fused);
  }
}

/** 기존 함수형 인터페이스 유지(호환) */
export async function matchHybrid(query: string, topK = config.matchTopK): Promise<Candidate[]> {
  return new HybridRetriever({ fuseTopK: topK }).retrieve(query);
}
