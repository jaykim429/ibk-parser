/**
 * core-ai 백엔드 호출 (전부 읽기 전용: analyze / parse / match)
 * 서버 DB에 아무것도 쓰지 않는다.
 */

import { config } from "./config";

const CORE_AI_BASE_URL = config.coreAiBaseUrl;
const TIMEOUT = config.pipelineTimeoutMs;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${CORE_AI_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      detail = j?.detail || j?.error || detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${path} 실패: ${detail}`);
  }
  return (await res.json()) as T;
}

// ── 타입 ──────────────────────────────────────────────
export type ItemType = "bill" | "policy";

export type Analysis = {
  success: boolean;
  law_name: string;
  law_domain: string;
  core_summary: string;
  summary: string;
  change_overview: Record<string, unknown>[];
  provision_changes: Record<string, unknown>[];
  search_keywords: string[];
  semantic_concepts: string[];
  [k: string]: unknown;
};

export type Candidate = {
  regulation_id: number;
  regulation_name: string;
  jo?: string;
  jo_title?: string;
  hang?: string;
  ho?: string;
  mok?: string;
  byeolpyo?: string;
  type?: string;
  regulation_content?: string;
  department?: string;
  category?: string;
  importance?: string;
  final_score?: number;
  hybrid_score?: number;
  rerank_score?: number;
  candidate_reason?: string;
  match_source?: string;
  matched_keywords?: string[];
  related_laws?: Record<string, unknown>[];
  related_law_names?: string[];
  [k: string]: unknown;
};

// ── 호출 ──────────────────────────────────────────────
export async function analyzeDocument(args: {
  lawName: string;
  documentText: string;
  itemType: ItemType;
}): Promise<Analysis> {
  return post<Analysis>("/api/v1/analyze/document", {
    law_name: args.lawName,
    document_text: args.documentText.slice(0, 60000),
    item_type: args.itemType,
  });
}

export async function parseBill(args: {
  billId: string;
  billName: string;
  billText: string;
  isPolicy: boolean;
}): Promise<{ provisions: Record<string, unknown>[]; extracted_keywords?: string[] }> {
  return post("/api/v1/parse/bill", {
    bill_id: args.billId,
    bill_name: args.billName,
    bill_text: args.billText.slice(0, 60000),
    is_policy: args.isPolicy,
  });
}

export type HybridMatchResponse = {
  document_id: string;
  law_name: string;
  matches: {
    high_importance?: Candidate[];
    medium_importance?: Candidate[];
    low_importance?: Candidate[];
  };
  total_count: number;
  processing_time_ms: number;
  error?: string;
};

export async function matchHybrid(args: {
  documentId: string;
  itemType: ItemType;
  lawName: string;
  documentText: string;
  provisions?: Record<string, unknown>[];
  analysis?: Analysis;
  topK?: number;
}): Promise<HybridMatchResponse> {
  return post<HybridMatchResponse>("/api/v1/match/hybrid", {
    document_id: args.documentId,
    item_type: args.itemType,
    law_name: args.lawName,
    document_text: args.documentText.slice(0, 60000),
    provisions: args.provisions ?? [],
    pre_computed_analysis: args.analysis ?? null,
    top_k: args.topK ?? 20,
    use_reranker: true,
    use_keyword_extraction: true,
    use_graph_evidence: true,
  });
}

// ── 헬퍼 ──────────────────────────────────────────────
export function flattenMatches(m: HybridMatchResponse["matches"]): Candidate[] {
  return [
    ...(m.high_importance ?? []),
    ...(m.medium_importance ?? []),
    ...(m.low_importance ?? []),
  ];
}

/**
 * 매칭용 정규화 쿼리 조립.
 * 다양한 포맷/길이의 업로드 문서를 그대로 쓰지 않고, analyze가 정규화한
 * (분야·핵심요약·키워드·개념·신구조문)으로 일관된 쿼리를 만든다.
 * analyze 실패 시에만 원문(markdown) 앞부분으로 폴백.
 */
/**
 * analyze 실패 시 폴백 쿼리 — 원문 머리말의 표/마크업 노이즈(의안 표 등)를 제거하고
 * '제안이유/주요내용' 중심 + parseBill 조문 텍스트로 밀도 높은 쿼리를 만든다.
 * (analyze 실패 시 원문 앞부분을 그대로 쓰면 의안 표 마크다운이 들어가 검색이 망가짐)
 */
function buildFallbackQuery(
  provisions: Record<string, unknown>[],
  fallbackText: string
): string {
  // parseBill 조문에서 텍스트 수집(필드명이 제각각이라 문자열 값들을 모음)
  const provText = (provisions ?? [])
    .flatMap((p) =>
      ["content", "text", "provision_content", "title", "name"]
        .map((k) => (p && typeof p === "object" ? (p as Record<string, unknown>)[k] : undefined))
        .filter((v) => typeof v === "string")
    )
    .join(" ")
    .slice(0, 600);

  // 원문 정리: 표 행/구분선/HTML/헤딩 마크업 제거
  const clean = (fallbackText ?? "")
    .replace(/\|[^\n]*\|/g, " ")
    .replace(/[-|]{2,}/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/#{1,6}\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // '제안이유 / 주요내용 / 개정이유' 이후 본문을 우선 추출
  const m = clean.match(/(제안\s*이유|주요\s*내용|개정\s*이유)[\s\S]{0,800}/);
  const core = (m ? m[0] : clean).slice(0, 800);

  const combined = `${provText} ${core}`.replace(/\s+/g, " ").trim();
  return (combined || clean).slice(0, 800);
}

/** 객체에서 문자열 값만 모아 한 줄로(변경 단위 텍스트 추출용) */
function objText(o: unknown): string {
  if (o == null) return "";
  if (typeof o === "string") return o;
  if (typeof o !== "object") return String(o);
  return Object.values(o as Record<string, unknown>)
    .filter((v): v is string => typeof v === "string")
    .join(" ");
}

/**
 * 입력 문서 "청킹" — 긴 규제 문서의 변경점이 여러 개일 때 단일 쿼리로 다 못 잡는 문제 해결.
 * 변경 단위(analyze.provision_changes 우선, 없으면 parseBill provisions)별로 서브쿼리를 만든다.
 * 각 서브쿼리로 검색→융합하면 문서 내 모든 변경에 대응하는 내규를 빠짐없이 끌어온다.
 */
export function buildSubQueries(
  analysis: Analysis | undefined,
  provisions: Record<string, unknown>[],
  maxQueries = 6
): string[] {
  const head = analysis
    ? [analysis.law_name, analysis.law_domain].filter(Boolean).join(" ")
    : "";
  const units: unknown[] =
    analysis?.provision_changes?.length
      ? analysis.provision_changes
      : analysis?.change_overview?.length
        ? analysis.change_overview
        : provisions ?? [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of units) {
    const body = objText(u).replace(/\s+/g, " ").trim();
    if (body.length < 8) continue;
    const q = `${head} ${body}`.trim().slice(0, 280);
    const dedup = q.slice(0, 60);
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push(q);
    if (out.length >= maxQueries) break;
  }
  return out;
}

export function buildCanonicalQuery(
  analysis: Analysis | undefined,
  provisions: Record<string, unknown>[],
  fallbackText: string
): string {
  // ⚠️ match/hybrid는 "긴 원문"을 넣으면 임베딩이 희석되어 후보가 거의 안 나온다.
  //    (실측: 원문 8000자 → 0건, 키워드 위주 짧은 쿼리 → 11건)
  //    따라서 analyze가 정규화한 키워드·개념 중심으로 "짧고 밀도 높은" 쿼리를 만든다.
  if (!analysis || !analysis.success) {
    return buildFallbackQuery(provisions, fallbackText);
  }
  const terms = [
    ...(analysis.search_keywords ?? []),
    ...(analysis.semantic_concepts ?? []),
  ]
    .map((s) => String(s).trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const term of terms) {
    if (seen.has(term)) continue;
    seen.add(term);
    uniq.push(term);
    if (uniq.length >= 30) break;
  }

  const head = [analysis.law_name, analysis.law_domain].filter(Boolean).join(" ");
  const q = `${head} ${uniq.join(", ")}`.trim();

  // 키워드가 비어 핵심요약만 있는 경우의 폴백 (그래도 짧게 유지)
  if (uniq.length === 0) {
    return `${head} ${(analysis.core_summary ?? "").replace(/\s+/g, " ").slice(0, 300)}`.trim()
      || fallbackText.replace(/\s+/g, " ").slice(0, 500);
  }
  return q.slice(0, 800);
}

/** 파일명/본문으로 입법예고·시행령 등(policy) vs 법률안(bill) 판별 */
export function detectItemType(filename: string, text: string): ItemType {
  // 파일명에 명시적 법률안/의안 신호가 있으면 우선 bill
  if (/(법률안|법안|의안|개정법률안)/.test(filename)) return "bill";
  // 시행령/입법예고/고시 등은 policy (바로 "고시"·"예고" 단어는 본문에 흔해 제외)
  const hay = filename + " " + text.slice(0, 3000);
  if (/(입법예고|시행령|시행규칙|개정고시|규정변경예고|일부개정령|행정규칙)/.test(hay)) {
    return "policy";
  }
  return "bill";
}

/**
 * 문서 성격 — 규범(법안/입법예고/시행령/고시 등 구속력 있는 변경) vs 정보성(보도자료/설명/참고).
 * 정보성 자료는 그 자체로 개정 의무가 없으므로 보고서를 "동향 모니터링" 관점으로 다룬다.
 */
export type DocNature = "규범" | "정보성";

// 정보성(비구속) 신호 — 보도/설명/해석/의견 계열. 한국 금융·행정 문서 보편.
const INFORMATIONAL_DOC =
  /(보도자료|보도설명|보도참고|설명자료|해명자료|참고자료|안내자료|보도시점|간담회|브리핑|질의\s*회신|질의\s*응답|회신서|유권해석|법령해석|법령\s*질의|해석례|비조치\s*의견서|비조치\s*의견|비조치|노액션|no[-\s]?action|Q\s*&\s*A|FAQ|카드뉴스|인포그래픽)/i;
// 규범(구속력 있는 제·개정) 신호
const NORMATIVE_DOC =
  /(법률안|법안|의안|개정법률안|시행령|시행규칙|일부개정령|개정고시|고시안|공고안|규정변경예고|입법예고|행정규칙|개정안|제정안|대통령령|총리령|부령)/;

export function detectDocNature(filename: string, text: string): DocNature {
  if (INFORMATIONAL_DOC.test(filename) && !NORMATIVE_DOC.test(filename)) return "정보성";
  const hay = filename + " " + text.slice(0, 1500);
  if (INFORMATIONAL_DOC.test(hay) && !NORMATIVE_DOC.test(hay)) return "정보성";
  return "규범";
}
