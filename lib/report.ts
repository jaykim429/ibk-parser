/**
 * 컴플라이언스 보고서 생성 — "결정적 조립 + LLM 분석" 방식
 *
 *  - LLM은 분석 텍스트(개요·조문별 비교/권고·우선조치)만 생성한다.
 *  - 조문 원문(현재 내규내용), 조문명/영향도/반영여부, 조치 요약표, 헤더/유의사항은
 *    코드가 결정적으로 조립한다 → 원문 패러프레이즈·번호 흔들림·표 중복·모순 제거.
 *  - 조(條)는 원문을 그대로 인용, 별표/별지서식은 길어서 요약만.
 *  - 문서 성격(법률안/입법예고/보도자료/공포 등)에 따라 단정성을 LLM이 조절.
 *
 * stateless /generate/completion 사용 → 서버 DB 적재 없음.
 */
import { callCompletion, extractJson } from "./llm";
import { formatRegulationItemName, inferRegulationKind } from "./regulation-format";
import { cleanLawName, BILL_SIGNAL, PENDING_STRONG, PENDING_WEAK, type Analysis, type ItemType, type Obligation } from "./server";
import { normalizeWhitespace } from "./doc-text";
import type { JudgedMatch, CoverageItem } from "./judge";

const REPORT_SYSTEM = `당신은 IBK기업은행 준법지원부의 컴플라이언스 보고서 작성 전문가입니다.
규제변동(법률안/입법예고/시행령/고시/보도자료 등)이 IBK 사내규정에 미치는 영향을 분석합니다.
IBK는 「중소기업은행법」상 특수은행이자 기타공공기관이며 동시에 유가증권시장 상장 은행입니다.

작성 원칙:
- **문체는 개조식으로 통일한다.** 명사형/어간 종결("~함", "~필요", "~검토", "~유지", "~신설")만 사용. "~합니다/~입니다/~하십시오/~된다" 같은 경어체·서술형 종결 금지.
- **문서의 성격(stage)에 따라 단정성을 조절한다. "확정 시 / 개정될 경우" 같은 조건부 표현은 아래 (가)에만 쓰고, (나)·(다)에는 절대 쓰지 말 것.**
  - (가) **미발효 입법예고·법률안(발의)·규정변경예고·사전예고** = 확정 전 → "확정 시", "개정될 경우" 같은 조건부 표현 사용.
  - (나) **이미 시행·통용 중인 연성규범(가이드라인·모범규준·행정지도·자율규제 규정)과 공포/개정 전문** = 사실상 적용 중 → "확정 시" 금지. **즉시·조속·선제 점검** 등 확정적 권고로 쓴다(입법 확정을 기다리는 단계 아님).
  - (다) **정보성 자료(보도자료·해설서·안내서·FAQ·법령해석·비조치)** → 개정으로 단정 금지. **동향 모니터링·사전 검토** 표현(조건부 "확정 시"가 아님).
- 주어진 조문 원문과 규제변동 내용을 **직접 비교**해 사실 기반으로 쓴다. 원문에 이미 같은 기준(금액·요건)이 있으면 "반영됨"으로 본다. 원문에 없는 내용을 추측하지 않는다.
- 주어진 후보 외의 내규·조문을 지어내지 않는다. 개발자용 설명(벡터·임베딩·모델명) 금지.
- 한국어. 실무자가 바로 활용하도록 간결·구체적으로.`;

export type ReportInput = {
  lawName: string;
  itemType: ItemType;
  analysis?: Analysis;
  judged: JudgedMatch[];
  fileName: string;
  candidateCount: number;
  infoOnly?: boolean;
  /** 권고2: 요건 커버리지 — 의무별 충족/부분/부재 체크리스트. 부재=높음·부분=중간으로 집계. */
  coverage?: CoverageItem[];
  /** 추출된 의무·권고 — 가이드라인/모범규준 등에서 1.1을 상세히 쓰기 위한 입력(개정안엔 비어있을 수 있음) */
  obligations?: Obligation[];
  /** 신구조문대비표(현행→개정) — 개정안·입법예고의 1.1 핵심 근거 */
  amendmentPairs?: { before: string; after: string }[];
  /** 원문이 길어 분석에 일부만 반영됐는지(절단) — 유의사항 도출용 */
  truncated?: boolean;
  /** 사전예고/예고(확정 전) 문서 — 즉시적용이 아닌 조건부(미확정) 프레이밍 */
  preAnnouncement?: boolean;
  /** 시행일·유예기간 — 문서에 명시된 경우만(백테스팅: 시급성 점수화 없이 사실만 표기) */
  effectiveDate?: string;
  gracePeriod?: string;
};

/**
 * '확정 전(미발효 입법)' 문서인가 — "확정 시" 같은 조건부 표현은 여기에만 허용.
 *  정보성은 별도(모니터링)로 처리하므로 false. 이미 시행 중인 연성규범·전문(전문/공포)은 false(즉시 권고).
 *  (LLM 자체 certainty 추정이 과하게 '미확정'을 남발 → 파일명/제목 기반으로 결정적으로 판단)
 */
function isPendingDoc(input: ReportInput): boolean {
  if (input.infoOnly) return false;
  if (input.preAnnouncement) return true;
  // 강신호(법률안·개정령안·입법예고 등)는 파일명·법령명 어디서든 인정.
  if (PENDING_STRONG.test(`${input.fileName} ${input.lawName}`)) return true;
  // 약신호 '(안)'은 파일명에만 — analyze가 본문 초안 표제에서 끌어온 법령명의 잔재 '(안)'으로
  //  기제정·기시행 문서가 미발효로 오분류되는 것을 막는다(예: '…업무처리기준(안)' → 2011 제정 문서).
  return PENDING_WEAK.test(input.fileName);
}

/**
 * 문서 권고 프레이밍(단일 결정점) — buildPrompt(LLM 지시)와 assembleBody(stageNote)가
 *  같은 결론을 쓰도록 한 곳에서 판단(이전: prompt는 pending만, stageNote는 다른 우선순위 → 상충).
 *  우선순위: 정보성 > 사전예고 > 연성규범(가이드라인=즉시) > 미발효 입법(조건부) > 시행/전문(즉시).
 */
type DocFraming = "monitoring" | "conditional" | "immediate";
function docFraming(input: ReportInput): DocFraming {
  if (input.infoOnly) return "monitoring";
  if (input.preAnnouncement) return "conditional";
  if (input.itemType === "guideline") return "immediate"; // 연성규범: 미발효라도 즉시 점검(자율준수)
  if (isPendingDoc(input)) return "conditional"; // 미발효 입법(법률안·입법예고·개정령안 등)
  return "immediate"; // 공포·시행·전문
}

