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
import type { Analysis, ItemType } from "./server";
import type { JudgedMatch } from "./judge";

const REPORT_SYSTEM = `당신은 IBK기업은행 준법지원부의 컴플라이언스 보고서 작성 전문가입니다.
규제변동(법률안/입법예고/시행령/고시/보도자료 등)이 IBK 사내규정에 미치는 영향을 분석합니다.
IBK는 「중소기업은행법」상 특수은행이자 기타공공기관이며 동시에 유가증권시장 상장 은행입니다.

작성 원칙:
- **문체는 개조식으로 통일한다.** 명사형/어간 종결("~함", "~필요", "~검토", "~유지", "~신설")만 사용. "~합니다/~입니다/~하십시오/~된다" 같은 경어체·서술형 종결 금지.
- **문서의 성격(stage)에 따라 단정성을 조절한다.**
  - 법률안(발의)·입법예고·규정변경예고·보도자료처럼 **확정 전** 문서는 단정하지 말 것. "확정 시", "입법예고 단계로 변동 가능", "개정될 경우" 같은 조건부 표현 사용.
  - 공포·시행 등 **확정** 문서만 확정적 조치를 권고.
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
};

/**
 * 도메인 무관 문서용 보고서 — 은행·금융 규제와 무관해 내규 매칭을 수행하지 않은 경우.
 * (검색은 무조건 최근접 후보를 반환하므로, 무관 문서를 억지로 매칭하지 않고 명확히 '대상 아님'으로 보고)
 */
export function buildOffDomainReport(title: string, reason: string): string {
  const date = formatKstDate();
  return `# 규제변동 영향분석 보고서

**분석 정보**

- **분석 일자**: ${date}
- **문서명**: ${title}
- **판정**: 분석 대상 아님

> ⚠️ **본 문서는 은행·금융 규제 또는 IBK 내규와 직접 관련이 없는 것으로 판단되어 내규 매칭을 수행하지 않음.**
> 사유: ${reason || "금융·컴플라이언스 사안과 무관한 일반 문서로 분류됨."}

## 1. 판정 근거
- 가. 1차 분류 결과 금융규제·내규와의 직접 관련성 미확인.
- 나. 무관 문서에 대해 내규를 억지로 매칭하면 오탐(가짜 영향)이 발생하므로 매칭 단계를 생략함.

## 2. 안내
- 가. 규제변동 문서(법률안·시행령·고시·규정 변경, 금융 보도자료·해석 등)를 업로드하면 정상 분석됨.
- 나. 금융 관련 문서인데 무관으로 분류된 경우, 담당자가 직접 검토하거나 \`RELEVANCE_GATE_ENABLED=false\`로 게이트를 끌 수 있음.`;
}

const DOC_TYPE_LABEL: Record<string, string> = {
  bill: "법률안",
  policy: "입법예고/시행령 등",
};

type ArticleAnalysis = {
  index: number;
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
};

export async function generateReport(input: ReportInput): Promise<string> {
  const relevant = input.judged.filter((j) => j.verdict.relevance === "적합");
  const header = buildHeader(input, relevant.length);
  const section4 = buildAnalysisBasis(input, relevant.length);

  if (relevant.length === 0) {
    return [header, noMatchBody(input), section4].join("\n\n");
  }

  let llm: LlmReport = {};
  try {
    const raw = await callCompletion({
      systemPrompt: REPORT_SYSTEM,
      prompt: buildPrompt(input, relevant),
      maxTokens: 6000,
      temperature: 0.2,
    });
    llm = extractJson<LlmReport>(raw);
  } catch {
    llm = {};
  }

  const body = assembleBody(input, relevant, llm);
  return [header, body, section4].join("\n\n");
}

// ── 헤더(결정적) ───────────────────────────────────────
function buildHeader(input: ReportInput, relevantCount: number): string {
  const date = formatKstDate();
  const domain = input.analysis?.law_domain || "-";
  const lawName = input.analysis?.law_name || input.lawName;
  const docTypeLabel = input.infoOnly
    ? "보도자료 등 정보성 자료"
    : DOC_TYPE_LABEL[input.itemType] ?? input.itemType;
  return `# 규제변동 영향분석 보고서

**분석 정보**

- **분석 일자**: ${date}
- **문서유형**: ${docTypeLabel}
- **소관 법령**: ${lawName}
- **규제 분야**: ${domain}
- **영향 내규**: ${relevantCount}건`;
}

