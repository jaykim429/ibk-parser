/**
 * 한국 법령/규정 문서의 공통 구조(제목·장·절·조·부칙·별표·별지서식) 인식.
 *
 * 포맷 무관(HWP5/HWPX/PDF/DOCX) — 콘텐츠 패턴 기반이므로 모든 파서가 공유한다.
 * outlineLevel·스타일·좌표로 잡지 못한 구조 요소를 마크다운 heading으로 승격하고,
 * "제N조(제목) 본문…"이 한 문단에 합쳐진 경우 제목/본문을 분리한다.
 */

import type { IRBlock } from "./types.js"

const ARTICLE_HEAD = /^(제\s*\d+\s*조(?:의\s*\d+)?\s*\([^)]*\))\s*(\S[\s\S]*)$/
const REF_TAIL = /^(에|에서|을|를|와|과|및|또는|으로|로|부터|까지|이라|라는)\s/

/**
 * "제N조(제목) 본문…" 한 문단을 제목(H3)+본문(paragraph)으로 분리.
 * 본문이 조사/접속사로 시작하면(문장 중 조문 참조) 분리하지 않는다.
 */
export function splitArticleHeadings(blocks: IRBlock[]): IRBlock[] {
  const out: IRBlock[] = []
  for (const b of blocks) {
    if (b.type === "paragraph" && b.text) {
      const m = b.text.match(ARTICLE_HEAD)
      if (m && m[1].length <= 80 && m[2] && !REF_TAIL.test(m[2])) {
        out.push({ ...b, type: "heading", level: 3, text: m[1].replace(/\s+/g, " ").trim() })
        out.push({ ...b, text: m[2] })
        continue
      }
    }
    out.push(b)
  }
  return out
}

/**
 * 법령 구조 패턴 → heading 레벨. heading 아니면 0.
 *  - 제N장/절/편 → H2,  제N조(…)/제N조 삭제 → H3
 *  - [별표 N] / [별지서식 N] 라벨 줄 → H2,  부칙 → H2
 */
export function legalStructureLevel(text: string): number {
  const t = text.trim()
  if (/^제\d+[장절편]\s/.test(t) && t.length <= 50) return 2
  if (/^제\d+(조의?\d*)\s*[(（]/.test(t) && t.length <= 80) return 3
  // 삭제된(폐지) 조문 stub: "제13조 삭제<2006.6.30.>" — 구조상 조문 슬롯 유지
  if (/^제\s*\d+\s*조(의\s*\d+)?\s+삭\s*제(\s|<|$)/.test(t)) return 3
  if (/^\[?\s*별\s*표\s*\d/.test(t) && t.length <= 120) return 2
  if (/^\[?\s*별지\s*서식\s*\d/.test(t) && t.length <= 120) return 2
  if (/^부\s*칙(\s|$|[<(［【])/.test(t) && t.length <= 60) return 2
  return 0
}

/**
 * 포맷 공용 법령 구조 후처리: 조문 제목/본문 분리 + 구조 패턴 heading 승격.
 * 이미 heading인 블록은 건드리지 않는다. 새 배열을 반환한다.
 */
export function detectLegalStructure(blocks: IRBlock[]): IRBlock[] {
  const split = splitArticleHeadings(blocks)
  for (const b of split) {
    if (b.type !== "paragraph" || !b.text) continue
    if (b.text.length > 120) continue
    const lvl = legalStructureLevel(b.text)
    if (lvl > 0) { b.type = "heading"; b.level = lvl }
  }
  return split
}
