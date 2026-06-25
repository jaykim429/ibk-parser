/**
 * 리랭킹 단계 — 벡터 검색(코사인) 후보를 "이번 규제변동과의 실질 관련도"로 재채점.
 *
 *  core-ai의 크로스인코더 리랭커는 고정 컬렉션(regulations) 전용이라 격리 컬렉션
 *  (regulations_ibk_test) 후보에는 쓸 수 없다. 대신 LLM을 크로스인코더처럼 사용해
 *  query(변경) ↔ 각 후보 조문의 관련도를 0~100으로 매겨 상위만 정밀 판정으로 보낸다.
 *
 *  - 순수 관련도 채점만(적합/영향도 판정은 judge가 수행) → 가볍고 빠름.
 *  - 실패 시 벡터 순서를 그대로 사용(graceful fallback).
 *  - 특정 내규/법령 분기 없음(일반 원칙). [[avoid-hardcoding-general-llm]]
 */
import { callCompletion, extractJson } from "./llm";
import { formatRegulationItemName, makeContentExcerpt } from "./regulation-format";
import { config } from "./config";
import type { Analysis, Candidate, ItemType } from "./server";

const SYSTEM = `당신은 규제변동–내규 매칭의 '관련도 채점기'입니다.
각 내규 조문이 이번 규제변동과 얼마나 관련되는지 0~100으로 채점합니다(후보 선별용 — 너무 박하게 주지 말 것).
점수 가이드:
- 80~100: 변경의 핵심 쟁점을 직접 다루는 조문.
- 40~70: 같은 **업무 영역**(예: 예금↔예금자보호, 전자금융/IT↔전자금융거래법, 공시↔공시의무)이라 관련 가능성이 있는 조문. 근거법령 표기가 달라도 업무 영역이 겹치면 이 구간 이상.
- 0~20: **업무 영역 자체가 다른데** 수치·용어만 우연히 겹치는 경우(예: 자본시장법 재산상이익 ↔ 청탁금지법 공직자 금품), 또는 명백히 무관.
- 목적·적용범위·정의·준용·부칙 같은 구조 조항은 다소 낮추되 0으로 죽이지 말 것(해당 내규가 업무 영역에 맞으면 30~50).
- 점수만 판단합니다(적합/영향도 판정은 하지 않음).`;

export async function rerankCandidates(args: {
  lawName: string;
  itemType: ItemType;
  analysis?: Analysis;
  candidates: Candidate[];
  keepTopN?: number;
}): Promise<Candidate[]> {
  const { candidates } = args;
  const keepTopN = args.keepTopN ?? config.rerankKeep;
  if (candidates.length <= keepTopN) return candidates;

  const change = [
    `문서유형: ${args.itemType === "policy" ? "입법예고/시행령 등" : "법률안"}`,
    `법령명: ${args.analysis?.law_name || args.lawName}`,
    args.analysis?.core_summary ? `핵심요약: ${args.analysis.core_summary}` : "",
    args.analysis?.search_keywords?.length
      ? `키워드: ${args.analysis.search_keywords.slice(0, 20).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const block = candidates
    .map((c, i) => {
      const laws = c.related_law_names?.length ? ` [근거법령: ${c.related_law_names.slice(0, 6).join(", ")}]` : "";
      return `[${i}] ${c.regulation_name} ${formatRegulationItemName(c)}${laws}: ${makeContentExcerpt(c.regulation_content, 180)}`;
    })
    .join("\n");

  const prompt = `## 규제변동
${change}

## 후보 조문 (${candidates.length})
${block}

## 지시
각 후보 [index]의 관련도를 0~100으로 채점. JSON 배열만 출력(설명 금지):
[{"index":0,"score":0~100}, ...]`;

  try {
    const raw = await callCompletion({
      systemPrompt: SYSTEM,
      prompt,
      maxTokens: 1500,
      temperature: 0,
    });
    const scores = extractJson<{ index: number; score: number }[]>(raw);
    if (!Array.isArray(scores)) throw new Error("not array");
    const scoreByIndex = new Map<number, number>();
    for (const s of scores) {
      if (typeof s.index === "number") scoreByIndex.set(s.index, Number(s.score) || 0);
    }
    const ranked = candidates
      .map((c, i) => ({
        c,
        // 점수 없으면 코사인 점수를 0~100 환산해 보조 사용
        s: scoreByIndex.get(i) ?? Math.round((c.final_score ?? 0) * 100),
      }))
      .sort((a, b) => b.s - a.s);
    return ranked.slice(0, keepTopN).map((r) => ({ ...r.c, rerank_score: r.s }));
  } catch {
    // 실패 시 벡터(코사인) 순서 유지
    return candidates.slice(0, keepTopN);
  }
}
