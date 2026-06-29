/**
 * 헤딩 인지 정규화 — 비정형 문서(운영매뉴얼·작성기준 등)의 청킹 품질 개선.
 *
 * 적용 범위(중요): **인덱싱 경로(manualToChunks)에서만** 호출한다.
 *   라이브 영향분석은 doc.markdown을 사용(parse-document와 무관)하므로 본 정규화의 영향을 받지 않는다
 *   → 매 사용자 요청에 비용/부작용을 전가하지 않음(설계 재검증 C7 반영).
 *
 * 수단(전부 순수 정규식 — LLM·좌표(bbox)·글꼴 신호 불사용 → 미지 문서형태에 견고, 오버피팅/하드코딩 없음):
 *   1) 헤딩 텍스트 형태 정규화: 내부 탭/개행/연속공백 → 단일 공백 + 트림 ('5\t가이드'→'5 가이드', '\n필수\n'→'필수')
 *   2) 인접 동일 헤딩 dedup: 같은 텍스트·같은 level·사이 본문 0개 → 1개로 (중복 '청약'/'청약' 제거)
 *   3) 목차(TOC) 보존격리: 점선 리더 연속 블록을 __toc 로 마킹 → blocksToUnits 가 '단일 (목차) 메타유닛'으로 흡수
 *      (삭제하지 않음 — false-negative 비가역 방지. 검색풀 노이즈는 빼되 내용은 1청크로 보존)
 *
 * 안전장치(false-negative 최우선):
 *   - 첫 블록(i=0)은 목차 격리 대상에서 제외(본문 첫 유닛 흡수 금지)
 *   - 조문 표제(제N조/장/절) 라인은 목차로 마킹하지 않음(목차행이 조 제목인 경우 보류)
 *   - 임계(연속 줄수·블록당 런수)는 config 외부화, 결합조건으로만 마킹(단일 매직넘버 단독 판정 금지)
 *   - 조문형(제N조 헤딩) 문서는 점선·중복이 없어 사실상 no-op
 */
import type { IRBlock } from "kordoc";
import { config } from "./config";

/** 조/장/절/관/편 표제 — 목차 격리 보류 신호(목차행이 진짜 조 제목일 때 보호) */
const HEADING_JO = /^\s*제\s*\d+\s*(조(\s*의\s*\d+)?|장|절|관|편)/;

/** 내부 공백류(탭/개행/연속공백) → 단일 공백 + 트림 */
const wsNorm = (s: string): string => (s || "").replace(/\s+/g, " ").trim();

/** 블록 텍스트의 점선 리더(목차) 런 개수 — '......', '·····', '……' 6자 이상 런 */
const dottedRuns = (t: string): number => (String(t || "").match(/[.·…]{6,}/g) || []).length;

export type NormBlock = IRBlock & { __toc?: boolean };
export type HeadingNormStats = { dedupHeadings: number; tocBlocks: number; tocRegions: number };

export type HeadingNormCfg = {
  enabled: boolean;
  tocRunsPerBlock: number;
  tocMinLines: number;
  tocManyRuns: number;
};

function defaultCfg(): HeadingNormCfg {
  return {
    enabled: config.headingNormalizeEnabled,
    tocRunsPerBlock: config.tocRunsPerBlock,
    tocMinLines: config.tocMinLines,
    tocManyRuns: config.tocManyRuns,
  };
}

/**
 * blocks → 정규화된 blocks(+__toc 마킹) 와 통계.
 * 원본을 변형하지 않고 사본을 반환(idempotent — 두 번 호출해도 동일).
 */
export function normalizeHeadingTree(
  blocks: IRBlock[],
  cfg: HeadingNormCfg = defaultCfg()
): { blocks: NormBlock[]; stats: HeadingNormStats } {
  const stats: HeadingNormStats = { dedupHeadings: 0, tocBlocks: 0, tocRegions: 0 };
  if (!cfg.enabled || !blocks?.length) return { blocks: (blocks ?? []) as NormBlock[], stats };

  // 1) 헤딩 텍스트 형태 정규화
  let out: NormBlock[] = blocks.map((b) =>
    b.type === "heading" && b.text ? { ...b, text: wsNorm(b.text) } : { ...b }
  );

  // 2) 인접 동일 헤딩 dedup (같은 텍스트·같은 level·연속 — 사이 본문 블록이 없을 때만)
  const dedup: NormBlock[] = [];
  for (const b of out) {
    const prev = dedup[dedup.length - 1];
    if (
      b.type === "heading" &&
      prev?.type === "heading" &&
      wsNorm(prev.text ?? "") === wsNorm(b.text ?? "") &&
      (prev.level ?? 1) === (b.level ?? 1)
    ) {
      stats.dedupHeadings++;
      continue; // 중복 헤딩 1개로 — 내용 손실 없음(동일 텍스트)
    }
    dedup.push(b);
  }
  out = dedup;

  // 3) 목차(TOC) 보존격리 — 점선 리더 연속 런 또는 단일 거대 목차블록 마킹
  const isTocLine = (b: NormBlock): boolean =>
    dottedRuns(b.text ?? "") >= cfg.tocRunsPerBlock && !HEADING_JO.test(b.text ?? "");
  let i = 0;
  while (i < out.length) {
    if (i > 0 && isTocLine(out[i])) {
      let j = i;
      while (j < out.length && isTocLine(out[j])) j++;
      // 결합조건(단일 매직넘버 단독 판정 금지):
      //  · consecutive: 점선 라인이 tocMinLines 이상 연속 = 약신호 다줄 목차
      //  · denseBlock: 블록 자체에 점선런이 tocManyRuns 이상 = 강신호(짧은 목차도 포착)
      const consecutive = j - i >= cfg.tocMinLines;
      let marked = 0;
      for (let k = i; k < j; k++) {
        if (consecutive || dottedRuns(out[k].text ?? "") >= cfg.tocManyRuns) {
          out[k].__toc = true;
          stats.tocBlocks++;
          marked++;
        }
      }
      if (marked) stats.tocRegions++;
      i = j;
    } else {
      i++;
    }
  }

  return { blocks: out, stats };
}

/** 목차 라인에서 점선 리더·표 구분자·페이지번호 잔여를 제거해 '항목 제목'만 압축 보존 */
export function stripTocLeaders(s: string): string {
  return (s || "")
    .replace(/[.·…]{4,}/g, " ") // 점선 리더 제거
    .replace(/\|/g, " ") // 표 구분자 제거
    .replace(/\s+/g, " ")
    .trim();
}