/**
 * 은행·금융 규제와 직접 관련이 없는 문서용 보고서.
 * 독자(실무자) 관점의 서술 — 개발/시스템 용어 없이 '왜 무관한지'를 내용 기반으로 설명한다.
 */
export function buildOffDomainReport(title: string, reason: string): string {
  const date = formatKstDate();
  const why =
    reason ||
    "본 문서는 은행·금융 규제나 IBK 사내규정과 직접 관련되는 내용을 담고 있지 않음.";
  return `# 규제변동 영향분석 보고서

**분석 정보**

- **분석 일자**: ${date}
- **문서명**: ${title}
- **분석 결과**: IBK 내규에 미치는 직접 영향 없음

## 1. 규제변동 개요
${outline([why], "- 문서 내용 확인 필요")}

## 2. 내규 영향 분석
${outline(
    [
      "위 내용은 은행·금융 규제 및 IBK 사내규정의 적용 범위와 직접적인 관련이 없음.",
      "이에 따라 개정·보완이 필요한 IBK 사내규정은 확인되지 않음.",
    ],
    "- 영향 분석 정보 부족"
  )}

## 3. 결론
${outline(
    [
      "본 규제변동은 IBK 내규에 미치는 직접적 영향이 없는 것으로 판단됨.",
      "향후 은행·금융 업무와의 연관성이 새롭게 발생할 경우 소관 부서의 개별 검토를 권장함.",
    ],
    "- 결론 정보 부족"
  )}`;
}


/**
 * 문서유형 라벨 — itemType만으로는 'bill 캐치올'(실제 법률안 아님)·'policy 발효여부'를 구분 못해 오라벨이 난다.
 *  · 정보성 → 정보성 자료
 *  · guideline → 가이드라인/모범규준
 *  · bill: 진짜 법률안/의안 신호 있으면 "법률안", 아니면(기준·매뉴얼 등 캐치올) "기준·규범 문서"
 *  · policy: 미발효(입법예고·개정령안)면 "입법예고/규정변경예고 등", 발효(규정·고시·세칙 전문)면 "규정·고시·세칙 등"
 */
function docTypeLabelOf(input: ReportInput): string {
  if (input.infoOnly) return "보도자료 등 정보성 자료";
  if (input.itemType === "guideline") return "가이드라인/모범규준(자율규제)";
  if (input.itemType === "bill") {
    return BILL_SIGNAL.test(`${input.fileName} ${input.lawName}`)
      ? "법률안"
      : "기준·규범 문서";
  }
  // policy
  return isPendingDoc(input) ? "입법예고/규정변경예고 등" : "규정·고시·세칙 등";
}

type ArticleAnalysis = {
  index: number;
  gist?: string;
  comparison?: string;
  recommendation?: string;
};
/** 개조식 항목 — 문자열(잎) 또는 {text, children}(하위 보유). 깊이는 AI가 내용에 맞게 판단. */
type OutlineItem = string | { text?: string; children?: OutlineItem[] };
type LlmReport = {
  doc_stage?: string;
  certainty?: string;
  overview_changes?: OutlineItem[];
  ibk_view?: OutlineItem[];
  articles?: ArticleAnalysis[];
  priority_actions?: OutlineItem[];
  caveats?: OutlineItem[];
};

export async function generateReport(input: ReportInput): Promise<string> {
  const relevant = input.judged.filter((j) => j.verdict.relevance === "적합");
  const gapCount = (input.coverage ?? []).filter((g) => g && g.requirement && g.coverage !== "충족" && g.coverage !== "해당없음").length;
  const header = buildHeader(input, relevant.length);

  // 적합 내규도 없고 커버리지 갭도 없을 때만 '영향 없음' 단락. 갭이 있으면(가이드라인 신규요건 등)
  // 적합 0건이어도 갭 섹션을 보여줘야 한다(과소커버리지 방지).
  if (relevant.length === 0 && gapCount === 0) {
    const sec4 = buildCaveats(input, []);
    return [header, noMatchBody(input), sec4].filter(Boolean).join("\n\n");
  }

  let llm: LlmReport = {};
  // 개요·적용관점이 모두 비면(OCR 손상 본문 등으로 생성 실패) 1회 재시도 후, 그래도 비면 정직 고지.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callCompletion({
        systemPrompt: REPORT_SYSTEM,
        prompt: buildPrompt(input, relevant),
        maxTokens: 6000,
        temperature: attempt === 0 ? 0.2 : 0,
      });
      llm = extractJson<LlmReport>(raw);
    } catch (e) {
      // LLM 보고서 생성 실패 → 결정적 본문만으로 폴백(원인 추적 위해 로그)
      console.warn(`[REPORT] 보고서 LLM 생성/파싱 실패(시도 ${attempt + 1}/2): ${(e as Error)?.message ?? e}`);
      llm = {};
    }
    if ((llm.overview_changes?.length ?? 0) > 0 || (llm.ibk_view?.length ?? 0) > 0) break;
  }
  if (!(llm.overview_changes?.length) && !(llm.ibk_view?.length)) {
    // '정보 부족' 플레이스홀더 대신 추출 한계를 사용자에게 정직하게 고지(빈 섹션 노출 방지).
    llm.overview_changes = [
      "이 문서는 글꼴 손상 또는 스캔 페이지(OCR 복구분)로 자동 변경요약 생성이 제한되었습니다. 아래 영향 내규·요건 커버리지는 참고하되, 구체 변경 내용은 원문을 직접 확인해 주세요.",
    ];
  }

  const body = assembleBody(input, relevant, llm);
  const sec4 = buildCaveats(input, (llm.caveats ?? []).filter(Boolean));
  return [header, body, sec4].filter(Boolean).join("\n\n");
}

