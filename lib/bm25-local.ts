/**
 * 로컬 BM25 검색 — IBK 내규 137개 조문 대상(원본 JSON).
 *
 *  IBK 내규는 OpenSearch에 적재돼 있지 않아, 같은 데이터로 인메모리 BM25를 구성한다.
 *  벡터(Qdrant)가 놓치는 정확 키워드 매칭(예: "신탁", "외부관리", "정산")을 보완한다.
 *  한글은 형태소 분석 없이 2-gram + 영숫자 토큰으로 근사한다.
 *  결과는 Qdrant 후보와 RRF로 융합된다([[match-hybrid]]).
 */
import { getAllArticles, type ArticleRec } from "./regulation-source";
import { config } from "./config";

const K1 = config.bm25K1;
const B = config.bm25B;

type Doc = { rec: ArticleRec; len: number; tf: Map<string, number> };
type Index = { docs: Doc[]; df: Map<string, number>; avgdl: number };

let idx: Index | null = null;

function tokenize(s: string): string[] {
  const lower = (s || "").toLowerCase();
  const tokens: string[] = [];
  for (const w of lower.match(/[a-z0-9]+/g) ?? []) tokens.push(w);
  for (const run of lower.match(/[가-힣]+/g) ?? []) {
    if (run.length <= 2) tokens.push(run);
    else for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

function build(): Index {
  const docs: Doc[] = [];
  const df = new Map<string, number>();
  let total = 0;
  for (const rec of getAllArticles()) {
    // 조문명·내규명은 신호가 강해 가중(앞에 한 번 더 포함)
    const text = `${rec.regName} ${rec.articleName} ${rec.articleName} ${rec.content}`;
    const toks = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    tf.forEach((_v, t) => df.set(t, (df.get(t) ?? 0) + 1));
    docs.push({ rec, len: toks.length, tf });
    total += toks.length;
  }
  return { docs, df, avgdl: docs.length ? total / docs.length : 1 };
}

export type Bm25Hit = { rec: ArticleRec; score: number };

export function bm25Search(query: string, topK = 40): Bm25Hit[] {
  if (!idx) idx = build();
  const { docs, df, avgdl } = idx;
  const N = docs.length;
  if (!N) return [];
  const qTokens = Array.from(new Set(tokenize(query)));
  const idf = new Map<string, number>();
  for (const t of qTokens) {
    const n = df.get(t) ?? 0;
    // BM25 idf (음수 방지)
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }
  const scored: Bm25Hit[] = [];
  for (const d of docs) {
    let s = 0;
    for (const t of qTokens) {
      const f = d.tf.get(t);
      if (!f) continue;
      const denom = f + K1 * (1 - B + (B * d.len) / avgdl);
      s += (idf.get(t) ?? 0) * ((f * (K1 + 1)) / denom);
    }
    if (s > 0) scored.push({ rec: d.rec, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
