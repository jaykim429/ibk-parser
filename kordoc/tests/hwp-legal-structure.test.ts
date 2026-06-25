import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { legalStructureLevel, splitArticleHeadings } from "../src/hwp5/parser.js"
import type { IRBlock } from "../src/types.js"

// 법령 구조 heading 인식 (코퍼스 129개 HWP 측정 기반):
// 장/절/별표는 이미 100%였고, 부칙(49%)·별지서식(11%)이 누락되어 보강.
describe("legalStructureLevel (법령 구조 heading 인식)", () => {
  it("제N장 → H2", () => {
    assert.equal(legalStructureLevel("제1장 총칙"), 2)
    assert.equal(legalStructureLevel("제5장 기관전용사모펀드 일반사무 및 자산보관"), 2)
  })
  it("제N절 → H2", () => {
    assert.equal(legalStructureLevel("제2절 이해충돌의 관리"), 2)
  })
  it("제N조(제목) → H3", () => {
    assert.equal(legalStructureLevel("제1조(목적)"), 3)
    assert.equal(legalStructureLevel("제7조의2(안전관리)"), 3)
  })
  it("삭제된(폐지) 조문 stub도 H3 (구조 슬롯 유지)", () => {
    assert.equal(legalStructureLevel("제13조 삭제<2006.6.30.>"), 3)
    assert.equal(legalStructureLevel("제4조의2 삭제<2023.9.26.>"), 3)
    // '삭제'로 시작하는 일반 문장은 아님
    assert.equal(legalStructureLevel("제13조에 따라 삭제한다"), 0)
  })
  it("[별표 N] 라벨 → H2", () => {
    assert.equal(legalStructureLevel("[별표 1] 음식물·경조사비·선물 등의 가액 범위(제26조 관련)"), 2)
    assert.equal(legalStructureLevel("별표 2 외부강의등 사례금 기준"), 2)
  })
  it("[별지서식 N] 라벨 → H2 (이전엔 11%만 인식)", () => {
    assert.equal(legalStructureLevel("[별지서식 1] 이해충돌금지확약서"), 2)
    assert.equal(legalStructureLevel("[별지서식 11] 외부강의등 신고서<개정 2018.3.9.>"), 2)
  })
  it("부칙 → H2 (이전엔 49%만 인식)", () => {
    assert.equal(legalStructureLevel("부칙"), 2)
    assert.equal(legalStructureLevel("부칙 <2024.8.27.>"), 2)
    assert.equal(legalStructureLevel("부칙(2022.5.24.)"), 2)
  })

  // ─── 회귀 가드: 본문/참조가 heading으로 오인되면 안 됨 ───
  it("본문 중 조문 참조나 일반 문장은 heading 아님", () => {
    assert.equal(legalStructureLevel("이 규정은 제5조에 따라 적용한다."), 0)
    assert.equal(legalStructureLevel("별표에서 정하는 바에 따른다."), 0) // 숫자 없는 '별표'
    assert.equal(legalStructureLevel("부칙에서 정한 시행일을 따른다"), 0) // '부칙' 뒤 조사
  })
  it("너무 긴 줄(제목+본문 혼합)은 보수적으로 제외", () => {
    assert.equal(legalStructureLevel("제1조(목적) " + "가".repeat(120)), 0)
  })
})

const para = (text: string): IRBlock => ({ type: "paragraph", text, pageNumber: 1 })

// "제N조(제목) 본문…" 한 문단 → heading + 본문 분리 (코퍼스 제N조 75%→98%)
describe("splitArticleHeadings (조문 제목/본문 분리)", () => {
  it("제목+본문 한 문단을 heading(H3)+paragraph로 분리", () => {
    const out = splitArticleHeadings([para("제1조(목적) 이 규정은 자산관리를 위한 것이다.")])
    assert.equal(out.length, 2)
    assert.equal(out[0].type, "heading")
    assert.equal(out[0].level, 3)
    assert.equal(out[0].text, "제1조(목적)")
    assert.equal(out[1].type, "paragraph")
    assert.equal(out[1].text, "이 규정은 자산관리를 위한 것이다.")
  })

  it("제N조의N(제목)도 분리", () => {
    const out = splitArticleHeadings([para("제7조의2(안전관리) ① 사업을 수행한다.")])
    assert.equal(out[0].text, "제7조의2(안전관리)")
    assert.equal(out[1].text, "① 사업을 수행한다.")
  })

  it("긴 제목(최대 80자)도 분리 — 제53조의3 등 정관의 긴 조문명", () => {
    const long = "제53조의3(중소기업금융채권 및 상각형 조건부자본증권에 표시되어야 할 권리의 전자등록) 당은행은 채권을 전자등록한다."
    const out = splitArticleHeadings([para(long)])
    assert.equal(out.length, 2)
    assert.equal(out[0].type, "heading")
    assert.ok(out[0].text.startsWith("제53조의3("))
  })

  it("본문이 조사/접속사로 시작하면(문장 중 참조) 분리하지 않음", () => {
    const ref = "제5조(책무)에 따라 임직원은 성실히 수행한다."
    const out = splitArticleHeadings([para(ref)])
    assert.equal(out.length, 1)
    assert.equal(out[0].type, "paragraph")
    assert.equal(out[0].text, ref)
  })

  it("제목만 있는 문단(본문 없음)은 건드리지 않음 (detectHwp5Headings가 처리)", () => {
    const out = splitArticleHeadings([para("제1조(목적)")])
    assert.equal(out.length, 1)
    assert.equal(out[0].type, "paragraph")
  })

  it("표/heading 블록은 그대로 통과", () => {
    const t: IRBlock = { type: "table", table: { rows: 1, cols: 1, cells: [[{ text: "x", colSpan: 1, rowSpan: 1 }]], hasHeader: false }, pageNumber: 1 }
    const out = splitArticleHeadings([t])
    assert.equal(out.length, 1)
    assert.equal(out[0].type, "table")
  })
})