// ── 헤더(결정적) ───────────────────────────────────────
function buildHeader(input: ReportInput, relevantCount: number): string {
  const date = formatKstDate();
  const domain = input.analysis?.law_domain || "-";
  // 파이프라인이 LLM documentTitle 우선으로 해소한 input.lawName을 신뢰(편집스펙 오인 방지)
  const lawName = cleanLawName(input.lawName || input.analysis?.law_name || "");
  const docTypeLabel = docTypeLabelOf(input);
  // 시행일/유예기간 — 명시된 경우만(백테스팅: 시급성 점수 아님, 사실 표기). 분석일보다 과거면 중립적으로 '이미 시행' 부기.
  // 미발효 입법(초안)은 '예정 시행일'일 뿐이므로 '(이미 시행)' 단정 금지(백테스팅: 제안 시행일이 분석일보다 과거여도 초안이면 미발효).
  // 정보성 자료(해설서·방법서·보도자료 등)는 자체 '시행일'이 없고 본문에 인용된 타법 시행일을
  //  끌어오기 쉬워(오표시 위험) 표시하지 않는다 — 시행일은 규범(infoOnly=false) 문서에만.
  const effLine = input.effectiveDate && !input.infoOnly
    ? `\n- **시행일**: ${input.effectiveDate}${isPendingDoc(input) ? " (예정, 미발효)" : isPastDate(input.effectiveDate, date) ? " (이미 시행)" : ""}`
    : "";
  const graceLine = input.gracePeriod ? `\n- **유예기간**: ${input.gracePeriod}` : "";
  return `# 규제변동 영향분석 보고서

**분석 정보**

- **분석 일자**: ${date}
- **문서유형**: ${docTypeLabel}
- **소관 법령**: ${lawName}
- **규제 분야**: ${domain}
- **영향 내규**: ${relevantCount}건${effLine}${graceLine}`;
}

/** 시행일 문자열이 분석일(YYYY-MM-DD)보다 과거인지 — 백테스팅 중립 표기용(점수 아님). 파싱 불확실하면 false. */
function isPastDate(eff: string, today: string): boolean {
  const m = eff.match(/(\d{2,4})[.년]\s*(\d{1,2})[.월]\s*(\d{1,2})/);
  if (!m) return false;
  let y = Number(m[1]);
  if (y < 100) y += 2000; // 2자리 연도
  const effNum = y * 10000 + Number(m[2]) * 100 + Number(m[3]);
  const t = today.replace(/[^\d]/g, "");
  const todayNum = Number(t.slice(0, 8));
  return Number.isFinite(effNum) && Number.isFinite(todayNum) && effNum < todayNum;
}

