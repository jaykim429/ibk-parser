import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { toSearchChunks, toSearchText, linearizeTable } from "../src/search/optimize.js"
import { summarizeChunks } from "../src/search/summarizer.js"
import type { IRBlock, IRTable } from "../src/types.js"

const h = (text: string, level: number): IRBlock => ({ type: "heading", text, level })
const p = (text: string): IRBlock => ({ type: "paragraph", text })
const tbl = (cells: string[][], hasHeader = true): IRBlock => ({
  type: "table",
  table: {
    rows: cells.length, cols: cells[0].length, hasHeader,
    cells: cells.map(row => row.map(t => ({ text: t, colSpan: 1, rowSpan: 1 }))),
  },
})

describe("toSearchChunks (검색 최적화)", () => {
  it("문단 내부 줄바꿈을 공백으로 정규화", () => {
    const chunks = toSearchChunks([p("첫째 줄\n둘째 줄\n셋째 줄")])
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].text, "첫째 줄 둘째 줄 셋째 줄")
  })

  it("섹션 경로(장>조)를 청크에 부착", () => {
    const chunks = toSearchChunks([
      h("제2장 임원", 2), h("제5조(책무)", 3), p("임원은 성실히 수행한다."),
    ])
    assert.deepEqual(chunks[0].headingPath, ["제2장 임원", "제5조(책무)"])
  })

  it("같은 레벨 heading은 경로에서 교체 (누적 아님)", () => {
    const chunks = toSearchChunks([
      h("제1조(목적)", 3), p("가"), h("제2조(정의)", 3), p("나"),
    ])
    assert.deepEqual(chunks[0].headingPath, ["제1조(목적)"])
    assert.deepEqual(chunks[1].headingPath, ["제2조(정의)"])
  })

  it("표 선형화: 헤더=값 형태", () => {
    const out = linearizeTable(tbl([["구분", "가액"], ["음식물", "5만원"], ["선물", "5만원"]]).table as IRTable)
    assert.match(out, /구분=음식물, 가액=5만원/)
    assert.match(out, /구분=선물, 가액=5만원/)
  })

  it("별표/별지서식 표는 needsSummary 표시", () => {
    const chunks = toSearchChunks([
      h("[별표 1] 가액 범위", 2), tbl([["구분", "가액"], ["음식물", "5만원"]]),
    ])
    const t = chunks.find(c => c.type === "table")
    assert.equal(t.needsSummary, true)
  })

  it("일반 표는 needsSummary 아님", () => {
    const chunks = toSearchChunks([h("제3조(조직)", 3), tbl([["부서", "인원"], ["총무", "5"]])])
    assert.equal(chunks.find(c => c.type === "table").needsSummary, undefined)
  })

  it("toSearchText: 청크가 빈 줄로 구분되고 경로가 머리에 붙음", () => {
    const text = toSearchText([h("제1조(목적)", 3), p("이 규정은…")])
    assert.match(text, /제1조\(목적\)\n이 규정은…/)
  })
})

describe("summarizeChunks (별표/별지 LLM 요약 부착)", () => {
  it("needsSummary 청크만 요약기를 호출하고 summary를 채운다", async () => {
    // 현실적 순서: 조문(표) 먼저, 별표/별지서식은 문서 끝
    const chunks = toSearchChunks([
      h("제3조(조직)", 3), tbl([["부서", "인원"], ["총무", "5"]]),
      h("[별지서식 1] 신청서", 2), tbl([["성명", "직위"], ["x", "y"]]),
    ])
    let calls = 0
    const summarizer = async () => { calls++; return "신청서 양식 요약" }
    const enriched = await summarizeChunks(chunks, summarizer)
    assert.equal(calls, 1, "별지서식 표 1개만 요약")
    const byeolji = enriched.find(c => c.needsSummary)
    assert.equal(byeolji.summary, "신청서 양식 요약")
    // 원본 불변
    assert.equal(chunks.find(c => c.needsSummary).summary, undefined)
  })

  it("요약기 실패는 조용히 건너뛴다", async () => {
    const chunks = toSearchChunks([h("[별표 1] x", 2), tbl([["a", "b"], ["1", "2"]])])
    const summarizer = async () => { throw new Error("LLM down") }
    const enriched = await summarizeChunks(chunks, summarizer)
    assert.equal(enriched.find(c => c.needsSummary).summary, undefined)
  })
})
