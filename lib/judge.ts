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
import type { Analysis, Candidate, ItemType, Obligation } from "./server";

export type Verdict = {
  relevance: "적합" | "부적합";
  applicability_basis: BasisType | string;
  impact: ImpactLevel;
  /** 리스크 크기 — 개정 필요성(impact)과 독립. 미대응/위반 시 컴플라이언스·사업 리스크(法源·제재·범위). 시간 무관(백테스팅 안전). */
  risk_level: ImpactLevel;
  compliance_need: ComplianceNeed | string;
  /** 반영 여부 — 반영됨|개정 불요|일부 반영|미반영|해당 없음|모니터링 대상 */
  reflection: string;
  ibk_specific: boolean;
  reason: string;
  /** LLM 판정 실패로 검색영향도 잠정 추정치를 쓴 경우 true — 리스크 축 미산정·고지 대상(2축 독립 오인 방지). */
  degraded?: boolean;
  /** 0-선결: 이 변경 의무의 1차 수범자(업권+행위). 내부 추론 강제·백스톱용(보고서 비노출). */
  obligor?: string;
  /** 수범자-IBK 관계: 겸영해당|IBK직접|비영위|불명. '비영위'면 백스톱이 부적합 강등(fail-safe). */
  obligor_match?: string;
};

export type JudgedMatch = Candidate & { verdict: Verdict };

const IMPACT_RANK: Record<string, number> = {
  높음: 0,
  중간: 1,
  낮음: 2,
  해당없음: 3,
};

/**
 * 저변별 '목적/총칙/통칙' 조항 식별 — 어떤 입력에도 걸리는 변별력 0 조항.
 * 조문명(jo_title)이 목적/총칙/통칙인 경우만(정의·적용범위는 실질일 수 있어 제외).
 */
