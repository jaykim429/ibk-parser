/**
 * core-ai 백엔드 호출 (전부 읽기 전용: analyze / parse / match)
 * 서버 DB에 아무것도 쓰지 않는다.
 */

import { config } from "./config";
import { callCompletion, extractJson } from "./llm";

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
export type ItemType = "bill" | "policy" | "guideline";

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

/**
 * 대형 문서 본문 클램프 — 단순 앞자르기(head-only) 대신 head+tail 샘플링.
 *
 * 왜: 법률안/의안은 핵심이 양끝에 흩어진다 — 제안이유·주요내용은 앞,
 *    부칙(시행일·경과조치)·후반 신설/개정 조문은 뒤. head-only 절단은 뒤를 통째로 버려
 *    후반 변경점을 분석이 보지 못한다. (변경점 자체는 P1 신구조문대비표가 전체 blocks에서
 *    별도 추출하므로 매칭은 보존되지만, analyze의 요약·키워드·도메인 판정은 head만 본다.)
 *    도메인 하드코딩 없이 일반적으로 양끝을 모두 표본화한다.
 * 한도 이하면 원문 그대로. 초과 시 앞 70% + 뒤 30%(경계 표식 삽입).
 */
export function clampDocText(text: string, max: number): string {
  if (!text || text.length <= max) return text || "";
  const marker = "\n\n…(중략: 본문 일부 생략)…\n\n";
  const budget = max - marker.length;
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

// ── 호출 ──────────────────────────────────────────────
export async function analyzeDocument(args: {
  lawName: string;
  documentText: string;
  itemType: ItemType;
}): Promise<Analysis> {
  return post<Analysis>("/api/v1/analyze/document", {
    law_name: args.lawName,
    document_text: clampDocText(args.documentText, config.maxAnalyzeChars),
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
    bill_text: clampDocText(args.billText, config.maxAnalyzeChars),
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
    document_text: clampDocText(args.documentText, config.maxAnalyzeChars),
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

  // 제안이유/주요내용 등 '핵심 본문 진입' 라벨 이후를 우선 추출(법안·고시·정보성 공통 보편 라벨)
  const m = clean.match(
    /(제안\s*이유|개정\s*이유|개정\s*사유|제정\s*이유|폐지\s*이유|추진\s*배경|주요\s*내용|주요\s*개정\s*내용|주요\s*골자|골자|개요|신구조문|제안\s*경위)[\s\S]{0,800}/
  );
  const core = (m ? m[0] : clean).slice(0, 800);

  const combined = `${provText} ${core}`.replace(/\s+/g, " ").trim();
  return (combined || clean).slice(0, 800);
}

/**
 * 객체에서 텍스트를 한 줄로 평탄화(변경 단위 텍스트 추출용).
 * ⚠️ 중첩 객체/배열까지 재귀 — provision_changes의 before/after(신·구조문)가
 *    nested로 들어와도 유실되지 않게 한다(얕은 추출은 변경 핵심을 놓침).
 */
function objText(o: unknown, depth = 0): string {
  if (o == null) return "";
  if (typeof o === "string") return o;
  if (typeof o === "number" || typeof o === "boolean") return String(o);
  if (depth > 4) return ""; // 순환/과대 객체 방어
  if (Array.isArray(o)) return o.map((v) => objText(v, depth + 1)).join(" ");
  if (typeof o === "object") {
    return Object.values(o as Record<string, unknown>)
      .map((v) => objText(v, depth + 1))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/**
 * 입력 문서 "청킹" — 긴 규제 문서의 변경점이 여러 개일 때 단일 쿼리로 다 못 잡는 문제 해결.
 * 변경 단위(analyze.provision_changes 우선, 없으면 parseBill provisions)별로 서브쿼리를 만든다.
 * 각 서브쿼리로 검색→융합하면 문서 내 모든 변경에 대응하는 내규를 빠짐없이 끌어온다.
 */
export function buildSubQueries(
  analysis: Analysis | undefined,
  provisions: Record<string, unknown>[],
  maxQueries = config.subQueryMax
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
  let eligible = 0;
  for (const u of units) {
    const body = objText(u).replace(/\s+/g, " ").trim();
    if (body.length < config.subQueryMinLen) continue;
    // ⚠️ dedup은 head가 아니라 'body' 기준 — 모든 쿼리가 head로 시작하므로
    //    head가 길면 head-포함 prefix가 전부 같아져 서브쿼리가 1개로 붕괴한다.
    const dedup = body.slice(0, 80);
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    eligible++;
    if (out.length < maxQueries) out.push(`${head} ${body}`.trim().slice(0, 280));
  }
  if (eligible > out.length) {
    console.log(
      `[CHUNK] 서브쿼리 캡 적용: 변경단위 ${eligible}개 중 ${out.length}개만 쿼리화(상한 ${maxQueries}, ${eligible - out.length}개 드롭)`
    );
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
  let distinct = 0;
  for (const term of terms) {
    if (seen.has(term)) continue;
    seen.add(term);
    distinct++;
    if (uniq.length < config.canonicalTermMax) uniq.push(term);
  }
  if (distinct > uniq.length) {
    console.log(
      `[CHUNK] 대표쿼리 키워드 캡: ${distinct}개 중 ${uniq.length}개 사용(상한 ${config.canonicalTermMax})`
    );
  }

  const head = [analysis.law_name, analysis.law_domain].filter(Boolean).join(" ");
  // M3: 자연어 핵심요약을 키워드 앞에 혼합(문장 학습 임베딩 정합↑). 길이는 그대로 800자 캡.
  const summary = config.canonicalUseSummary
    ? (analysis.core_summary ?? "").replace(/\s+/g, " ").trim().slice(0, 300)
    : "";
  const q = [head, summary, uniq.join(", ")].filter(Boolean).join(" ").trim();

  // 키워드가 비어 핵심요약만 있는 경우의 폴백 (그래도 짧게 유지)
  if (uniq.length === 0) {
    return `${head} ${(analysis.core_summary ?? "").replace(/\s+/g, " ").slice(0, 300)}`.trim()
      || fallbackText.replace(/\s+/g, " ").slice(0, 500);
  }
  return q.slice(0, 800);
}

/** 파일명/본문으로 가이드라인(자율규제) · 입법예고·시행령·고시·규정 등(policy) · 법률안(bill) 판별 */
export function detectItemType(filename: string, text: string): ItemType {
  // 파일명에 명시적 법률안/의안 신호가 있으면 우선 bill
  if (/(법률안|법안|의안|개정법률안)/.test(filename)) return "bill";
  // 가이드라인·모범규준·자율규제 등 '연성규범' — 이미 공표된 자율적용 문서.
  //   법률안/시행령처럼 '확정 전' 단계가 아니라 즉시 정합성 점검 대상. 파일명·머리말로 판별.
  const guideHay = filename + " " + text.slice(0, 1500);
  if (/(가이드라인|가이드\s*북|모범규준|모범기준|모범사례|best\s*practice|자율규제|행동규범|행동강령\s*표준|운영기준\s*가이드|업무\s*가이드|실무\s*지침서|권고안)/i.test(guideHay)) {
    return "guideline";
  }
  // 규정/고시/지침류가 '파일명(=문서 자체 유형)'에 오면 policy.
  //   (본문 언급은 흔해 제외하되, 파일명은 문서 정체성이라 오탐 적음 → 규정·고시 샘플 정확 라우팅)
  if (/(규정|고시|지침|예규|훈령|준칙|세칙|요령)/.test(filename)) return "policy";
  // 시행령/입법예고 등은 본문 머리말까지 포함해 판별
  const hay = filename + " " + text.slice(0, 3000);
  if (/(입법예고|시행령|시행규칙|개정고시|규정변경예고|일부개정령|행정규칙)/.test(hay)) {
    return "policy";
  }
  return "bill";
}

/**
 * 소관 법령명 정리 — analyze가 법령명 추출에 실패해 '파일명'으로 폴백한 경우의 노이즈 제거.
 * 앞쪽 날짜/문서번호, [별첨n-n] 같은 첨부 표기, 끝의 (n)/_vF/확장자류, 공고번호 잔재를 떼어
 * 사람이 읽는 문서명에 가깝게 만든다. (특정 파일 하드코딩 아님 — 일반 패턴만 제거)
 */
export function cleanLawName(raw: string): string {
  const orig = (raw || "").trim();
  let s = orig;
  s = s.replace(/\.(hwpx?|pdf|docx?|txt)$/i, ""); // 확장자
  s = s.replace(/^\s*\d+(-\d+)?\s*[.)]\s*/, ""); // 앞 일련번호(예: "1. ", "2-1. ")
  s = s.replace(/^\s*\d{6,8}[._\-\s]*(?=[\[(［(가-힣A-Za-z])/, ""); // 앞 날짜/문서번호(260618_, 250313 , 260618[)
  // 앞쪽의 첨부/공고 표기 [별첨…] [금융위 공고…] [공고문(…호)] 등을 반복 제거(문서번호성 괄호 묶음)
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/^\s*[\[(［(][^\])］)]*(별첨|공고|고시|호\)|제\d|회신|공문)[^\])］)]*[\])］)]\s*/, "");
    if (next === s) break;
    s = next;
  }
  s = s.replace(/\[[^\]]*별첨[^\]]*\]\s*/g, ""); // 본문 중간 [별첨2-2]
  // 괄호가 짝이 안 맞아 남은 선행 닫힘기호/구두점 정리(예: "] 금융감독원…")
  s = s.replace(/^[\s\]\)）］>·\-–—:]+/, "");
  s = s.replace(/[_\s]*v?F\b/gi, ""); // _vF / _F 버전 꼬리
  s = s.replace(/\s*[\(（]\s*\d+\s*[\)）]\s*$/, ""); // 끝의 (1) (2) 사본 표기
  s = s.replace(/\s{2,}/g, " ").trim();
  return s || orig;
}