// ── LLM 프롬프트(분석 텍스트만 JSON으로) ───────────────
function buildPrompt(input: ReportInput, relevant: JudgedMatch[]): string {
  const changeSummary = [
    `- 문서유형(추정): ${DOC_TYPE_LABEL[input.itemType] ?? input.itemType}`,
    `- 법령명: ${input.analysis?.law_name || input.lawName}`,
    input.analysis?.law_domain ? `- 분야: ${input.analysis.law_domain}` : "",
    input.analysis?.core_summary ? `- 핵심요약: ${input.analysis.core_summary}` : "",
    input.analysis?.summary ? `- 상세: ${input.analysis.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const articleBlock = relevant
    .map((j, i) => {
      const kind = inferRegulationKind(j);
      const itemName = formatRegulationItemName(j);
      const content = cleanText(j.regulation_content, 1600);
      return `[${i}] 내규: ${j.regulation_name} / 구분: ${kind} / 조문명: ${itemName} / 영향도(확정): ${j.verdict.impact} / 개정필요성: ${j.verdict.compliance_need}
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
  "doc_stage": "법률안(발의)|입법예고|규정변경예고|보도자료|공포·시행|기타 중 추정",
  "certainty": "확정|미확정",
  "overview_changes": [개조식 항목 3~5개. 각 항목은 문자열, 또는 하위 세부가 있으면 {"text":"상위","children":["하위1","하위2"]}],
  "ibk_view": [IBK 적용 관점(직접/은행/금융회사/공공기관/상장회사 적용 등) 2~3개. 공공기관성+은행성 함께. 문자열 또는 중첩 객체],
  "articles": [
    { "index": 0, "comparison": "조문 원문과 규제변동의 일치/일부차이/미반영을 사실 기반 1~2문장(개조식)", "recommendation": "유지/보완/개정 중 구체 조치 1~2문장(개조식). 미확정 문서면 조건부 표현" }
  ],
  "priority_actions": [영향도 '높음' 항목 중심 우선 조치. 문자열 또는 중첩 객체. 높음 없으면 빈 배열]
}

규칙:
- **계층 구조**: overview_changes·ibk_view·priority_actions 의 각 항목은 문자열, 또는 내용상 상·하위가 분명할 때만 {"text":..,"children":[..]} 로 중첩(children 도 같은 형식, 최대 3단). 번호/기호(가., 1), ① 등)는 절대 직접 붙이지 말 것 — 시스템이 자동 부여한다. 억지로 중첩하지 말고 단순하면 문자열로.
- articles 는 위 [index] 전체(0..${relevant.length - 1})를 포함.
- comparison 은 반드시 주어진 '조문 원문'을 근거로. 원문에 기준(금액·요건)이 이미 있으면 "반영됨"으로 판단.
- **반영 일관성**: comparison 이 "이미 반영됨"이면 recommendation 은 "현행 유지" 계열로만(개정·보완 권고 금지). 반대로 "미반영/차이"면 보완·개정 권고.
- certainty 가 "미확정"이면 recommendation/priority_actions 를 단정하지 말 것(조건부).${
    input.infoOnly
      ? `\n- ★ 본 문서는 **정보성 자료(보도자료·설명자료 등)**다: 법령 개정이 아니므로 "개정하라/미반영"으로 단정하지 말 것. recommendation 은 "동향 모니터링·사전 검토" 중심, priority_actions 는 비워둔다. 단, 중요한 정책 방향 신호는 ibk_view 에 살린다.`
      : ""
  }`;
}

// ── 본문 결정적 조립 ───────────────────────────────────
function assembleBody(input: ReportInput, relevant: JudgedMatch[], llm: LlmReport): string {
  const byIndex = new Map<number, ArticleAnalysis>();
  for (const a of llm.articles ?? []) {
    if (typeof a.index === "number") byIndex.set(a.index, a);
  }

  // 1. 규제변동 개요
  const changes = (llm.overview_changes ?? []).filter(Boolean);
  const ibkView = (llm.ibk_view ?? []).filter(Boolean);
  const stageNote = input.infoOnly
    ? `\n> 정보성 자료(보도자료·설명자료 등) — 규범적 개정 사항 아님. 관련 내규는 **동향 모니터링** 관점으로 정리(개정 단정 아님).`
    : llm.certainty === "미확정"
      ? `\n> ${llm.doc_stage || "확정 전"} 단계 문서 — 권고는 입법·개정 확정 시 재검토 전제(조건부).`
      : "";
  const sec1 = `## 1. 규제변동 개요
