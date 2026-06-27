/**
 * 매뉴얼형(비정형) 내규 청킹 — 조문 구조가 없거나(매뉴얼/지침) kordoc가 조문을
 * heading 으로 분류하는 문서를 '헤딩 섹션' 단위로 청킹한다(고정 글자수 슬라이딩 ❌).
 *
 *   parse → blocks 직접 순회(heading 텍스트도 본문으로 방출 → 조문 내용 유실 방지)
 *     → 같은 섹션(headingPath) 연속 본문 그룹화
 *     → 긴 섹션은 overlap 서브분할
 *     → 인접 링크 + 섹션 단위 보존(컨텍스트 확장용)
 *
 * 설계 의도(사용자 요구):
 *  - 비정형 문서라도 헤딩(제N장/제N조/섹션명)이 잡히면 '의미 단위'로 청킹 → 임베딩 recall↑
 *  - 표는 "헤더=값"으로 선형화(kordoc linearizeTable) → 표도 임베딩됨
 *  - 임베딩이 약해도 BM25(키워드) + 섹션경로 컨텍스트로 보완
 *  - 매칭 시 '섹션 전문 + 인접 청크 원문'을 확장(expandContext) → 주변부 원문 기반 판정
 */
import type { IRBlock } from "kordoc";
import { config } from "./config";
import { parseDocument, loadKordoc } from "./parse-document";
import { normalizeWhitespace } from "./doc-text";

const RE_BYEOLJI = /별\s*표|별지\s*서식/;

/** 제어문자 제거 + 내부 줄바꿈/연속공백 → 단일 공백 */
function normalize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return normalizeWhitespace((s || "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ""));
}

export type ManualChunk = {
  id: string; // `${regId}|${groupIdx}|${subIdx}`
  regId: number;
  regName: string;
  /** 섹션 경로(예: ["제2장 임원", "제5조(임원의 책무)"]) */
  headingPath: string[];
  sectionId: string; // headingPath.join(" > ")
  type: "text" | "table";
  /** 임베딩/BM25용 — 섹션경로 + 본문 */
  text: string;
  /** 원문 본문(표시·컨텍스트 확장용) */
  body: string;
  pageNumber?: number;
  /** 별표/별지서식 등 LLM 요약이 도움되는 표 */
  needsSummary?: boolean;
  prevId?: string;
  nextId?: string;
};

/** 긴 섹션을 겹침 윈도우로 서브분할 (내규 조-청킹과 동일 원리, 단위만 '섹션') */
function subSplit(s: string, size: number, overlap: number): string[] {
  if (s.length <= size) return [s];
  const step = Math.max(1, size - overlap);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += step) out.push(s.slice(i, i + size));
  return out;
}

type Unit = {
  headingPath: string[];
  type: "text" | "table";
  text: string;
  pageNumber?: number;
  needsSummary?: boolean;
};

type Group = Unit;

// 조/항 라벨(번호 매김) 패턴 — '제N조/제N항/①/1./가.' 로 시작하는 짧은 라벨
const SECTION_LABEL = /^(제\s*\d+\s*조|제\s*\d+\s*항|[①-⑳]|[0-9]+\.\s|[가-힣]\.\s)/;

/**
 * kordoc가 조 '제목'과 '본문'을 각각 heading 으로 분리한 경우(HWP 흔함),
 * '제N조(…)' 라벨만 담긴 그룹에 바로 다음 본문 그룹을 흡수해 조 단위로 복원한다.
 * (라벨이 곧 섹션 제목인 그룹에만 적용 → 일반 본문 오병합 방지)
 */
function mergeLabelGroups(groups: Group[]): Group[] {
  const out: Group[] = [];
  for (const g of groups) {
    const prev = out[out.length - 1];
    const prevText = (prev?.text ?? "").trim();
    const prevLeaf = prev?.headingPath[prev.headingPath.length - 1] ?? "";
    if (
      prev &&
      prev.type === "text" &&
      g.type === "text" &&
      prevText.length <= 30 &&
      SECTION_LABEL.test(prevText) &&
      prevText === prevLeaf // 라벨이 곧 섹션 제목(= 조 제목만인 그룹)
    ) {
      prev.text = prevText + " " + g.text;
      if (g.pageNumber && !prev.pageNumber) prev.pageNumber = g.pageNumber;
    } else {
      out.push({ ...g });
    }
  }
  return out;
}

/**
 * blocks → 본문 유닛 스트림.
 *  - heading: 섹션 경로 갱신 + 헤딩 텍스트 자체도 본문 유닛으로 방출(조문이 heading 으로
 *    분류돼도 내용이 사라지지 않게)
 *  - paragraph/list: 현재 섹션 본문
 *  - table: linearizeTable 로 "헤더=값" 선형화
 */
