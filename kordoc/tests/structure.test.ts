import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectLegalStructure, legalStructureLevel } from "../src/structure.js"
import type { IRBlock } from "../src/types.js"

const para = (text: string): IRBlock => ({ type: "paragraph", text })

// 포맷 공용 법령 구조 후처리 (HWP5/HWPX/PDF 모두 사용)
describe("detectLegalStructure (포맷 공용)", () => {
  it("조문 제목/본문 분리 + heading 승격을 한 번에", () => {
    const out = detectLegalStructure([
      para("제1장 총칙"),
      para("제1조(목적) 이 규정은 …을 목적으로 한다."),
      para("[별지서식 1] 신청서"),
      para("부칙"),
    ])
    // 제1장 → H2
    assert.equal(out[0].type, "heading"); assert.equal(out[0].level, 2)
    // 제1조(목적) → H3 + 본문 분리
    assert.equal(out[1].type, "heading"); assert.equal(out[1].text, "제1조(목적)")
    assert.equal(out[2].type, "paragraph"); assert.match(out[2].text, /목적으로 한다/)
    // 별지서식 → H2, 부칙 → H2
    assert.equal(out.find(b => b.text === "[별지서식 1] 신청서").type, "heading")
    assert.equal(out.find(b => b.text === "부칙").type, "heading")
  })

  it("비규정 문장은 heading으로 만들지 않음 (과적합 방지)", () => {
    const out = detectLegalStructure([
      para("본 제안서는 AI 솔루션 도입을 제안합니다."),
      para("제22조 및 관련 규정에 따라 처리한다."), // 조문 참조(분리/승격 안 함)
      para("회사는 다음과 같이 운영한다."),
    ])
    assert.ok(out.every(b => b.type === "paragraph"), "일반 문장·참조는 본문 유지")
  })

  it("이미 heading인 블록은 보존", () => {
    const h: IRBlock = { type: "heading", level: 1, text: "큰 제목" }
    const out = detectLegalStructure([h])
    assert.equal(out[0].level, 1)
  })

  it("legalStructureLevel: 장/조/별표/별지/부칙", () => {
    assert.equal(legalStructureLevel("제2장 임원"), 2)
    assert.equal(legalStructureLevel("제5조(책무)"), 3)
    assert.equal(legalStructureLevel("[별표 1] 가액표"), 2)
    assert.equal(legalStructureLevel("부칙"), 2)
    assert.equal(legalStructureLevel("일반 문장입니다"), 0)
  })
})