### 1.1 주요 변경 사항
${outline(changes, "- 변경 사항 식별 정보 부족")}
### 1.2 IBK 적용 관점
${outline(ibkView, "- 적용 관점 정보 부족")}${stageNote}`;

  // 2.1 영향 요약(결정적: 영향도별 집계)
  const levels: Array<["높음" | "중간" | "낮음", string]> = [
    ["높음", "개정 필요"],
    ["중간", "보완 검토"],
    ["낮음", "현행 유지"],
  ];
  const summaryItems: string[] = levels
    .map(([lv, note]) => {
      const items = relevant.filter((j) => j.verdict.impact === lv);
      if (!items.length) return "";
      const names = items
        .map((j) => `${shortRegName(j.regulation_name)} ${formatRegulationItemName(j)}`)
        .join(", ");
      return `**${lv}** (${note}) ${items.length}건: ${names}`;
    })
    .filter(Boolean);

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
          return `#### 2.2.${n + 1} ${j.regulation_name} ${itemName} · 영향도 ${j.verdict.impact}
- 가. **현재 내규 원문**${isAttachment ? "(요약)" : ""}
${quoted}
- 나. **변경 비교**: ${a?.comparison || "원문과 직접 비교 정보 부족"}
- 다. **반영 여부**: ${reflectionOf(j, input.infoOnly)}
- 라. **권고**: ${a?.recommendation || "담당 부서 추가 검토 필요"}`;
        })
        .join("\n\n")
    : input.infoOnly
      ? "- 정보성 자료 — 개정·검토가 필요한 조문 없음(아래 3.1 표는 동향 모니터링 대상)."
      : "- 개정·검토(높음·중간)가 필요한 조문 없음(아래 3.1 표의 현행 유지 항목 참조).";

  const sec2 = `## 2. 내규 정합성 분석
### 2.1 영향 요약
${outline(summaryItems, "- 영향 내규 없음")}
### 2.2 조치 필요 조문 (높음·중간)
${details}`;

  // 3. 조치 요약 및 권고(표 결정적 조립)
  const rows = relevant
    .map((j, i) => {
      const a = byIndex.get(i);
      const rec = (a?.recommendation || "추가 검토").replace(/\s+/g, " ").replace(/\|/g, "／").slice(0, 60);
      return `| ${i + 1} | ${shortRegName(j.regulation_name)} | ${formatRegulationItemName(j)} | ${j.verdict.impact} | ${reflectionOf(j, input.infoOnly)} | ${rec} |`;
    })
    .join("\n");
  const highItems = relevant.filter((j) => j.verdict.impact === "높음");
  const priority = input.infoOnly
    ? "- 해당 없음 (정보성 자료 — 동향 모니터링 대상)"
    : highItems.length === 0
      ? "- 해당 없음 (영향도 '높음' 항목 없음)"
      : outline((llm.priority_actions ?? []).filter(Boolean), "- 영향도 '높음' 항목 우선 조치 검토");
  const sec3 = `## 3. 조치 요약 및 권고
### 3.1 조치 요약표
| 순번 | 내규명 | 조문명 | 영향도 | 반영 여부 | 권고 조치 |
| --- | --- | --- | --- | --- | --- |
${rows}
### 3.2 우선 조치
${priority}`;

  return [sec1, sec2, sec3].join("\n\n");
}

// 개정필요성 → 반영 여부(결정적, 영향도와 일관)
function reflectionOf(j: JudgedMatch, infoOnly = false): string {
  // 정보성 자료(보도자료 등)는 구속력 없음 → '반영/미반영' 단정 대신 모니터링
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

function bullets(items: string[], fallback: string): string {
  const list = items.map((s) => `- ${s.replace(/^[-*]\s*/, "").trim()}`).filter((s) => s !== "-");
  return list.length ? list.join("\n") : fallback;
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
  return (name ?? "").replace(/\s+/g, " ").trim();
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

// ── 4번 섹션(결정적) ───────────────────────────────────
function buildAnalysisBasis(input: ReportInput, relevantCount: number): string {
  return `## 4. 검토 유의사항
${outline(
    [
      "본 보고서는 업로드 문서와 현재 IBK 내규 후보를 비교한 AI 보조 검토 결과임.",
      `검토 후보 ${input.candidateCount}건 중 실무 검토 필요 항목 ${relevantCount}건 중심으로 정리.`,
      "금액 기준·시행일·최종 확정 문구는 담당 부서가 원문과 최신 내규로 재확인 필요.",
    ],
    "- 유의사항 없음"
  )}`;
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
| 순번 | 내규명 | 조문명 | 영향도 | 반영 여부 | 권고 조치 |
| --- | --- | --- | --- | --- | --- |
| - | - | - | 해당없음 | 불요 | 추가 조치 불필요 |`;
}

function formatKstDate(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