// ── LLM 프롬프트(분석 텍스트만 JSON으로) ───────────────
function buildPrompt(input: ReportInput, relevant: JudgedMatch[]): string {
  const obligations = input.obligations ?? [];
  const coverage = input.coverage ?? [];
  const framing = docFraming(input); // 단일 프레이밍 결정점(stageNote와 동일 우선순위 — 상충 제거)
  // 의무·권고 블록 — 1.1을 문서 실질 내용에 맞게 상세히 쓰기 위한 핵심 입력
  const oblBlock = obligations.length
    ? obligations.map((o) => `- (${o.kind}) ${o.title}: ${o.summary}`).join("\n")
    : "";
  const covBlock = coverage.length
    ? coverage
        .map((c) => `- ${c.requirement} → ${c.coverage}${c.evidence ? ` (${c.evidence})` : ""}`)
        .join("\n")
    : "";
  // 개정 개요/신구조문 — 개정안·입법예고에서 1.1의 핵심 근거(의무가 아니라 '무엇이 어떻게 바뀌나')
  const ov = (input.analysis?.change_overview ?? [])
    .slice(0, 8)
    .map((o) => objToLine(o))
    .filter(Boolean)
    .join("; ");
  const provCh = (input.analysis?.provision_changes ?? [])
    .slice(0, 8)
    .map((o) => objToLine(o))
    .filter(Boolean)
    .join("\n  · ");
  const amendBlock = (input.amendmentPairs ?? [])
    .slice(0, 8)
    .map((p, i) => `  ${i + 1}) 현행: ${cleanInline(p.before, 160)} → 개정: ${cleanInline(p.after, 160)}`)
    .join("\n");
  const changeSummary = [
    `- 문서유형(추정): ${docTypeLabelOf(input)}`, // 헤더 라벨과 동일 소스(불일치 제거 — bill 캐치올을 '법률안'으로 오인해 '확정 시' 헤지 남발하던 문제)
    `- 법령명: ${cleanLawName(input.lawName || input.analysis?.law_name || "")}`,
    input.analysis?.law_domain ? `- 분야: ${input.analysis.law_domain}` : "",
    input.analysis?.core_summary ? `- 핵심요약: ${input.analysis.core_summary}` : "",
    input.analysis?.summary ? `- 상세(개정이유·배경 등): ${input.analysis.summary}` : "",
    ov ? `- 개정 개요: ${ov}` : "",
    provCh ? `- 조문별 변경:\n  · ${provCh}` : "",
    amendBlock ? `- 신구조문대비표(현행→개정):\n${amendBlock}` : "",
    oblBlock ? `- (참고) 추출된 의무·권고 — 가이드라인/모범규준 등에서 핵심. 개정안·보도자료엔 비어있거나 적을 수 있음:\n${oblBlock}` : "",
    covBlock ? `- IBK 내규 커버리지:\n${covBlock}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const articleBlock = relevant
    .map((j, i) => {
      const kind = inferRegulationKind(j);
      const itemName = formatRegulationItemName(j);
      const content = cleanText(j.regulation_content, 1600);
      return `[${i}] 내규: ${j.regulation_name} / 구분: ${kind} / 조문명: ${itemName} / 영향도(확정): ${j.verdict.impact} / 개정필요성: ${j.verdict.compliance_need} / 반영여부(확정): ${reflectionOf(j, input.infoOnly)} / 리스크: ${j.verdict.risk_level ?? "중간"}
    조문 원문: ${content}`;
    })
    .join("\n\n");

  return `## 규제변동 정보
${changeSummary}

## 영향 내규 조문 (${relevant.length}건, 영향도 높은 순)
${articleBlock}

## 지시
아래 JSON 객체 **하나만** 출력하라(설명 문장·코드펜스 금지). 모든 텍스트는 개조식.

{
  "doc_stage": "법률안(발의)|입법예고|규정변경예고|보도자료|공포·시행|가이드라인/모범규준(자율규제)|기타 중 추정",
  "certainty": "확정|미확정",
  "overview_changes": [주요 변경·핵심 내용. **문서 성격에 맞는 근거로 상세히**(상위 3~6개, 필요시 children으로 세부 2~4개 중첩):
     · 개정안/입법예고/시행령/고시 → **개정이유·배경 + 신구조문(현행→개정) + 주요내용** 중심으로 '무엇이 어떻게 바뀌는가'를 구체적으로.
     · 가이드라인/모범규준 → 문서가 정하는 **의무·절차·체계·조직**(예: 위원회 설치, 검토보고서, 외부전문가 검토, 계약 필수사항, 감시·점검) 중심으로.
     · 보도자료/설명자료 → 발표된 **정책 방향·조치 내용** 중심(의무로 단정 금지).
     ⚠️ 문서에 없는 의무·내용을 지어내지 말 것. 의무가 없는 문서면 의무를 만들지 말고 개정이유·내용으로 작성. 내용이 적으면 간결히],
  "ibk_view": [IBK 적용 관점 — IBK의 어떤 지위(특수은행/은행/금융회사/공공기관/상장회사/고용주/개인정보처리자/AI도입기관)로 적용되는지 + 어떤 내규 영역(판매·내부통제·리스크·정보보호·위탁·인사 등)에 영향인지 + 왜인지를 2~4개로 구체적으로. 막연한 "검토 필요" 나열 금지],
  "articles": [
    { "index": 0, "gist": "이 조문이 규율하는 핵심을 명사형으로 25자 내외 1줄(예: '신상품 사전 리스크 검토 절차'). 조문 원문 기반, 군더더기 없이", "comparison": "조문 원문과 규제변동의 일치/일부차이/미반영을 사실 기반 1~2문장(개조식)", "recommendation": "유지/보완/개정 중 구체 조치 1~2문장(개조식). 단정성(조건부/확정)은 아래 '권고 표현' 규칙을 따른다" }
  ],
  "priority_actions": [영향도 '높음' 항목 중심 우선 조치. 문자열 또는 중첩 객체. 높음 없으면 빈 배열],
  "caveats": [이 **문서에 특유한** 진짜 유의사항만 0~2개(실무자가 오해/실수할 지점, 해석상 주의, 이 문서만의 한계). 사용자 친화적·비개발자 말투. ⚠️ 자율규제 강제력·확정 전 단계·신규/보완 필요 같은 **일반적 주의는 시스템이 따로 넣으니 제외**. "AI 보조 검토"·"검토 후보 N건 중 M건"·시스템/모델 언급 금지. 특유한 게 없으면 빈 배열]
}

규칙:
- **계층 구조**: overview_changes·ibk_view·priority_actions 의 각 항목은 문자열, 또는 내용상 상·하위가 분명할 때만 {"text":..,"children":[..]} 로 중첩(children 도 같은 형식, 최대 3단). 번호/기호(가., 1), ① 등)는 절대 직접 붙이지 말 것 — 시스템이 자동 부여한다. 억지로 중첩하지 말고 단순하면 문자열로.
- articles 는 위 [index] 전체(0..${relevant.length - 1})를 포함.
- comparison 은 반드시 주어진 '조문 원문'을 근거로, **주어진 '반영여부(확정)' 라벨과 일치하는 결론**으로 쓴다(원문을 인용해 그 라벨의 근거를 제시). 라벨과 모순되는 단정 금지 — 반영여부=미반영인데 "이미 반영/일치함"으로 끝내지 말 것(이 경우 "원칙·일반 조항은 있으나 이번 변경이 요구하는 구체 의무는 미반영"처럼 미반영 근거를 쓴다). 반영여부=반영됨/개정 불요이면 "원문에 이미 …가 규정되어 있어 부합"으로 쓴다.
- **권고 일관성(반영여부 종속)**: recommendation 은 반드시 반영여부(확정)에 맞춘다 — 반영됨/개정 불요 → "현행 유지"(개정·보완 권고 금지, 불요 사유 명시); 일부 반영 → "보완"; 미반영 → "개정·신설". 반영여부와 어긋나는 권고(예: 미반영인데 "현행 유지", 개정 불요인데 "개정") 절대 금지.
- **권고 표현(매우 중요)**: ${
    framing === "monitoring"
      ? `본 문서는 **정보성 자료(보도자료·해설서·FAQ·법령해석·비조치 등)**다: 법령 개정이 아니므로 "개정하라/미반영"으로 단정하지 말 것. recommendation 은 "동향 모니터링·사전 검토" 중심, priority_actions 는 비워둔다. 단, 중요한 정책 방향 신호는 ibk_view 에 살린다.
    ❌ 모든 필드에서 금지 표현(절대 쓰지 말 것): "확정 시", "확정되면", "개정될 경우", "개정 시" — 정보성 자료엔 부적합(대신 "필요 시·동향에 따라").`
      : framing === "conditional"
        ? `본 문서는 **확정 전(미발효 입법예고·법률안·사전예고)**이다: recommendation/priority_actions 는 "확정 시·개정될 경우" 같은 조건부 표현으로 단정을 피한다.`
        : `본 문서는 **이미 시행·통용 중 또는 자율준수 연성규범(즉시 점검 대상)**이다: recommendation 은 "즉시·조속·선제 점검" 등 확정적으로 쓴다(입법 확정을 기다리는 단계가 아님).
    ⚠️ 본문에 '(안)'·'개정안'·초안 표제 같은 흔적이 남아 있어도(과거 제정·개정 당시 원안이 그대로 보존된 경우 등), 문서유형·시행일 기준 **이미 발효된 문서**이므로 조건부 표현을 쓰지 말 것.
    ❌ 모든 필드에서 금지 표현(절대 쓰지 말 것): "확정 시", "확정되면", "(법률안/가이드라인 등) 확정·개정될 경우" — 부적합. (IBK 자체 내규를 고친다는 의미의 "내규 개정 시"는 허용)`
  }`;
}

/**
 * framing이 '확정 전(conditional)'이 아닌데 LLM 권고에 남은 **선행 조건부 부사구**
 *  ('확정 시'·'확정되면'·'개정될 경우')를 제거한다 — §4 '이미 시행' 프레이밍과의 상충 방지.
 *  프롬프트로 1차 억제하되, 본문에 초안표기('(안)' 등)가 남은 기제정 문서에서 LLM이 본문에
 *  끌려 조건부를 남기는 경우의 결정적 안전망. '내규 개정 시' 등 정당한 표현은 건드리지 않는다
 *  (바른 부사구만, 어절 경계로 한정 — '확정 시점'·'개정 시' 등은 불간섭).
 */
function stripLeadConditional(text: string): string {
  return text
    .replace(/(^|[.,)\s])확정\s*시(?=\s)\s*/g, "$1")
    .replace(/(^|[.,)\s])확정\s*(?:·\s*시행)?되면\s*/g, "$1")
    .replace(/(^|[.,)\s])개정\s*(?:·\s*시행)?될\s*경우\s*/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 권고 ↔ 반영여부 정합 백스톱(결정적) — 사용자에게 보이는 '반영여부'(judge 라벨)와 '권고'가
 *  어긋나는 상충을 제거한다(프롬프트로 1차 정합화하되 LLM이 흘리면 여기서 강제).
 *   · 반영됨/개정 불요(무조치)인데 권고가 개정·보완 → '현행 유지'
 *   · 미반영/일부 반영(조치 필요)인데 권고가 현행 유지/공란/진단문 누출 → 결정적 조치 라벨
 *  reflection을 뒤집지는 않는다(어느 LLM이 옳은지 본문만으론 단정 불가 — 라벨은 judge가 단일 기준).
 */
function reconcileRecommendation(reflection: string, rec: string | undefined): string {
  const r = (rec || "").trim();
  const recHold = !r || /현행\s*유지/.test(r);
  const recAction = /(개정|보완|신설|강화|수립|마련|추가|반영하여|도입)/.test(r);
  // 권고 슬롯에 액션 라벨이 아니라 '~하고 있으나 ~필요함'·'~와 연관됨' 류 진단·사유 문장이 누출된 경우 감지
  //  (변경비교 성격 텍스트가 권고 칸에 잘못 채워짐 → 8열 표 라벨 정렬 붕괴). 종결 마침표/서술형 어미가 신호.
  const looksLikeAssessment =
    /(하고\s*있으나|되어\s*있으나|규정하고\s*있|명시하고\s*있|포함하고\s*있|반영하고\s*있|연관됨|밀접|판단됨|사료됨|확인됨)/.test(r) ||
    (r.length > 40 && /(필요함|있음|없음|됨)\.?$/.test(r));
  if ((reflection === "반영됨" || reflection === "개정 불요") && recAction && !recHold) {
    return "현행 유지";
  }
  if ((reflection === "미반영" || reflection === "일부 반영") && (recHold || looksLikeAssessment)) {
    return reflection === "미반영" ? "개정·신설 검토 필요" : "보완 검토 필요";
  }
  return r || "담당 부서 추가 검토 필요";
}

/**
 * 변경비교(report LLM이 조문 원문을 직접 대조) ↔ 반영여부(judge 라벨) 상충 교정.
 *  변경비교가 **순수 긍정**('이미 반영/규정되어 있/충족/일치/부합')인데 라벨이 '미반영·일부 반영'+높음/중간이면,
 *  judge가 원문 반영을 놓친 과대플래그로 보고 '반영됨·낮음'으로 교정한다(2.2 변경비교↔반영여부↔2.3 커버리지 삼자 상충 제거).
 *  ⚠️ 부정·보완 마커('미반영/부족/없음/신설·보완·개정 필요/일부')가 하나라도 있으면 교정 안 함(예: "원칙은 반영됐으나 구체
 *   의무는 미반영"은 진짜 미반영 — 오교정 방지). 리스크 축은 독립이라 건드리지 않음.
 */
function reconcileReflectionWithComparison(
  v: JudgedMatch["verdict"],
  comparison: string | undefined,
  infoOnly?: boolean
): JudgedMatch["verdict"] {
  if (infoOnly || !comparison) return v;
  if ((v.reflection !== "미반영" && v.reflection !== "일부 반영") || (v.impact !== "높음" && v.impact !== "중간")) return v;
  const affirm = /(반영됨|이미\s*(반영|규정|정의|포함|마련)|규정되어\s*있|정의되어\s*있|명시되어\s*있|포함되어\s*있|충족(함|하)|일치(함|하)|부합(함|하))/.test(comparison);
  const negate = /(미반영|반영되지|반영\s*안|포함되지\s*않|규정되어\s*있지\s*않|부족|미흡|미비|없음|결여|누락|신설\s*필요|보완\s*필요|개정\s*필요|일부)/.test(comparison);
  if (affirm && !negate) {
    return { ...v, reflection: "반영됨", impact: "낮음", compliance_need: "불요" };
  }
  return v;
}

// ── 본문 결정적 조립 ───────────────────────────────────
function assembleBody(input: ReportInput, relevant0: JudgedMatch[], llm: LlmReport): string {
  const framing = docFraming(input);
  // 변경비교(원문 직접 대조) 순수 긍정 ↔ judge '미반영' 라벨 상충을 먼저 교정한 뒤 이후 렌더·정합에 사용.
  const cmpByIndex = new Map<number, string>();
  for (const a of llm.articles ?? []) if (typeof a.index === "number") cmpByIndex.set(a.index, a.comparison ?? "");
  const relevant = relevant0.map((j, i) => {
    const v = reconcileReflectionWithComparison(j.verdict, cmpByIndex.get(i), input.infoOnly);
    return v === j.verdict ? j : { ...j, verdict: v };
  });
  const reflByIndex = new Map<number, string>();
  relevant.forEach((j, i) => reflByIndex.set(i, reflectionOf(j, input.infoOnly)));
  const byIndex = new Map<number, ArticleAnalysis>();
  for (const a of llm.articles ?? []) {
    if (typeof a.index !== "number") continue;
    let rec = a.recommendation;
    // 이미 시행/정보성 문서엔 조건부 권고가 §4 프레이밍과 상충 → 선행 조건부 부사구만 정리.
    if (rec && framing !== "conditional") rec = stripLeadConditional(rec);
    // 권고 ↔ 반영여부 정합 강제(상충 제거). 정보성('모니터링 대상')은 대상 라벨이 아니라 무영향.
    const refl = reflByIndex.get(a.index);
    if (refl) rec = reconcileRecommendation(refl, rec);
    byIndex.set(a.index, rec === a.recommendation ? a : { ...a, recommendation: rec });
  }

  // 1. 규제변동 개요
  const changes = (llm.overview_changes ?? []).filter(Boolean);
  const ibkView = (llm.ibk_view ?? []).filter(Boolean);
  const stageNote = input.infoOnly
    ? `\n> 정보성 자료(보도자료·설명자료·해설서·FAQ 등) — 규범적 개정 사항 아님. 관련 내규는 **동향 모니터링** 관점으로 정리(개정 단정 아님).`
    : input.preAnnouncement
      ? `\n> **사전예고(확정 전) 연성규범** — 아직 확정·시행 전이므로 권고는 조건부(확정 시 재검토 전제). 다만 방향이 명확하므로 미충족 영역은 선제 검토 권장.`
      : input.itemType === "guideline"
        ? `\n> 자율규제(가이드라인·모범규준·행정지도) — 사실상 준수 대상인 연성규범. '입법 확정'을 기다리는 단계가 아니라 **즉시 내규 정합성 점검 대상**(자율 준수). 미충족 영역은 신규·보완 내규로 선제 대응 권장.`
        : isPendingDoc(input)
          ? `\n> ${llm.doc_stage || "확정 전"} 단계 문서 — 권고는 입법·개정 확정 시 재검토 전제(조건부).`
          : "";
  const sec1 = `## 1. 규제변동 개요
### 1.1 주요 변경 사항
${outline(changes, "- 변경 사항 식별 정보 부족")}
### 1.2 IBK 적용 관점
${outline(ibkView, "- 적용 관점 정보 부족")}${stageNote}`;

  // 요건 커버리지(권고2) — 의무별 충족/부분/부재 체크리스트
  const coverage = (input.coverage ?? []).filter((g) => g && g.requirement);
  const absentGaps = coverage.filter((g) => g.coverage === "부재");
  const partialGaps = coverage.filter((g) => g.coverage === "부분");
  const metCount = coverage.filter((g) => g.coverage === "충족").length;
  const naCount = coverage.filter((g) => g.coverage === "해당없음").length;
  const gaps = [...absentGaps, ...partialGaps];

  // 영향 요약 집계(이름 나열은 아래 표와 중복이므로 카운트 한 줄로). 갭은 '내규 부재'라 별도 표기.
  const cnt = (lv: "높음" | "중간" | "낮음") => relevant.filter((j) => j.verdict.impact === lv).length;
  const covNote = coverage.length
    ? `\n- 요건 커버리지 **${coverage.length}건** — 충족 ${metCount} · 보완(부분) ${partialGaps.length} · **신규 필요(부재) ${absentGaps.length}**${naCount ? ` · 해당없음(비영위) ${naCount}` : ""} (부재=영향도 높음으로 반영)`
    : "";
  const countLine = relevant.length || coverage.length
    ? `- 영향 내규(기존 조문 매칭) **${relevant.length}건** — 높음 ${cnt("높음")} · 중간 ${cnt("중간")} · 낮음 ${cnt("낮음")}${covNote}`
    : "- 영향 내규 없음";

  // 2.2 조치 필요 조문(높음·중간)만 원문 포함 상세 — 가독성 위해 낮음/현행유지·정보성은 제외(3.1 표로).
  const actionPairs = input.infoOnly
    ? []
    : relevant
        .map((j, i) => ({ j, a: byIndex.get(i) }))
        .filter(({ j }) => j.verdict.impact === "높음" || j.verdict.impact === "중간");

  const details = actionPairs.length
    ? actionPairs
        .map(({ j, a }, n) => {
          const kind = inferRegulationKind(j);
          const itemName = formatRegulationItemName(j);
          const isAttachment = kind === "별표" || kind === "별지서식";
          const origin = isAttachment
            ? `${kind} 요약: ${cleanText(j.regulation_content, 280)}`
            : cleanText(j.regulation_content, 1600);
          const quoted = origin
            .split("\n")
            .map((l) => `  > ${l}`)
            .join("\n");
          return `#### 2.2.${n + 1} ${j.regulation_name} ${itemName} · 영향도 ${j.verdict.impact} · 리스크 ${j.verdict.degraded ? "미산정" : j.verdict.risk_level ?? "중간"}
- 가. **현재 내규 원문**${isAttachment ? "(요약)" : ""}
${quoted}
- 나. **변경 비교**: ${a?.comparison || "원문과 직접 비교 정보 부족"}
- 다. **반영 여부**: ${reflectionOf(j, input.infoOnly)}
- 라. **권고**: ${a?.recommendation || "담당 부서 추가 검토 필요"}`;
        })
        .join("\n\n")
    : input.infoOnly
      ? "- 정보성 자료 — 개정·검토가 필요한 조문 없음(위 2.1 표는 동향 모니터링 대상)."
      : absentGaps.length || partialGaps.length
        ? "- 기존 조문 단위로 매칭된 개정 대상은 없음. **아래 2.3 요건 커버리지 체크리스트의 신규·보완 필요 항목** 참조(신규 내규 수립이 핵심 조치)."
        : "- 개정·검토(높음·중간)가 필요한 조문 없음(위 2.1 표의 현행 유지 항목 참조).";

  // 조치 요약표(결정적 조립) — 상세보다 먼저 오는 '한눈에 보기' 표
  const rows = relevant
    .map((j, i) => {
      const a = byIndex.get(i);
      const recFull = (a?.recommendation || "추가 검토").replace(/\s+/g, " ").replace(/\|/g, "／").trim();
      // 표 셀은 word-break:keep-all로 깔끔히 줄바꿈됨 → 과한 절단 대신 넉넉히, 초과 시에만 말줄임
      const rec = recFull.length > 130 ? recFull.slice(0, 129) + "…" : recFull;
      const gistFull = (a?.gist || "").replace(/\s+/g, " ").replace(/\|/g, "／").trim();
      const gist = gistFull ? (gistFull.length > 44 ? gistFull.slice(0, 43) + "…" : gistFull) : "—";
      const risk = j.verdict.degraded ? "미산정" : j.verdict.risk_level ?? "중간";
      return `| ${i + 1} | ${shortRegName(j.regulation_name)} | ${formatRegulationItemName(j)} | ${gist} | ${j.verdict.impact} | ${risk} | ${reflectionOf(j, input.infoOnly)} | ${rec} |`;
    })
    .join("\n");
  const summaryTable = relevant.length
    ? `| 순번 | 내규명 | 조문명 | 조문 요지 | 영향도 | 리스크 | 반영 여부 | 권고 조치 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows}`
    : "- 영향 내규 없음";

  // 2.3 요건 커버리지 체크리스트 — 원천문서가 요구하는 의무 전체 × 충족/부분/부재 + 대응 내규
  //   (조문 1:1 매칭으로는 드러나지 않는 '없는 내규'를 부재=높음으로 표면화)
  const covMark: Record<string, string> = { 충족: "✅ 충족", 부분: "⚠️ 부분", 부재: "❌ 부재", 해당없음: "➖ 해당없음" };
  const covRows = coverage
    .map((g, i) => {
      const rec = (g.recommendation || "검토").replace(/\s+/g, " ").replace(/\|/g, "／").trim();
      const ev = (g.evidence || (g.coverage === "부재" ? "대응 내규 미확인" : g.coverage === "해당없음" ? "IBK 비영위 업무" : "현행 내규")).replace(/\s+/g, " ").replace(/\|/g, "／").trim();
      // 대응 내규/근거 = "내규명 / 근거설명" 2부 구조라 내규명만으로 50자 이상 → 60자 캡은 근거를 통째로 잘랐음.
      //  220자로 완화(LLM evidence는 통상 80~150자라 사실상 전량 노출, 병적 길이만 방어).
      return `| ${i + 1} | ${g.requirement.replace(/\|/g, "／")} | ${covMark[g.coverage] ?? g.coverage} | ${g.impact} | ${ev.length > 220 ? ev.slice(0, 219) + "…" : ev} | ${rec.length > 160 ? rec.slice(0, 159) + "…" : rec} |`;
    })
    .join("\n");
  const sec23 = coverage.length
    ? `### 2.3 요건 커버리지 체크리스트 (이 문서가 요구하는 의무 ${coverage.length}건)
