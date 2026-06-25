/**
 * 매칭 적합성·영향도 LLM 판정 단계
 *
 * 하이브리드 검색(BM25+벡터+그래프+리랭커)이 뽑은 후보 내규 조문을,
 * IBK 기관 프로필 + 판정 기준으로 LLM이 최종 판정한다.
 *  - 적합/부적합, 적용근거, 영향도, 내규반영 필요성, 사유
 *
 * core-ai의 stateless 생성 엔드포인트를 쓰므로 서버 DB 적재 없음.
 */
import { callCompletion, extractJson } from "./llm";
import {
  IBK_PROFILE,
  JUDGMENT_CRITERIA,
  type ImpactLevel,
  type BasisType,
  type ComplianceNeed,
} from "./ibk-profile";
import { formatRegulationItemName, inferRegulationKind, makeContentExcerpt } from "./regulation-format";
import { config } from "./config";
import type { Analysis, Candidate, ItemType } from "./server";

export type Verdict = {
  relevance: "적합" | "부적합";
  applicability_basis: BasisType | string;
  impact: ImpactLevel;
  compliance_need: ComplianceNeed | string;
  ibk_specific: boolean;
  reason: string;
};

export type JudgedMatch = Candidate & { verdict: Verdict };

const IMPACT_RANK: Record<string, number> = {
  높음: 0,
  중간: 1,
  낮음: 2,
  해당없음: 3,
};

/** 같은 조문(또는 같은 부칙)이 여러 청크로 중복 검색되는 것을 제거 */
function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of candidates) {
    const kind = inferRegulationKind(c);
    // 부칙은 조문번호가 없어 청크별로 쪼개져 중복되기 쉬움 → 내규명+부칙 단위로 1건만.
    const key =
      kind === "부칙"
        ? `${c.regulation_name}|부칙`
        : `${c.regulation_name}|${kind}|${c.jo ?? ""}|${c.jo_title ?? ""}|${c.byeolpyo ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export async function judgeMatches(args: {
  lawName: string;
  itemType: ItemType;
  analysis?: Analysis;
  candidates: Candidate[];
  maxCandidates?: number;
  infoOnly?: boolean;
}): Promise<JudgedMatch[]> {
  const cands = dedupeCandidates(args.candidates).slice(0, args.maxCandidates ?? config.judgeMax);
  if (cands.length === 0) return [];
  const infoOnly = !!args.infoOnly;

  const changeSummary = buildChangeSummary(args.lawName, args.itemType, args.analysis);

  const candidateBlock = cands
    .map((c, i) => {
      const kind = inferRegulationKind(c);
      const itemName = formatRegulationItemName(c);
      // ⚠️ 판정이 "반영 여부"를 정확히 보려면 조문 전문이 필요하다(요약하면 금액·기준을 못 봄).
      const content = makeContentExcerpt(c.regulation_content, 1500);
      const laws = c.related_law_names?.length ? `\n    근거법령: ${c.related_law_names.slice(0, 8).join(", ")}` : "";
      return `[${i}] 내규: ${c.regulation_name} / 구분: ${kind} / 조문명: ${itemName}${laws}\n    조문 원문: ${content}`;
    })
    .join("\n");

  const infoNote = infoOnly
    ? `\n\n## 이 문서의 성격: 정보성 자료(보도자료·설명자료 등)\n- 법적 구속력 있는 개정이 아니다. 따라서 어떤 후보도 "개정 필요(높음)"로 단정하지 말 것.\n- 관련 내규는 '동향 모니터링' 관점으로 본다: impact 는 최대 "중간", compliance_need 는 "검토"(또는 "불요"). 중요한 정책 방향 신호는 살리되 단정 금지.`
    : "";
  const system = `당신은 IBK기업은행 준법지원부의 내규–법령 정합성 분석 전문가입니다.\n\n${IBK_PROFILE}\n\n${JUDGMENT_CRITERIA}${infoNote}`;

  const prompt = `## 이번 규제변동(분석 대상)
${changeSummary}

## 하이브리드 검색이 찾아온 내규 후보 (${cands.length}건)
${candidateBlock}

## 지시
각 후보 [index]에 대해 판정 기준(1~3단계 + 적합성/영향도)을 적용해 판정하라.
- 키워드만 겹치고 실질 업무객체가 다르면 "부적합"으로 판정한다.
- 후보 조문이 다루는 **업무 영역**이 이번 변경과 겹치면(근거법령 표기가 달라도) "적합"으로 본다. 업무 영역이 같고 개정이 불요하면 "적합·낮음(참고)". 업무 영역 자체가 다른데 수치·용어만 겹치면 "부적합". 애매하면 0건 단정보다 "적합·낮음".
- impact 와 compliance_need 를 반드시 일치시킨다: 현행 내규로 충분하면 impact="낮음"·compliance_need="불요"(현행 유지), 보완검토면 "중간"·"검토", 개정·신설 필요면 "높음"·"필요". "반영됨인데 높음" 같은 모순 금지.
- ★ 후보 '조문 원문'에 변경의 새 기준(금액·요건·절차)이 **이미 동일하게** 있으면(원문 수치를 끝까지 직접 대조), 그 조문이 변경의 직접 대상이라도 반드시 compliance_need="불요"·impact="낮음"(반영됨). impact는 주제 적중도가 아니라 개정 필요성으로 판단.
- IBK의 특수은행·공공기관 이중성을 반드시 고려한다.
- 후보의 구분이 "별표" 또는 "별지서식"이면 jo 값은 별표/서식 번호일 수 있다. 이를 "제n조"로 오인하지 말고 별표/서식 자체로 판단한다.
- compliance_need는 현재 내규내용과 이번 규제변동을 비교해 판단한다. 현재 내규에 이미 같은 기준이 반영되어 있으면 "불요" 또는 "검토"로 두고, 사유에 "현행 반영 여부"를 명확히 쓴다.
- 반드시 아래 스키마의 JSON 배열만 출력한다(설명 문장 금지):

[
  {
    "index": 0,
    "relevance": "적합" | "부적합",
    "applicability_basis": "직접적용|은행적용|금융회사적용|공공기관적용|상장회사적용|일반법인적용",
    "impact": "높음" | "중간" | "낮음" | "해당없음",
    "compliance_need": "필요" | "검토" | "불요",
    "ibk_specific": true | false,
    "reason": "IBK의 구체적 성격과 연결한 1~2문장 사유"
  }
]`;

  // ⚠️ json_mode=true는 서버가 Python dict를 str()로 직렬화해 작은따옴표 JSON을 반환(파싱불가).
  //    json_mode=false로 두고 프롬프트로 JSON 배열을 요구 → extractJson이 ```json 펜스까지 처리.
  const raw = await callCompletion({
    systemPrompt: system,
    prompt,
    maxTokens: 6000,
    temperature: 0.1,
    jsonMode: false,
  });

  let verdicts: (Partial<Verdict> & { index: number })[];
  try {
    verdicts = extractJson(raw);
    if (!Array.isArray(verdicts)) throw new Error("배열 아님");
  } catch {
    // 판정 실패 시: 검색영향도를 그대로 사용하는 fallback
    return cands.map((c) => ({ ...c, verdict: fallbackVerdict(c) }));
  }

  const byIndex = new Map<number, Partial<Verdict>>();
  for (const v of verdicts) {
    if (typeof v.index === "number") byIndex.set(v.index, v);
  }

  const judged = cands.map((c, i) => {
    const v = byIndex.get(i);
    const verdict: Verdict = v
      ? {
          relevance: v.relevance === "부적합" ? "부적합" : "적합",
          applicability_basis: v.applicability_basis ?? "금융회사적용",
          impact: normalizeImpact(v.impact, v.relevance, v.compliance_need, infoOnly),
          compliance_need: infoOnly && v.compliance_need === "필요" ? "검토" : v.compliance_need ?? "검토",
          ibk_specific: !!v.ibk_specific,
          reason: v.reason ?? "",
        }
      : fallbackVerdict(c);
    return { ...c, verdict };
  });

  // 적합 우선 + 영향도 순 정렬
  judged.sort((a, b) => {
    const ra = a.verdict.relevance === "적합" ? 0 : 1;
    const rb = b.verdict.relevance === "적합" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (IMPACT_RANK[a.verdict.impact] ?? 9) - (IMPACT_RANK[b.verdict.impact] ?? 9);
  });

  return judged;
}