export type Obligation = {
  /** 짧은 식별 키(영역 라벨) */
  key: string;
  /** 의무·권고 한 줄 제목 */
  title: string;
  /** 무엇을 요구하는지 1~2문장 */
  summary: string;
  /** 의무 성격 */
  kind: string; // 신규수립의무|기존강화|절차통제|조직기구|소비자보호|보안|위탁관리|기타
};

export type ObligationExtract = {
  /** 이 문서가 '내규 체계 신설/신규 의무'를 요구하는 원천문서인가 */
  requiresFramework: boolean;
  obligations: Obligation[];
};

/**
 * 원천문서(특히 가이드라인·모범규준·기본법)가 부과하는 **의무·권고 사항**을 추출한다.
 *
 * 왜: 가이드라인류는 '신구조문대비표/개정 조문'이 없어 기존 청킹(provision_changes 기반)으로는
 *    변경단위가 거의 안 잡힌다. 대신 본문이 요구하는 의무·통제·조직·절차를 항목화해야
 *    (1) 그 항목별로 내규를 정밀 검색하고(멀티쿼리), (2) 대응 내규 부재(갭)를 산출할 수 있다.
 * 하드코딩 없음 — 7대 원칙 같은 특정 체크리스트를 박지 않고 LLM이 문서에서 직접 추출.
 */