> 원천문서가 요구하는 의무·권고를 항목화해 IBK 내규의 **충족 / 부분 / 부재**를 점검한 것. 조문 1:1 매칭으로는 드러나지 않는 누락으로, **부재 = 신규 내규 수립 필요(높음)**, 부분 = 보완(중간).

| 순번 | 요구 의무·권고 | 충족도 | 영향도 | 대응 내규/근거 | 권고 조치 |
| --- | --- | --- | --- | --- | --- |
${covRows}`
    : "";

  // 판정 실패(degraded) 조문 고지 — 리스크 '미산정' 표기와 함께 사용자에게 한계를 정직 안내.
  const degradedCount = relevant.filter((j) => j.verdict.degraded).length;
  const degradedNote = degradedCount
    ? `\n> ⚠️ 이 중 ${degradedCount}건은 자동 정합성 판정이 일시적으로 수행되지 못해 검색 기반 잠정 추정치로 표시되었습니다(리스크 미산정). 해당 조문은 원문을 직접 확인해 주세요.`
    : "";

  // 2. 내규 정합성 분석 — 2.1 영향 요약(집계 + 조치 요약표) → 2.2 조문별 상세 → 2.3 커버리지 갭
  const sec2 = [
    `## 2. 내규 정합성 분석
### 2.1 영향 요약
${countLine}${degradedNote}