function isLowDiscriminationClause(c: Candidate): boolean {
  const t = `${c.jo_title ?? ""} ${c.jo ?? ""}`.replace(/\s+/g, "");
  return /(^|[(（])(목적|총칙|통칙)([)）]|$)/.test(t) || /^목적$|^총칙$|^통칙$/.test((c.jo_title ?? "").trim());
}

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
  obligations?: Obligation[];
}): Promise<JudgedMatch[]> {
  const cands = dedupeCandidates(args.candidates).slice(0, args.maxCandidates ?? config.judgeMax);
  if (cands.length === 0) return [];
  const infoOnly = !!args.infoOnly;

  const changeSummary = buildChangeSummary(args.lawName, args.itemType, args.analysis, args.obligations);

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
각 후보 [index]에 대해 판정 기준(0단계 nexus + 1~3단계 + 적합성/영향도)을 적용해 판정하라.
- ★ **relevance 판정 전에 먼저** 이번 규제변동이 부과하는 의무의 **1차 수범자(업권+행위)를 obligor에 한 줄로 쓰고**, 그 주체가 IBK와 어떻게 닿는지 obligor_match로 분류하라: "겸영해당"(IBK가 영위/대리하는 업무의 수범자) | "IBK직접"(은행·공공기관 등 직접 수범) | "비영위"(IBK가 그 인허가를 보유하지 않아 영위하지 않는 타 업권 고유 행위자) | "불명". obligor_match="비영위"면 주제어가 겹쳐도 전 후보 "부적합".
- 키워드만 겹치고 실질 업무객체가 다르면 "부적합"으로 판정한다.
- 후보 조문이 다루는 **업무 영역**이 이번 변경과 겹치면(근거법령 표기가 달라도) "적합"으로 본다. 업무 영역이 같고 개정이 불요하면 "적합·낮음(참고)". 업무 영역 자체가 다른데 수치·용어만 겹치면 "부적합". 애매하면 0건 단정보다 "적합·낮음".
- impact 와 compliance_need 를 반드시 일치시킨다: 현행 내규로 충분하면 impact="낮음"·compliance_need="불요"(현행 유지), 보완검토면 "중간"·"검토", 개정·신설 필요면 "높음"·"필요". "반영됨인데 높음" 같은 모순 금지.
- ★ 후보 '조문 원문'에 변경의 새 기준(금액·요건·절차)이 **이미 동일하게** 있으면(원문 수치를 끝까지 직접 대조), 그 조문이 변경의 직접 대상이라도 반드시 compliance_need="불요"·impact="낮음"(반영됨). impact는 주제 적중도가 아니라 개정 필요성으로 판단.
- IBK의 특수은행·공공기관 이중성을 반드시 고려한다.
- **risk_level(리스크 크기)은 impact(개정 필요성)와 독립적으로** 판단한다(위 '리스크 크기' 기준 참조). 法源 강도·제재 수위·영향 범위로만 보고, '시행일까지 남은 시간/시급성'으로 키우거나 줄이지 말 것(백테스팅: 과거 문서). 부적합이면 risk_level="해당없음".
- 후보의 구분이 "별표" 또는 "별지서식"이면 jo 값은 별표/서식 번호일 수 있다. 이를 "제n조"로 오인하지 말고 별표/서식 자체로 판단한다.
- compliance_need는 현재 내규내용과 이번 규제변동을 비교해 판단한다. 현재 내규에 이미 같은 기준이 반영되어 있으면 "불요" 또는 "검토"로 두고, 사유에 "현행 반영 여부"를 명확히 쓴다.
- 반드시 아래 스키마의 JSON 배열만 출력한다(설명 문장 금지):

[
  {
    "index": 0,
    "obligor": "이 변경이 부과하는 의무의 1차 수범자 업권+행위 한 줄(예: '가상자산사업자의 가상자산 대여 영업')",
    "obligor_match": "겸영해당" | "IBK직접" | "비영위" | "불명",
    "relevance": "적합" | "부적합",
    "applicability_basis": "직접적용|은행적용|금융회사적용|공공기관적용|상장회사적용|일반법인적용",
    "impact": "높음" | "중간" | "낮음" | "해당없음",
    "risk_level": "높음" | "중간" | "낮음" | "해당없음",
    "compliance_need": "필요" | "검토" | "불요",
    "reflection": "반영됨" | "개정 불요" | "일부 반영" | "미반영" | "해당 없음",
    "ibk_specific": true | false,
    "reason": "IBK의 구체적 성격과 연결한 1~2문장 사유"
  }
]`;

  // ⚠️ json_mode=true는 서버가 Python dict를 str()로 직렬화해 작은따옴표 JSON을 반환(파싱불가).
  //    json_mode=false로 두고 프롬프트로 JSON 배열을 요구 → extractJson이 ```json 펜스까지 처리.
  //  maxTokens는 후보 수에 비례(후보마다 사유 포함 객체 1개) — 고정 6000은 후보 18건에서 응답이 잘려
  //  파싱 실패→문서 전체가 검색영향도 fallback으로 강등되던 회귀의 직접 원인이었음. 넉넉히+상한.
  const judgeMaxTokens = Math.min(16000, 4000 + cands.length * 700);
  let verdicts: (Partial<Verdict> & { index: number })[] | null = null;
  // 파싱 실패는 보통 응답 잘림 → 1회 재시도(결정성 위해 temperature 0). 그래도 실패면 fallback.
  for (let attempt = 0; attempt < 2 && !verdicts; attempt++) {
    const raw = await callCompletion({
      systemPrompt: system,
      prompt,
      maxTokens: judgeMaxTokens,
      temperature: attempt === 0 ? 0.1 : 0,
      jsonMode: false,
    });
    try {
      const parsed = extractJson<unknown>(raw);
      if (!Array.isArray(parsed)) throw new Error("배열 아님");
      verdicts = parsed as (Partial<Verdict> & { index: number })[];
    } catch (e) {
      console.warn(`[JUDGE] 판정 JSON 파싱 실패(시도 ${attempt + 1}/2): ${(e as Error)?.message ?? e}`);
    }
  }
  if (!verdicts) {
    // 최종 실패 시: 검색영향도를 그대로 쓰는 fallback(degraded 표시 — 리스크 축은 산정 안 함).
    console.warn(`[JUDGE] 재시도 후에도 파싱 실패 → 전 후보 검색영향도 fallback(degraded)`);
    return cands.map((c) => ({ ...c, verdict: fallbackVerdict(c) }));
  }

  const byIndex = new Map<number, Partial<Verdict>>();
  for (const v of verdicts) {
    if (typeof v.index === "number") byIndex.set(v.index, v);
  }

  const judged = cands.map((c, i) => {
    const v = byIndex.get(i);
    // compliance_need를 한 번만 정규화(빈문자열 폴백 + infoOnly '필요'→'검토') 후 impact/reflection에 동일 값 전달.
    //  (이전: 저장값은 강등하면서 정규화 함수엔 원본을 넘겨 단일 진실원천이 깨졌고, `?? "검토"`는 빈문자열을 못 막음)
    const rawNeed = v && typeof v.compliance_need === "string" ? v.compliance_need.trim() : "";
    // ⚠️ need를 정확히 enum(필요/검토/불요)으로 강제 — LLM이 변형값('필요함'·'해당없음' 등)을 주면
    //  normalizeImpact(원값 유지)과 normalizeReflection(→개정불요 기본)이 발산해 '개정불요+높음' 모순이 생김.
    const enumNeed = rawNeed === "필요" || rawNeed === "검토" || rawNeed === "불요" ? rawNeed : "검토";
    const need = (infoOnly && enumNeed === "필요" ? "검토" : enumNeed) as Verdict["compliance_need"];
    let verdict: Verdict = v
      ? {
          relevance: v.relevance === "부적합" ? "부적합" : "적합",
          applicability_basis: v.applicability_basis ?? "금융회사적용",
          impact: normalizeImpact(v.impact, v.relevance, need, infoOnly),
          risk_level: normalizeRisk(v.risk_level, v.relevance),
          compliance_need: need,
          reflection: normalizeReflection(v.reflection, v.relevance, need, infoOnly),
          ibk_specific: !!v.ibk_specific,
          reason: v.reason ?? "",
          obligor: typeof v.obligor === "string" ? v.obligor : undefined,
          obligor_match: typeof v.obligor_match === "string" ? v.obligor_match : undefined,
        }
      : fallbackVerdict(c);
    // 수범자 백스톱(fail-safe): 1차 수범자가 IBK 비영위 타 업권으로 명시 특정된 후보만 부적합 강등.
    //  '불명'·'겸영해당'·'IBK직접'은 보호 → 겸영(금투·방카) 오차단 회귀 0. (가상자산 등 업종 하드코딩 없음)
    if (verdict.relevance === "적합" && v?.obligor_match === "비영위") {
      verdict.relevance = "부적합";
      verdict.impact = "해당없음";
      verdict.risk_level = "해당없음";
      verdict.reflection = "해당 없음";
      if (!/수범자|비영위|영위하지/.test(verdict.reason)) {
        verdict.reason = `이번 변경 의무의 1차 수범자가 IBK 비영위 타 업권(${v?.obligor ?? ""})으로, IBK가 그 행위를 직접 수행하지 않아 직접 정합성 영향 없음. ${verdict.reason}`.trim();
      }
    }
    // 2축 최종 정합 가드 — 어떤 경로로든 반영여부↔개정필요성이 모순되지 않게(사용자 노출 표의 상충 금지).
    verdict = enforceAxisConsistency(verdict);
    // 결정적 백스톱: '목적/총칙' 저변별 조항이 현행유지(낮음)로 적합 처리되면 노이즈 → 부적합 강등.
    //   (이번 변경이 그 조항을 직접 바꾼다면 LLM이 '필요/중간↑'로 줄 것이므로 낮음일 때만 강등)
    if (
      verdict.relevance === "적합" &&
      verdict.impact === "낮음" &&
      isLowDiscriminationClause(c)
    ) {
      verdict.relevance = "부적합";
      verdict.impact = "해당없음";
      verdict.risk_level = "해당없음";
      verdict.reflection = "해당 없음";
      if (!/저변별|목적|총칙/.test(verdict.reason)) {
        verdict.reason = `목적·총칙류 저변별 조항으로, 이번 변경이 해당 조항 자체를 바꾸지 않아 직접 정합성 영향 없음. ${verdict.reason}`.trim();
      }
    }
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

/**
 * 반영 여부 정규화 — impact/compliance_need와 일관 강제, 5+1 케이스.
 *  부적합→해당없음 / 정보성→모니터링 / 필요→미반영 / 검토→일부 반영
 *  불요→ LLM이 '반영됨' 또는 '개정 불요' 선택(그 외는 개정 불요로).
 */
function normalizeReflection(
  reflection: unknown,
  relevance: unknown,
  complianceNeed: unknown,
  infoOnly = false
): string {
  if (infoOnly) return "모니터링 대상";
  if (relevance === "부적합") return "해당 없음";
  if (complianceNeed === "필요") return "미반영";
  if (complianceNeed === "검토") return "일부 반영";
  // 불요(낮음): 원문에 기준이 이미 있으면 '반영됨', 아니면 '개정 불요'
  return reflection === "반영됨" ? "반영됨" : "개정 불요";
}

/** 리스크 크기 정규화 — 개정 필요성과 독립. 부적합→해당없음, 누락→중간(보수 기본). */
function normalizeRisk(risk: unknown, relevance: unknown): ImpactLevel {
  if (relevance === "부적합") return "해당없음";
  return risk === "높음" || risk === "중간" || risk === "낮음" ? risk : "중간";
}

/**
 * 2축 최종 정합 가드 — 반영여부(reflection)와 개정필요성(impact)이 모순되지 않게 강제.
 *  · '반영됨/개정 불요'(개정 불필요)는 정의상 개정필요성=낮음 → 높음/중간과 공존 불가.
 *  · '미반영'(개정 필요)인데 낮음이면 모순 → 중간(보수). 리스크 축은 독립이므로 건드리지 않음.
 *  (need가 LLM 변형값이라 normalizeImpact/Reflection이 발산하는 경로의 최종 방어 — 표 상충 차단)
 */
function enforceAxisConsistency(v: Verdict): Verdict {
  if ((v.reflection === "반영됨" || v.reflection === "개정 불요") && v.impact !== "낮음") {
    return { ...v, impact: "낮음", compliance_need: "불요" };
  }
  if (v.reflection === "미반영" && v.impact === "낮음") {
    return { ...v, impact: "중간" };
  }
  return v;
}

function fallbackVerdict(c: Candidate): Verdict {
  // 판정 실패 시 검색영향도 사용. ⚠️ impact↔compliance_need↔reflection을 일관 매핑(불변식 준수) —
  //  이전엔 reflection을 '일부 반영'으로 고정해 '높음+일부 반영' 같은 정규화 불변식 위반이 발생했음.
  const imp: ImpactLevel = c.importance === "high" ? "높음" : c.importance === "medium" ? "중간" : "낮음";
  const need: ComplianceNeed = imp === "높음" ? "필요" : imp === "중간" ? "검토" : "불요";
  const refl = imp === "높음" ? "미반영" : imp === "중간" ? "일부 반영" : "개정 불요";
  return {
    relevance: "적합",
    applicability_basis: "금융회사적용",
    impact: imp,
    // ⚠️ 리스크를 impact로 동일 대입하지 않는다 — 그러면 두 축(개정필요성·리스크)이 비트 단위로 같아져
    //  '독립 평가'로 오인됨. 판정 미수행 시 리스크는 산정 불가 → 보수 기본 '중간' + degraded로 별도 고지.
    risk_level: "중간",
    compliance_need: need,
    reflection: refl,
    ibk_specific: false,
    // 사용자 노출 가능 — 개발/내부 용어('하이브리드 검색') 금지, 비전문가 친화 표현.
    reason: "자동 정합성 판정을 일시적으로 수행하지 못해 검색 기반 잠정 추정치로 표시함(원문 직접 확인 권장).",
    degraded: true,
  };
}

const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  policy: "입법예고/시행령 등",
  bill: "법률안",
  guideline: "가이드라인/모범규준(자율규제)",
};

function buildChangeSummary(lawName: string, itemType: ItemType, a?: Analysis, obligations?: Obligation[]): string {
  const lines = [
    `- 문서유형: ${ITEM_TYPE_LABEL[itemType] ?? itemType}`,
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
  // 추출된 의무·권고를 함께 제시 — analyze(요약)가 문서의 일부(예: 편집기준)에 고착해도
  //  실제 요구사항이 판정 기준에 반영되도록 한다(부적합 캐스케이드/부재 과대 방지).
  if (obligations?.length) {
    const obl = obligations.slice(0, 14).map((o) => `${o.title}(${o.kind})`).join("; ");
    lines.push(`- 이 문서가 요구하는 의무·권고: ${obl}`);
  }
  return lines.join("\n");
}

// ── 요건 커버리지 분석 (권고2: 요건 체크리스트 + '대응 내규 부재 = 높음' 신호) ──────────
/**
 * 요건 커버리지 — 원천문서가 요구하는 의무 항목 각각에 대해, IBK 내규로
 *  충족/부분/부재 중 무엇인지 + 대응 내규(있으면) + 권고를 산출한다.
 * 1:1 조문 매칭만으로는 '없는 내규(부재)'가 안 보이므로 별도 산출.
 *  - 충족: 대응 내규 있음(낮음) / 부분: 일부만(중간) / 부재: 대응 내규 없음(높음·신규 필요)
 * 보고서는 이 목록 전체를 '요건 체크리스트'로 표시하고, 부분·부재는 갭으로 집계한다.
 */
export type CoverageItem = {
  area: string;
  requirement: string;
  kind: string;
  coverage: "충족" | "부분" | "부재" | "해당없음";
  evidence: string; // 대응 내규(충족·부분) / "대응 내규 미확인"(부재) / "IBK 비영위 업무"(해당없음)
  impact: "낮음" | "중간" | "높음" | "없음";
  recommendation: string;
};
/** 부분·부재(=갭)만 추린 부분집합 — 카운트·우선조치용 */
export type CoverageGap = CoverageItem & { coverage: "부분" | "부재"; impact: "중간" | "높음" };

/** 의무 + 그 의무 전용 검색 후보(내규). pipeline이 의무별 타깃 검색으로 채워 전달. */
export type ObligationCandidates = { obligation: Obligation; candidates: Candidate[] };

/**
 * 의무별 커버리지 평가 — 각 의무를 '그 의무 전용 검색 후보'로 충족/부분/부재 판정(전 항목 반환).
 *
 * 재설계(정확도): 기존엔 전역 융합·리랭크 top-N 풀로만 판정 → 대응 내규가 풀 밖이면 '부재' 과대(예: 위탁규정
 *  보유했으나 top-N 탈락 → false 부재). 이제 pipeline이 **의무마다 그 의무 텍스트로 직접 검색**해 전용 후보를
 *  넘기고, 각 의무를 그 전용 후보로만 판정 → false 부재 제거 + 근거 정밀.
 *  - 하드코딩 없음. 게이트(requiresFramework/일부개정 제외)는 pipeline이 담당.
 */
export async function assessCoverage(args: {
  lawName: string;
  perObligation: ObligationCandidates[];
  globalRelevant?: JudgedMatch[]; // 여러 의무를 가로지르는 적합 내규(보조 힌트)
  infoOnly?: boolean;
}): Promise<CoverageItem[]> {
  const items = (args.perObligation ?? []).filter((x) => x && x.obligation);
  if (args.infoOnly || items.length === 0) return [];

  // 의무별 블록: 의무 + 그 의무 전용 검색 후보(원문 발췌, 중복 조문 제거 후 상위 5)
  const block = items
    .map((it, i) => {
      const cands = dedupeCandidates(it.candidates ?? [])
        .slice(0, 5)
        .map((c) => `    - ${c.regulation_name} ${formatRegulationItemName(c)}: ${makeContentExcerpt(c.regulation_content, 300)}`)
        .join("\n");
      return `[${i}] (${it.obligation.kind}) ${it.obligation.title} — ${it.obligation.summary}\n  ▷ 이 의무로 검색된 IBK 내규 후보:\n${cands || "    - (대응 후보 없음)"}`;
    })
    .join("\n\n");

  const globalNames = Array.from(
    new Set((args.globalRelevant ?? []).map((j) => `${j.regulation_name} ${formatRegulationItemName(j)}`))
  ).slice(0, 20);

  const SYSTEM = `당신은 IBK기업은행 준법지원부의 내규 커버리지 분석가다. 원천문서가 요구하는 '의무'마다, 그 의무로 검색된 IBK 내규 후보로 충족 여부를 판정한다.
${IBK_PROFILE}

판단 원칙:
- 각 의무를 그 의무의 '검색된 후보 내규'로 판정: 후보 중 **그 의무를 실질적으로 규율하는 조문**이 있으면 "충족"(요건 대부분 반영) 또는 "부분"(일부만), 그런 조문이 없으면 "부재".
- ⚠️ **부재는 '그 의무 전용 후보'에도 대응 조문이 없을 때만**. 후보에 관련 내규가 있으면 우선 충족/부분을 검토하라(보유 내규를 '부재(신규 필요)'로 과대평가 금지).
- ⚠️ **선언적 상위규범(윤리원칙·기본방침)만으론 구체 체계 의무(위험관리규정/평가체계/HITL·긴급정지/보안통제/위탁관리/이해상충)를 충족으로 보지 말 것**(층위가 다름).
- 표면 주제어만 겹치는 내규(목적·총칙, 직교 영역)는 근거 아님. **evidence(충족·부분)에는 그 의무를 실제 규율하는 조문만 인용**(헐거운 주제어 매핑 금지).
- 부재=신규 내규 필요(높음), 부분=보완(중간), 충족=현행 유지(낮음).
- ⚠️ **"해당없음"은 그 의무가 IBK가 영위하지 않는 업무·서비스에 관한 것일 때만**(위 IBK 프로필의 업무 범위 기준 — 예: IBK가 전혀 취급하지 않는 상품/업무의 전용 의무). **단순히 '대응 조문을 못 찾음'은 부재(신규 필요)이지 해당없음이 아니다.** IBK가 그 업무를 하는지 불확실하면 보수적으로 "부재"로 둔다(해당없음 남용 금지 — 진짜 비영위만).
- 모든 의무 [index]를 빠짐없이 평가.
JSON만 출력: {"items":[{"index":0,"coverage":"충족"|"부분"|"부재"|"해당없음","evidence":"대응 내규명/조문 / '대응 내규 미확인'(부재) / 'IBK 비영위 업무'(해당없음)","recommendation":"권고 한 줄(개조식). 충족이면 '현행 유지', 해당없음이면 '해당 없음(비영위)'"}]}`;

  const prompt = `## 원천문서: ${args.lawName}
## 의무별 평가 대상 (의무 + 그 의무 전용 검색 후보)
${block}

## (참고) 이번 문서에 IBK가 '적합' 판정한 내규(여러 의무에 걸칠 수 있음)
${globalNames.length ? globalNames.join(", ") : "- 없음"}

## 지시
각 의무 [index]를 **그 의무의 후보 내규**로 충족/부분/부재 평가해 JSON으로 출력하라.`;

  try {
    const raw = await callCompletion({ systemPrompt: SYSTEM, prompt, maxTokens: 4000, temperature: 0.1, jsonMode: false });
    type CovRow = { index?: number; coverage?: string; evidence?: string; recommendation?: string };
    const v = extractJson<{ items?: CovRow[]; gaps?: CovRow[] }>(raw);
    const rows: CovRow[] = Array.isArray(v.items) ? v.items : Array.isArray(v.gaps) ? v.gaps : [];
    const byIndex = new Map<number, CovRow>();
    for (const r of rows) if (typeof r.index === "number") byIndex.set(r.index, r);

    const norm = (c?: string): "충족" | "부분" | "부재" | "해당없음" =>
      c === "부재" ? "부재" : c === "충족" ? "충족" : c === "해당없음" || c === "해당 없음" ? "해당없음" : "부분";
    const impactOf = (c: "충족" | "부분" | "부재" | "해당없음"): "낮음" | "중간" | "높음" | "없음" =>
      c === "부재" ? "높음" : c === "부분" ? "중간" : c === "해당없음" ? "없음" : "낮음";

    return items.map((it, i) => {
      const o = it.obligation;
      const hasCands = dedupeCandidates(it.candidates ?? []).length > 0;
      const r = byIndex.get(i);
      // 평가 누락 시: 후보가 있으면 부분(중간), 없으면 부재(높음) — 누락을 해당없음으로 처리하지 않음(안전방향)
      const coverage = r ? norm(r.coverage) : hasCands ? "부분" : "부재";
      const evidence = String(
        r?.evidence ?? (coverage === "부재" ? "대응 내규 미확인" : "자동 평가 누락 — 담당 확인")
      ).trim();
      const defaultRec =
        coverage === "부재" ? `${o.title} 관련 내규 신설 검토`
          : coverage === "부분" ? `${o.title} 관련 내규 보완 검토`
            : coverage === "해당없음" ? "해당 없음(IBK 비영위 업무)"
              : "현행 유지";
      return {
        area: o.key || o.title,
        requirement: o.title,
        kind: o.kind,
        coverage,
        evidence,
        impact: impactOf(coverage),
        recommendation: String(r?.recommendation ?? defaultRec).trim(),
      } as CoverageItem;
    });
  } catch (e) {
    // ⚠️ 조용히 []를 반환하면 '갭 0(=과소커버리지)'로 둔갑하므로 반드시 로그(추적 가능).
    console.warn(`[COVERAGE] assessCoverage 실패 → 빈 결과: ${(e as Error)?.message ?? e}`);
    return [];
  }
}