export async function extractObligations(args: {
  lawName: string;
  documentText: string;
  itemType: ItemType;
}): Promise<ObligationExtract> {
  const SYSTEM = `당신은 IBK기업은행 준법지원부의 규제 분석가다. 주어진 원천문서(법령안·시행령·고시·가이드라인·모범규준 등)가 **수범기관에 부과하는 의무·권고 사항**을 항목화한다.
목표: 이 문서가 요구하는 "해야 할 일"의 목록. 각 항목은 그 자체로 내규 정합성 점검의 단위가 된다.
원칙:
- 본문이 실제로 요구하는 의무·통제·절차·조직·문서(규정/지침) 수립을 **구체적으로** 뽑는다. 추상적 슬로건이 아니라 점검 가능한 단위로.
- 특히 **새로운 내규(규정·지침·체계) 수립을 요구**하거나, 조직·기구 설치(위원회·전담조직), 절차·통제(평가·승인·기록·점검·긴급정지 등), 교육, 보안, 위탁·제3자관리, 소비자보호 항목을 빠뜨리지 말 것.
- 문서에 7대 원칙·장/절 구조가 있으면 각 원칙/영역을 최소 1개 항목으로 커버한다. 단 특정 도메인을 가정해 없는 의무를 지어내지 말 것.
- 항목 수는 핵심 위주 5~14개. 서로 중복되지 않게.
- requiresFramework: 이 문서가 단순 수치/문구 일부개정이 아니라 **내규 체계 신설·신규 의무 도입**을 요구하면 true.
JSON만 출력: {"requiresFramework": true|false, "obligations": [{"key":"영역라벨","title":"의무 한 줄","summary":"무엇을 요구하는지 1~2문장","kind":"신규수립의무|기존강화|절차통제|조직기구|소비자보호|보안|위탁관리|기타"}]}`;
  try {
    const raw = await callCompletion({
      systemPrompt: SYSTEM,
      prompt: `## 문서\n제목: ${args.lawName}\n유형: ${args.itemType}\n본문:\n${clampDocText(args.documentText, config.maxAnalyzeChars)}`,
      maxTokens: 2200,
      temperature: 0.1,
    });
    const v = extractJson<{ requiresFramework?: boolean; obligations?: Obligation[] }>(raw);
    const obligations = (Array.isArray(v.obligations) ? v.obligations : [])
      .map((o) => ({
        key: String(o?.key ?? "").trim(),
        title: String(o?.title ?? "").trim(),
        summary: String(o?.summary ?? "").trim(),
        kind: String(o?.kind ?? "기타").trim(),
      }))
      .filter((o) => o.title || o.summary)
      .slice(0, 14);
    return { requiresFramework: v.requiresFramework === true, obligations };
  } catch {
    return { requiresFramework: false, obligations: [] };
  }
}