${summaryTable}
### 2.2 조치 필요 조문
${details}`,
    sec23,
  ]
    .filter(Boolean)
    .join("\n\n");

  const highItems = relevant.filter((j) => j.verdict.impact === "높음");
  const llmPriority = (llm.priority_actions ?? []).filter(Boolean);
  // 우선조치: LLM이 뽑은 높음 항목 + 커버리지 부재 갭(신규 내규 필요)을 합산
  const gapPriority: OutlineItem[] = absentGaps.map((g) => ({
    text: `${g.requirement} — 대응 내규 부재, 신규 수립 필요`,
    children: g.recommendation ? [g.recommendation] : [],
  }));
  // 우선조치 dedup — 합성 액션(LLM)과 커버리지 부재 항목이 동일 의무를 가리키면 한 번만 노출
  //  (예: '…매뉴얼 작성 및 게시 의무화'(합성) vs '…매뉴얼 작성 및 게시 — 부재'(갭)). 정규화 키 선두 일치로 판별.
  const priKey = (it: OutlineItem): string => {
    const t = typeof it === "string" ? it : it?.text ?? "";
    return t.replace(/[\s·,.()\-—:]/g, "").slice(0, 12);
  };
  const seenPri = new Set<string>();
  const priorityItems = [...llmPriority, ...gapPriority].filter((it) => {
    const k = priKey(it);
    if (!k) return true;
    if (seenPri.has(k)) return false;
    seenPri.add(k);
    return true;
  });
  const priority = input.infoOnly
    ? "- 해당 없음 (정보성 자료 — 동향 모니터링 대상)"
    : highItems.length === 0 && absentGaps.length === 0
      ? "- 해당 없음 (영향도 '높음' 항목 없음)"
      : outline(priorityItems, "- 영향도 '높음' 항목 우선 조치 검토");
  const sec3 = `## 3. 우선 조치
