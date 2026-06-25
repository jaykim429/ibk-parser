/**
 * IBK 내규 원문 보강 — Qdrant 매칭 결과를 로컬 원본 JSON으로 enrich.
 *
 * 배경: Qdrant payload의 regulation_content 는 인덱싱 시 1200자로 잘리고
 *       jo_title 도 조문명에 괄호가 없으면 비어 "제26조"만 남는다.
 *       원본 data/ibk-regulations/*.json 에는 (a) 완전한 조문명("제26조(금품등의 수수 금지)"),
 *       (b) sub_articles 까지 합친 전체 조문 원문이 있다.
 *       파일명 접두사(`80_...json`)가 regulation_id 라 한글 정규화 문제 없이 매핑된다.
 *
 * ⚠️ IBK 내규 전문은 도달 가능한 RDB/Neo4j에 없어(확인됨) 원본 JSON이 유일한 전문 소스다.
 *    내규가 추가/변경되면 이 디렉터리를 갱신하거나 전문 보유 스토어로 교체하면 된다.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { Candidate } from "./server";

const DIR = path.isAbsolute(config.regulationsDir)
  ? config.regulationsDir
  : path.join(process.cwd(), config.regulationsDir);

type SourceArticle = { articleName: string; content: string; relatedLaws: string[] };
let index: Map<string, SourceArticle> | null = null;

const key = (regId: number | string, type: string, jo: string) => `${regId}|${type}|${jo}`;

type RawArticle = {
  regulation_name?: string;
  regulation_content?: string;
  type?: string;
  jo?: string | number;
  related_laws?: { law_name?: string }[];
  sub_articles?: RawArticle[];
};

/** 조문(및 하위)에서 인용·근거 법령명 수집 — 규율 체계 일치 판단용 */
function collectLaws(a: RawArticle): string[] {
  const out: string[] = [];
  for (const l of a.related_laws ?? []) {
    const n = l?.law_name;
    if (n) out.push(String(n).trim());
  }
  for (const s of a.sub_articles ?? []) out.push(...collectLaws(s));
  return out;
}

function subText(subs: RawArticle[] | undefined): string {
  const out: string[] = [];
  for (const s of subs ?? []) {
    if (s && typeof s === "object") {
      const t = String(s.regulation_content ?? "").trim();
      if (t) out.push(t);
      const d = subText(s.sub_articles);
      if (d) out.push(d);
    }
  }
  return out.join("\n");
}

/** BM25/하이브리드용 전체 조문 레코드 */
export type ArticleRec = {
  regId: number;
  regName: string;
  type: string;
  jo: string;
  articleName: string;
  content: string;
  relatedLaws: string[];
};
let allArticles: ArticleRec[] | null = null;

function build(): void {
  const map = new Map<string, SourceArticle>();
  const list: ArticleRec[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
  } catch {
    index = map;
    allArticles = list;
    return;
  }
  for (const f of files) {
    const m = f.match(/^(\d+)_/);
    if (!m) continue;
    const regId = Number(m[1]);
    let j: { regulationName?: string; articles?: RawArticle[] };
    try {
      j = JSON.parse(readFileSync(path.join(DIR, f), "utf-8"));
    } catch {
      continue;
    }
    const regName = String(j.regulationName ?? f.replace(/^\d+_/, "").replace(/\.json$/, ""));
    for (const a of j.articles ?? []) {
      const body = String(a.regulation_content ?? "").trim();
      const sub = subText(a.sub_articles);
      const content = [body, sub].filter(Boolean).join("\n").trim();
      const type = String(a.type ?? "조");
      const jo = String(a.jo ?? "");
      const articleName = String(a.regulation_name ?? "");
      const relatedLaws = Array.from(new Set(collectLaws(a))).slice(0, 12);
      const k = key(regId, type, jo);
      // 같은 (조,번호) 중복(부칙 등)은 첫 항목 우선
      if (!map.has(k)) map.set(k, { articleName, content, relatedLaws });
      list.push({ regId, regName, type, jo, articleName, content, relatedLaws });
    }
  }
  index = map;
  allArticles = list;
}

function ensureBuilt() {
  if (!index || !allArticles) build();
}

function lookup(regId: number | string, type: string, jo: string): SourceArticle | undefined {
  ensureBuilt();
  return index!.get(key(regId, type, jo));
}

/** BM25 등 하이브리드 검색용 — 전 내규 조문 레코드 */
export function getAllArticles(): ArticleRec[] {
  ensureBuilt();
  return allArticles!;
}

/** 조문명에서 제목(괄호 안) 추출: "제26조(금품등의 수수 금지)" → "금품등의 수수 금지" */
function titleFromName(name: string): string {
  const m = name.match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : "";
}

/**
 * 후보 조문을 원본 JSON 전문으로 보강.
 *  - regulation_content: 잘리지 않은 전체 원문(본문+항/호/목)
 *  - jo_title: 조문명에 제목이 있으면 채움(없던 경우 "제26조"→"제26조(제목)")
 */
export function enrichWithSource(candidates: Candidate[]): Candidate[] {
  return candidates.map((c) => {
    const type = String(c.type ?? "조");
    const src = lookup(c.regulation_id, type, String(c.jo ?? ""));
    if (!src) return c;
    const next: Candidate = { ...c };
    if (src.content && src.content.length > (c.regulation_content?.length ?? 0)) {
      next.regulation_content = src.content;
    }
    if (!next.jo_title) {
      const title = titleFromName(src.articleName);
      if (title) next.jo_title = title;
    }
    // 근거·인용 법령(규율 체계 일치 판단용)
    if (src.relatedLaws.length) next.related_law_names = src.relatedLaws;
    return next;
  });
}