/** 의무 항목 → 정밀 검색용 서브쿼리(각 의무에 대응하는 내규를 검색 단계에서부터 끌어옴) */
export function buildObligationQueries(
  obligations: Obligation[],
  lawName: string,
  max = config.subQueryMax
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const o of obligations) {
    const body = `${o.title} ${o.summary}`.replace(/\s+/g, " ").trim();
    if (body.length < config.subQueryMinLen) continue;
    const dedup = body.slice(0, 80);
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    if (out.length < max) out.push(`${lawName} ${body}`.trim().slice(0, 280));
  }
  return out;
}

/**
 * 문서 성격 — 규범(법안/입법예고/시행령/고시 등 구속력 있는 변경) vs 정보성(보도자료/설명/참고).
 * 정보성 자료는 그 자체로 개정 의무가 없으므로 보고서를 "동향 모니터링" 관점으로 다룬다.
 */
export type DocNature = "규범" | "정보성";

// 순수 '전달 형식' — 보도/설명/안내/카드뉴스 등. 본문이 법안을 다뤄도 그 문서 자체는 비구속(정보성).
//   예: "OO법 개정안 보도자료" → 보도자료는 보도자료. (형식이 규범보다 우선)
const DELIVERY_FORMAT =
  /(보도자료|보도설명|보도참고|설명자료|해명자료|참고자료|안내자료|간담회|브리핑|카드뉴스|인포그래픽|Q\s*&\s*A|FAQ)/i;
// '해석/의견' 형식 — 그 자체는 비구속이나, 규범 제·개정 문서에 '첨부/참조'로 따라붙는 경우가 많아
//   규범 신호가 함께 있으면 본체(규범)를 우선한다.
const INTERPRETIVE_FORMAT =
  /(비조치\s*의견서?|비조치\s*의견|비조치|노액션|no[-\s]?action|유권해석|법령해석|법령\s*질의|해석례|질의\s*회신|질의\s*응답|회신서|회신)/i;
// 규범(구속력 있는 제·개정) 신호
const NORMATIVE_DOC =
  /(법률안|법안|의안|개정법률안|시행령|시행규칙|일부개정령|개정고시|고시안|공고안|규정변경예고|입법예고|행정규칙|개정안|제정안|대통령령|총리령|부령)/;