${priority}`;

  return [sec1, sec2, sec3].join("\n\n");
}

// 개정필요성 → 반영 여부(결정적, 영향도와 일관)
function reflectionOf(j: JudgedMatch, infoOnly = false): string {
  // judge가 정규화한 reflection(반영됨/개정 불요/일부 반영/미반영/해당 없음/모니터링)을 우선 사용
  if (j.verdict.reflection) return j.verdict.reflection;
  if (infoOnly) return "모니터링 대상";
  switch (j.verdict.compliance_need) {
    case "불요":
      return "반영됨";
    case "필요":
      return "미반영";
    default:
      return "일부 반영";
  }
}

// 한국 공문서 계층 마커(깊이별). 섹션 번호(1/1.1/2.2.1)는 코드가 고정하고,
// 그 아래 '항목'만 이 마커로 결정적으로 부여 → 일관성(번호 흔들림 방지) + AI는 '깊이'만 판단.
const OUTLINE_MARKERS: string[][] = [
  ["가.", "나.", "다.", "라.", "마.", "바.", "사.", "아.", "자.", "차.", "카.", "타.", "파.", "하."],
  ["1)", "2)", "3)", "4)", "5)", "6)", "7)", "8)", "9)", "10)", "11)", "12)"],
  ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭"],
  ["가)", "나)", "다)", "라)", "마)", "바)", "사)", "아)", "자)", "차)"],
];

function normOutlineItem(x: OutlineItem): { text: string; children: OutlineItem[] } {
  if (typeof x === "string") return { text: x, children: [] };
  return {
    text: String(x?.text ?? "").trim(),
    children: Array.isArray(x?.children) ? x.children : [],
  };
}

/**
 * 개조식 항목을 한국식 계층(가/나/다 → 1)2)3) → ①②③)으로 렌더.
 * 마크다운 중첩 리스트(`- ` + 마커)로 출력 → 웹(react-markdown)·HWPX 모두 들여쓰기 보존.
 * (웹은 CSS list-style:none 으로 기본 불릿을 숨겨 마커만 보이게 함)
 */
function renderOutline(items: OutlineItem[], depth = 0): string {
  const marks = OUTLINE_MARKERS[Math.min(depth, OUTLINE_MARKERS.length - 1)];
  const indent = "    ".repeat(depth);
  const lines: string[] = [];
  let i = 0;
  for (const raw of items ?? []) {
    const it = normOutlineItem(raw);
    // LLM이 이미 붙였을 수 있는 마커/불릿 제거(이중 마커 방지).
    //  ⚠️ 불릿은 'dash/별 + 공백'일 때만 제거 — '**볼드**'의 첫 * 를 먹지 않도록.
    const text = it.text
      .replace(/^[-*]\s+/, "")
      .replace(/^([가-힣]\.|[가-힣]\)|\(\d+\)|\d+\)|[①-⑳])\s+/, "")
      .trim();
    if (!text) continue;
    lines.push(`${indent}- ${marks[i % marks.length]} ${text}`);
    if (it.children.length) {
      const sub = renderOutline(it.children, depth + 1);
      if (sub) lines.push(sub);
    }
    i++;
  }
  return lines.join("\n");
}

/** renderOutline + 빈 경우 폴백 */
function outline(items: OutlineItem[], fallback: string): string {
  const s = renderOutline((items ?? []).filter((x) => normOutlineItem(x).text));
  return s || fallback;
}

function shortRegName(name: string): string {
  return normalizeWhitespace(name);
}

/** 한 줄로 평탄화 + 공백 정리 + 길이 제한 (신구조문/개정개요 인라인용) */
function cleanInline(s: string | undefined, max: number): string {
  const t = normalizeWhitespace(s);
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** analyze의 change_overview/provision_changes 객체(키 제각각)를 사람이 읽는 한 줄로 평탄화 */
function objToLine(o: unknown): string {
  if (o == null) return "";
  if (typeof o === "string") return cleanInline(o, 220);
  if (typeof o !== "object") return String(o);
  const vals = Object.values(o as Record<string, unknown>)
    .map((v) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : ""))
    .filter(Boolean);
  return cleanInline(vals.join(" — "), 220);
}

/** 조문 원문 정리 — 줄바꿈/공백 정돈, 길이 제한 */
function cleanText(content: string | undefined, max: number): string {
  const s = (content ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!s) return "-";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── 4번 섹션 — 문서 맥락에서 '진짜' 유의사항 도출(없으면 섹션 자체 생략) ─────────
//  형식적 문구(AI 보조 검토, N건 중 M건, 시스템 언급)는 넣지 않는다. 사용자 친화적·비개발자 말투.
function buildCaveats(input: ReportInput, llmCaveats: OutlineItem[]): string {
  const items: OutlineItem[] = [];
  const coverage = input.coverage ?? [];
  const absentN = coverage.filter((c) => c.coverage === "부재").length;
  const partialN = coverage.filter((c) => c.coverage === "부분").length;

  // 1) 문서 성격에 따른 진짜 주의점 — 본문 프레이밍(docFraming)과 동일 신호 사용(상충 방지).
  //    이전: itemType=bill/policy에 무조건 '확정 전 단계' 문구 → 시행중 개정전문·준칙·시행세칙에 오노출(헤더 '이미 시행'과 모순).
  const fr = docFraming(input);
  if (fr === "monitoring") {
    items.push("이 문서는 보도자료·설명자료 등 정보성 자료입니다. 법령 개정이 확정된 것이 아니므로, 지금 바로 내규를 바꾸기보다 앞으로의 진행 상황을 지켜보는 것이 좋습니다.");
  } else if (fr === "conditional") {
    items.push("아직 입법·개정이 확정되기 전 단계의 문서입니다. 심의·입법예고 과정에서 내용이 바뀔 수 있으니, 확정되는 시점에 한 번 더 확인하시길 권합니다.");
  } else if (input.itemType === "guideline") {
    items.push("자율규제(가이드라인·모범규준·행정지도)로 법으로 강제되는 사항은 아니지만, 감독기관 점검과 평판 관리 측면에서 미리 반영해 두는 것이 바람직합니다.");
  } else {
    // '공포된 규정의 (개정) 전문'으로 특정하면 협회 표준안·표준계약서 등(공포 규정이 아닌 확정 배포 문서)에
    //  허위가 됨 → '시행 중이거나 확정·배포된 문서'로 일반화(시행세칙·규정·표준안·표준계약서 모두 참).
    items.push("이미 시행 중이거나 확정·배포된 문서입니다. 본문 내용은 확정된 사항이므로 현행 내규와의 정합성을 지금 점검하시는 것이 좋습니다.");
  }

  // 2) 커버리지 갭에서 나오는 실무 주의점
  if (absentN > 0) {
    items.push(`대응하는 내규가 아직 없는 항목이 ${absentN}건 있습니다. 이는 새 규정·지침을 만들어야 하는 사안이므로, 소관 부서와 담당·일정을 협의해 추진하시길 권합니다.`);
  }
  if (partialN > 0) {
    items.push(`일부만 반영된 항목(${partialN}건)은 기존 내규의 문구를 보완하는 선에서 해결될 수 있으니, 현행 규정을 먼저 확인해 보시면 좋습니다.`);
  }

  // 3) 분석 범위 한계(원문 절단)
  if (input.truncated) {
    items.push("원문이 길어 분석에 일부만 반영되었습니다. 중요한 세부 조항은 원문 전체로 다시 한 번 확인해 주세요.");
  }

  // 4) 개정안·시행령의 수치/시행일 주의(해당 유형만)
  if (!input.infoOnly && (input.itemType === "bill" || input.itemType === "policy")) {
    items.push("금액 기준·시행일 같은 구체적인 수치는 반드시 원문을 기준으로 다시 확인해 주세요.");
  }

  // 5) 문서 특유의 LLM 도출 유의점(형식문구 제거)
  for (const c of llmCaveats) {
    const t = normOutlineItem(c).text;
    if (t && !/AI\s*보조|검토\s*후보|시스템|모델|벡터|임베딩|\d+\s*건\s*중/.test(t)) items.push(c);
  }

  const body = outline(items, "");
  return body ? `## 4. 검토 유의사항\n${body}` : "";
}

function noMatchBody(input: ReportInput): string {
  const change = input.analysis?.core_summary || "업로드 문서에서 IBK 내규와 직접 연결되는 변경 사항 미식별.";
  return `## 1. 규제변동 개요
### 1.1 주요 변경 사항
${outline([change], "- 변경 사항 미식별")}

### 1.2 IBK 적용 관점
${outline(["이번 규제변동과 직접 정합성 검토가 필요한 IBK 사내규정 미확인."], "- 적용 관점 없음")}

## 2. 내규 정합성 분석
### 2.1 영향 요약
${outline(["업로드 문서와 후보 내규 비교 결과, 실질적 정합성 검토가 필요한 IBK 사내규정 미식별."], "- 영향 내규 없음")}

## 3. 조치 요약 및 권고
| 순번 | 내규명 | 조문명 | 조문 요지 | 영향도 | 리스크 | 반영 여부 | 권고 조치 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| - | - | - | - | 해당없음 | 해당없음 | 불요 | 추가 조치 불필요 |`;
}

function formatKstDate(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