function blocksToUnits(blocks: IRBlock[], linearize: (t: NonNullable<IRBlock["table"]>) => string): Unit[] {
  const path: { level: number; text: string }[] = [];
  const units: Unit[] = [];
  for (const b of blocks) {
    if (b.type === "heading" && b.text) {
      const level = b.level ?? 1;
      while (path.length && path[path.length - 1].level >= level) path.pop();
      path.push({ level, text: normalize(b.text) });
      units.push({ headingPath: path.map((p) => p.text), type: "text", text: normalize(b.text), pageNumber: b.pageNumber });
      continue;
    }
    if (b.type === "table" && b.table) {
      const text = linearize(b.table);
      if (!text) continue;
      const hp = path.map((p) => p.text);
      const needsSummary = hp.some((h) => RE_BYEOLJI.test(h)) || RE_BYEOLJI.test(text.slice(0, 40));
      units.push({ headingPath: hp, type: "table", text, pageNumber: b.pageNumber, needsSummary });
      continue;
    }
    if ((b.type === "paragraph" || b.type === "list") && b.text) {
      const text = normalize(b.text);
      if (text) units.push({ headingPath: path.map((p) => p.text), type: "text", text, pageNumber: b.pageNumber });
    }
  }
  return units;
}

/**
 * 매뉴얼형 내규 파일 → 섹션 청크.
 * regId: 코퍼스 식별자(파일 접두 번호 등). regName 미지정 시 문서 제목/파일명 사용.
 */
export async function manualToChunks(
  buffer: Buffer,
  fileName: string,
  regId: number,
  regName?: string
): Promise<ManualChunk[]> {
  const doc = await parseDocument(buffer, fileName);
  const k = await loadKordoc();
  const units = blocksToUnits(doc.blocks, k.linearizeTable);
  const name = regName || doc.title || fileName.replace(/\.[^.]+$/, "");

  // 같은 섹션의 연속 'text' 유닛을 한 그룹으로 병합. 표는 개별 청크 유지.
  const merged: Group[] = [];
  for (const u of units) {
    if (u.type === "table") {
      merged.push({ ...u });
      continue;
    }
    const sid = u.headingPath.join(" > ");
    const last = merged[merged.length - 1];
    if (last && last.type === "text" && last.headingPath.join(" > ") === sid) {
      last.text += "\n" + u.text;
      if (u.pageNumber && !last.pageNumber) last.pageNumber = u.pageNumber;
    } else {
      merged.push({ headingPath: u.headingPath, type: "text", text: u.text, pageNumber: u.pageNumber });
    }
  }
  const groups = mergeLabelGroups(merged);

  // 그룹 → 청크(긴 text 그룹은 overlap 서브분할), 섹션경로 컨텍스트 부착
  const chunks: ManualChunk[] = [];
  groups.forEach((g, gi) => {
    const sectionId = g.headingPath.join(" > ");
    const ctx = sectionId ? sectionId + "\n" : "";
    const parts = g.type === "text" ? subSplit(g.text, config.manualChunkSize, config.manualChunkOverlap) : [g.text];
    parts.forEach((body, pi) => {
      chunks.push({
        id: `${regId}|${gi}|${pi}`,
        regId,
        regName: name,
        headingPath: g.headingPath,
        sectionId,
        type: g.type,
        text: (ctx + body).slice(0, 2000),
        body,
        pageNumber: g.pageNumber,
        needsSummary: g.needsSummary,
      });
    });
  });

  // 순서 기반 인접 링크
  chunks.forEach((c, i) => {
    c.prevId = chunks[i - 1]?.id;
    c.nextId = chunks[i + 1]?.id;
  });
  return chunks;
}

/**
 * 컨텍스트 확장 — 매칭된 청크의 '섹션 전문 + 인접 청크 원문'을 복원.
 * 비정형 문서는 한 청크만으로 판정이 부족하므로 주변부 원문을 함께 LLM에 제공한다.
 */
export function expandContext(
  chunks: ManualChunk[],
  matchedId: string,
  neighbors = 1
): { headingPath: string[]; text: string } {
  const idx = chunks.findIndex((c) => c.id === matchedId);
  if (idx < 0) return { headingPath: [], text: "" };
  const m = chunks[idx];

  // 1) 같은 섹션 전체 본문
  const sameSection = chunks.filter((c) => c.sectionId === m.sectionId);
  const sectionText = sameSection.map((c) => c.body).join("\n");

  // 2) 인접 청크(섹션 경계 보완) — 섹션에 이미 포함된 건 제외
  const inSection = new Set(sameSection.map((c) => c.id));
  const around: string[] = [];
  for (let i = idx - neighbors; i <= idx + neighbors; i++) {
    const c = chunks[i];
    if (c && !inSection.has(c.id)) around.push(c.body);
  }

  const text = [sectionText, ...around].filter(Boolean).join("\n---\n");
  return { headingPath: m.headingPath, text };
}
