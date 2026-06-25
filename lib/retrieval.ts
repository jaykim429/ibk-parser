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
import { enrichWithSource, getAllArticles } from "./regulation-source";
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

/**
 * 법령명 정규화 — 공백/개정표지/시행령 등 접미를 제거해 '핵심 법명'으로 환원.
 *   "전자금융거래법 시행령 일부개정령안" → "전자금융거래법"
 * 입력 법령명과 내규 근거법령을 같은 기준으로 비교(앵커 매칭)하기 위함.
 * (export: 순수 함수라 단위테스트 대상)
 */
export function baseLawName(s: string): string {
  let x = (s || "").replace(/\s+/g, "").replace(/[（(]\s*안\s*[）)]/g, "");
  const suf =
    /(일부개정법률안|일부개정령안|일부개정령|일부개정고시안|일부개정고시|개정법률안|개정령안|개정고시안|개정고시|개정령|개정안|제정안|폐지안|규정변경예고|입법예고|공고문|법률안|고시안|공고안|령안)$/;
  for (let i = 0; i < 3 && suf.test(x); i++) x = x.replace(suf, "");
  return x.replace(/(시행세칙|시행규칙|시행령)$/, "").trim();
}

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

  /** 같은 조(키)의 중복(특히 멀티청크 벡터 결과)을 best-rank 1건으로 접는다. */
  private collapseByKey(list: Candidate[]): Candidate[] {
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const c of list) {
      const k = keyOf(c);
      if (seen.has(k)) continue; // 첫(=상위 랭크) 청크만 대표로
      seen.add(k);
      out.push(c);
    }
    return out;
  }

  /**
   * RRF: score(d) = Σ 1/(k + rank_i(d))
   * ⚠️ 벡터 결과는 '청크' 단위라 같은 조가 여러 번 등장 → 먼저 조 단위로 접어
   *    랭크를 '서로 다른 조' 기준으로 매긴다(멀티청크 조의 RRF 과대계상 방지).
   */
  private fuse(vec: Candidate[], bm: Candidate[]): Candidate[] {
    const { rrfK, fuseTopK } = this.opts;
    const rrf = new Map<string, number>();
    const cand = new Map<string, Candidate>();

    this.collapseByKey(vec).forEach((c, i) => {
      const k = keyOf(c);
      rrf.set(k, (rrf.get(k) ?? 0) + 1 / (rrfK + i + 1));
      if (!cand.has(k)) cand.set(k, c);
    });
    this.collapseByKey(bm).forEach((c, i) => {
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
    if (!query.trim()) return []; // 빈 쿼리 가드(임베딩/BM25 노이즈 방지)
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

  /**
   * 근거법령 앵커(M1): 입력 법령명과 '근거법령'이 일치하는 내규 조문을 직접 찾는다.
   * 의미유사도와 무관한 '제도적 직접 관련' 후보 → 정밀 가점(소프트) + 누락분 주입(리콜).
   * 정규화 후 '완전 일치'로 비교(부분일치는 중소기업은행법↔은행법 같은 오앵커를 유발).
   */
  private anchorCandidates(lawName: string): Candidate[] {
    const base = baseLawName(lawName);
    if (base.length < 3) return [];
    const out: Candidate[] = [];
    for (const rec of getAllArticles()) {
      const hit = rec.relatedLaws.some((l) => baseLawName(l) === base);
      if (!hit) continue;
      out.push({
        regulation_id: rec.regId,
        regulation_name: rec.regName,
        jo: rec.jo || undefined,
        type: rec.type || undefined,
        regulation_content: rec.content,
        related_law_names: rec.relatedLaws,
        match_source: "anchor",
      });
    }
    // 의미검색 누락분 주입 시 substantive(긴 본문) 우선
    return out.sort((a, b) => (b.regulation_content?.length ?? 0) - (a.regulation_content?.length ?? 0));
  }

  /** 융합 결과에 근거법령 앵커를 반영: 존재 후보는 가점, 누락 후보는 상한 내 주입. 항상 fuseTopK로 컷. */
  private applyAnchor(fused: Candidate[], anchorLaw?: string): Candidate[] {
    const cut = (xs: Candidate[]) => xs.slice(0, this.opts.fuseTopK);
    if (!config.anchorEnabled || !anchorLaw) return cut(fused);
    const anchors = this.anchorCandidates(anchorLaw);
    if (!anchors.length) return cut(fused);
    const anchorKeys = new Set(anchors.map(keyOf));
    const present = new Set(fused.map(keyOf));
    // 1) 이미 의미검색에 잡힌 앵커 → 가점(정밀도)
    for (const c of fused) if (anchorKeys.has(keyOf(c))) c.final_score = (c.final_score ?? 0) + config.anchorBonus;
    // 2) 의미검색이 놓친 앵커 → 상한 내 주입(리콜). 다운스트림 리랭커/판정이 정밀도 필터.
    const injected = anchors
      .filter((a) => !present.has(keyOf(a)))
      .slice(0, config.anchorMax)
      .map((a) => ({ ...a, final_score: config.anchorBonus * 0.5 }));
    return [...fused, ...injected].sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0)).slice(0, this.opts.fuseTopK);
  }

  async retrieve(query: string, anchorLaw?: string): Promise<Candidate[]> {
    const fused = this.applyAnchor(await this.rawRetrieve(query), anchorLaw);
    return enrichWithSource(fused);
  }

  /**
   * 멀티쿼리(입력 문서 청킹): 변경 단위별 쿼리 결과를 'rank 기반 cross-RRF'로 융합.
   *  - 점수 크기(final_score)가 아니라 각 쿼리 내 '순위'로 가산 → 쿼리별 점수 스케일 편향 제거.
   *  - queries[0]은 대표(canonical) 쿼리로 가중치를 더 줄 수 있다(기본 동일).
   * 여러 변경점에서 공통으로 걸리는 내규는 합산 가점 → 문서 전체 변경을 빠짐없이 커버.
   */
  async retrieveMany(queries: string[], anchorLaw?: string, canonicalWeight = 1): Promise<Candidate[]> {
    const uniq = Array.from(new Set(queries.map((q) => q.trim()).filter(Boolean)));
    if (uniq.length === 0) return [];
    if (uniq.length === 1) return this.retrieve(uniq[0], anchorLaw);

    const { rrfK, fuseTopK } = this.opts;
    const lists = await Promise.all(uniq.map((q) => this.rawRetrieve(q)));
    const score = new Map<string, number>();
    const cand = new Map<string, Candidate>();
    lists.forEach((list, qi) => {
      const w = qi === 0 ? canonicalWeight : 1; // queries[0] = canonical
      list.forEach((c, rank) => {
        const k = keyOf(c);
        score.set(k, (score.get(k) ?? 0) + w / (rrfK + rank + 1));
        if (!cand.has(k)) cand.set(k, c);
        else if (c.match_source === "hybrid") cand.get(k)!.match_source = "hybrid";
      });
    });
    // 앵커 반영 전 더 넓게 확보(누락 앵커가 승격될 여지) 후 applyAnchor에서 fuseTopK로 컷
    const fused = Array.from(score.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, fuseTopK * 2)
      .map(([k, s]) => ({ ...cand.get(k)!, final_score: s }));
    return enrichWithSource(this.applyAnchor(fused, anchorLaw));
  }
}

/** 기존 함수형 인터페이스 유지(호환) */
export async function matchHybrid(query: string, topK = config.matchTopK): Promise<Candidate[]> {
  return new HybridRetriever({ fuseTopK: topK }).retrieve(query);
}
