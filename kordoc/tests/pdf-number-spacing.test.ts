import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { collapseNumberSpacing } from "../src/pdf/parser.js"

// P3: 한컴 계열 PDF 자간 균등배분이 숫자/쉼표 사이에 공백을 흩뿌리는 문제.
// 셀 단위로만 적용 — 본문 산문은 collapseNumberSpacing을 거치지 않는다.
describe("collapseNumberSpacing (P3 숫자 공백 복원)", () => {
  it("쉼표 양옆 공백 제거: 176 , 822 → 176,822", () => {
    assert.equal(collapseNumberSpacing("176 , 822"), "176,822")
    assert.equal(collapseNumberSpacing("7 , 385"), "7,385")
    assert.equal(collapseNumberSpacing("57 , 978"), "57,978")
  })

  it("연쇄 쉼표 그룹: 1 , 234 , 567 → 1,234,567", () => {
    assert.equal(collapseNumberSpacing("1 , 234 , 567"), "1,234,567")
  })

  it("이미 정상인 숫자는 그대로 유지", () => {
    assert.equal(collapseNumberSpacing("176,822"), "176,822")
    assert.equal(collapseNumberSpacing("1234567"), "1234567")
  })

  it("음수: - 58 , 816 → -58,816", () => {
    assert.equal(collapseNumberSpacing("- 58 , 816"), "-58,816")
  })

  it("괄호 음수: (- 58 , 816) → (-58,816)", () => {
    assert.equal(collapseNumberSpacing("(- 58 , 816)"), "(-58,816)")
  })

  // ─── 회귀 방지: 본문성 텍스트가 잘못 붙거나 깨지지 않아야 함 ───

  it("날짜는 건드리지 않음 (쉼표 없음): 2026년 12월 31일", () => {
    assert.equal(collapseNumberSpacing("2026년 12월 31일"), "2026년 12월 31일")
  })

  it("조문 번호는 건드리지 않음: 제363조", () => {
    assert.equal(collapseNumberSpacing("제363조"), "제363조")
  })

  it("분리된 값 나열은 붙이지 않음 (천단위 무쉼표 병합 미적용): 100 200 300", () => {
    assert.equal(collapseNumberSpacing("100 200 300"), "100 200 300")
  })

  it("범위 표기(중간 하이픈)는 음수로 오인하지 않음: 10 - 20", () => {
    assert.equal(collapseNumberSpacing("10 - 20"), "10 - 20")
  })

  it("쉼표 뒤 비숫자는 건드리지 않음: 가, 나, 다", () => {
    assert.equal(collapseNumberSpacing("가, 나, 다"), "가, 나, 다")
  })
})