export function detectDocNature(filename: string, text: string): DocNature {
  // 1) 순수 전달형식(보도자료 등)이면 본문이 법안을 다뤄도 정보성 (형식 우선)
  const identity = filename + " " + text.slice(0, 300);
  if (DELIVERY_FORMAT.test(identity)) return "정보성";
  // 2) 규범 제·개정 신호가 있으면 규범 (해석/의견서가 '첨부'로 언급돼도 본체는 규범)
  const hay = filename + " " + text.slice(0, 1500);
  if (NORMATIVE_DOC.test(hay)) return "규범";
  // 3) 해석/의견 형식만 있으면(규범 신호 없음) 정보성
  if (INTERPRETIVE_FORMAT.test(hay)) return "정보성";
  return "규범";
}

// ── 도메인 관련성 게이트 ────────────────────────────────
export type RelevanceVerdict = { relevant: boolean; domain: string; reason: string };

/**
 * 1차 분류기 — 업로드 문서가 '은행·금융 규제/IBK 내규'와 관련된 사안인지 판정.
 * 검색은 무조건 top-K를 반환하므로(무관 문서도 '가장 가까운' 내규를 끌어옴), 매칭 전에
 * 도메인 자체가 무관한 문서(청년센터 코칭자료 등)를 차단한다.
 *  - 특정 키워드 하드코딩 없음 — 일반 원칙으로 LLM이 판단. [[avoid-hardcoding-general-llm]]
 *  - '애매하면 관련'으로 둬 경계 은행주제(예금자보호 등) 과차단 방지.
 *  - 실패 시 fail-open(true) — 분류기 오류로 실문서를 막지 않음.
 */
export async function assessRelevance(args: {
  title: string;
  documentText: string;
}): Promise<RelevanceVerdict> {
  const SYSTEM = `당신은 IBK기업은행 준법지원부의 1차 분류기다. **이 문서가 실제로 다루는 변경·조치 내용**이 IBK 업무·내규에 의무나 직접 영향을 주는지 판정한다.
핵심 질문: "이 문서의 **구체적 변경 내용**이, IBK가 (은행·금융회사·특수은행·공공기관·상장법인·고용주·개인정보처리자·AI 도입기관·일반 법인 중 어느 지위로든) 준수하거나 내규에 반영해야 할 의무·영향을 만드는가?"
- 관련(true): 이 문서의 변경이 위 지위의 IBK에 실질 의무·영향을 만드는 경우. 금융·감독·소비자보호·개인정보·신용정보·내부통제·전자금융·자본시장·공공기관 운영/공시 + 노동/근로/산업안전, AI·신기술, 개인정보 등 IBK에 적용되는 범용법의 '실질 의무 변경'. 보도자료·해석이라도 내용이 그러하면 관련.
- 무관(false): 이 문서의 변경이 **특정 타 산업 행위자·타 영역만** 바꾸고 IBK 업무와 무관한 경우.
- ⚠️ **결정적 원칙**: "그 법이 일반적으로/범용으로 모든 법인에 적용된다"는 **추상적 사실만으로 관련으로 판단하지 말 것.** 반드시 **이 문서가 바꾸는 구체적 내용**으로 판단한다. (예: 어떤 법의 이번 개정이 선거구·정원·타 산업 행위자·타 부처 소관 사항만 바꾸면, 그 법이 범용법이어도 *이 문서*는 무관.) 주제어 중복(소비자·분쟁·민원·절차 등)만으로 관련 금지(동음이의 주의).
- 애매하면 true(과도한 차단 금지). 단 **이 문서의 변경 내용이 IBK 업무와 명백히 무관**하면 false.
JSON만 출력: {"relevant": true|false, "domain": "분야 한 단어", "reason": "이 문서의 '변경 내용'이 IBK에 주는 영향 기준 한 문장"}`;
  try {
    const raw = await callCompletion({
      systemPrompt: SYSTEM,
      prompt: `## 문서\n제목: ${args.title}\n본문(발췌):\n${clampDocText(args.documentText, 4000)}`,
      maxTokens: 220,
      temperature: 0,
    });
    const v = extractJson<{ relevant?: boolean; domain?: string; reason?: string }>(raw);
    return {
      relevant: v.relevant !== false, // 명시적 false 가 아니면 관련(fail-open)
      domain: String(v.domain ?? ""),
      reason: String(v.reason ?? ""),
    };
  } catch {
    return { relevant: true, domain: "", reason: "관련성 판정 생략(분류기 호출 실패)" };
  }
}