/**
 * 영향도 정규화 — 개정필요성(compliance_need)과 일관성을 강제한다.
 * "현행 반영됨/개정 불요"인데 영향도가 높게 나오는 모순을 코드에서 차단.
 *   불요 → 낮음, 검토 → 최대 중간, 필요 → 높음/중간 유지
 */
function normalizeImpact(
  impact: unknown,
  relevance: unknown,
  complianceNeed: unknown,
  infoOnly = false
): ImpactLevel {
  if (relevance === "부적합") return "해당없음";
  let imp: ImpactLevel =
    impact === "높음" || impact === "중간" || impact === "낮음" ? impact : "낮음";
  if (complianceNeed === "불요") imp = "낮음";
  else if (complianceNeed === "검토" && imp === "높음") imp = "중간";
  else if (complianceNeed === "필요" && imp === "낮음") imp = "중간";
  // 정보성 자료(보도자료 등)는 구속력 없음 → 개정 단정(높음) 금지, 최대 중간(모니터링)
  if (infoOnly && imp === "높음") imp = "중간";
  return imp;
}

function fallbackVerdict(c: Candidate): Verdict {
  const imp = c.importance === "high" ? "높음" : c.importance === "medium" ? "중간" : "낮음";
  return {
    relevance: "적합",
    applicability_basis: "금융회사적용",
    impact: imp as ImpactLevel,
    compliance_need: "검토",
    ibk_specific: false,
    reason: "LLM 판정 미수행 — 하이브리드 검색 영향도를 사용함.",
  };
}

function buildChangeSummary(lawName: string, itemType: ItemType, a?: Analysis): string {
  const lines = [
    `- 문서유형: ${itemType === "policy" ? "입법예고/시행령 등" : "법률안"}`,
    `- 법령명: ${a?.law_name || lawName}`,
  ];
  if (a?.law_domain) lines.push(`- 분야: ${a.law_domain}`);
  if (a?.core_summary) lines.push(`- 핵심요약: ${a.core_summary}`);
  if (a?.search_keywords?.length) lines.push(`- 키워드: ${a.search_keywords.slice(0, 20).join(", ")}`);
  if (a?.change_overview?.length) {
    const ov = a.change_overview
      .slice(0, 6)
      .map((o) => JSON.stringify(o, null, 0))
      .join("; ");
    lines.push(`- 주요 변경: ${ov}`);
  }
  return lines.join("\n");
}
