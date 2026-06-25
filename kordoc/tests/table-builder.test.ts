import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildTable, blocksToMarkdown, convertTableToText } from "../src/table/builder.js"
import type { CellContext, IRBlock } from "../src/types.js"

describe("buildTable", () => {
  it("기본 2x2 테이블 빌드", () => {
    const rows: CellContext[][] = [
      [{ text: "A", colSpan: 1, rowSpan: 1 }, { text: "B", colSpan: 1, rowSpan: 1 }],
      [{ text: "C", colSpan: 1, rowSpan: 1 }, { text: "D", colSpan: 1, rowSpan: 1 }],
    ]
    const table = buildTable(rows)
    assert.equal(table.rows, 2)
    assert.equal(table.cols, 2)
    assert.equal(table.cells[0][0].text, "A")
    assert.equal(table.cells[1][1].text, "D")
    assert.equal(table.hasHeader, true)
  })

  it("colSpan 처리", () => {
    const rows: CellContext[][] = [
      [{ text: "merged", colSpan: 2, rowSpan: 1 }],
      [{ text: "C", colSpan: 1, rowSpan: 1 }, { text: "D", colSpan: 1, rowSpan: 1 }],
    ]
    const table = buildTable(rows)
    assert.equal(table.cols, 2)
    assert.equal(table.cells[0][0].text, "merged")
    assert.equal(table.cells[0][0].colSpan, 2)
  })

  it("rowSpan 처리", () => {
    const rows: CellContext[][] = [
      [{ text: "span", colSpan: 1, rowSpan: 2 }, { text: "B", colSpan: 1, rowSpan: 1 }],
      [{ text: "D", colSpan: 1, rowSpan: 1 }],
    ]
    const table = buildTable(rows)
    assert.equal(table.rows, 2)
    assert.equal(table.cols, 2)
    assert.equal(table.cells[0][0].text, "span")
    assert.equal(table.cells[0][0].rowSpan, 2)
    assert.equal(table.cells[1][1].text, "D")
  })

  it("빈 입력은 빈 테이블 반환", () => {
    const table = buildTable([])
    assert.equal(table.rows, 0)
    assert.equal(table.cols, 0)
  })

  it("1행 테이블의 hasHeader는 false", () => {
    const rows: CellContext[][] = [
      [{ text: "A", colSpan: 1, rowSpan: 1 }],
    ]
    const table = buildTable(rows)
    assert.equal(table.hasHeader, false)
  })
})

describe("blocksToMarkdown", () => {
  it("기본 paragraph 블록 변환 — 문단 사이 빈 줄 삽입", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "첫번째 문단" },
      { type: "paragraph", text: "두번째 문단" },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("첫번째 문단"))
    assert.ok(md.includes("두번째 문단"))
    // 문단 사이에 빈 줄(\n\n)이 있어야 마크다운에서 별도 문단으로 렌더링
    assert.ok(md.includes("첫번째 문단\n\n두번째 문단"))
  })

  it("colWidths가 있는 병합셀 표는 colgroup으로 원본 컬럼 비율 재현", () => {
    const blocks: IRBlock[] = [{
      type: "table",
      table: {
        rows: 2, cols: 3, hasHeader: true,
        colWidths: [2000, 6000, 2000], // 20% / 60% / 20%
        cells: [
          // 병합셀(colspan=2)이 있어야 HTML 표 경로 → colgroup 출력
          [{ text: "구분", colSpan: 1, rowSpan: 1 }, { text: "내용", colSpan: 2, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1 }],
          [{ text: "음식물", colSpan: 1, rowSpan: 1 }, { text: "식사 등", colSpan: 1, rowSpan: 1 }, { text: "5만원", colSpan: 1, rowSpan: 1 }],
        ],
      },
    }]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("<colgroup>"), `colgroup 출력: ${md}`)
    assert.ok(md.includes('width:20.0%'), `20% 컬럼: ${md}`)
    assert.ok(md.includes('width:60.0%'), `60% 컬럼: ${md}`)
  })

  it("셀 border(무테두리/굵은선)를 인라인 스타일로 렌더 (서식 충실)", () => {
    const blocks: IRBlock[] = [{
      type: "table",
      table: {
        rows: 2, cols: 2, hasHeader: true,
        cells: [
          [{ text: "A", colSpan: 2, rowSpan: 1, border: { top: 1, right: 1, bottom: 0, left: 1 } }, { text: "", colSpan: 1, rowSpan: 1 }],
          [{ text: "B", colSpan: 1, rowSpan: 1, border: { top: 2, right: 1, bottom: 1, left: 1 } }, { text: "C", colSpan: 1, rowSpan: 1, border: { top: 1, right: 1, bottom: 1, left: 1 } }],
        ],
      },
    }]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("border-bottom:none"), `무테두리 변: ${md}`)
    assert.ok(md.includes("border-top:2px solid"), `굵은선: ${md}`)
    // 전 변 1px인 셀 C는 인라인 스타일 생략(표 CSS 위임)
    assert.ok(!/C<\/t[dh]>/.test(md) || !md.includes('style="border-top:1px solid;border-right:1px solid;border-bottom:1px solid;border-left:1px solid"'),
      "기본 1px 셀은 스타일 생략")
  })

  it("colWidths 없으면 colgroup 미출력 (기존 동작)", () => {
    const blocks: IRBlock[] = [{
      type: "table",
      table: {
        rows: 2, cols: 2, hasHeader: true,
        cells: [
          [{ text: "A", colSpan: 1, rowSpan: 1 }, { text: "B", colSpan: 2, rowSpan: 1 }],
          [{ text: "C", colSpan: 1, rowSpan: 1 }, { text: "D", colSpan: 1, rowSpan: 1 }],
        ],
      },
    }]
    const md = blocksToMarkdown(blocks)
    assert.ok(!md.includes("<colgroup>"), "colWidths 없으면 colgroup 없음")
  })

  it("[별표 N] 패턴을 H2 헤더로 변환", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "[별표 1] 교육과정" },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("## [별표 1] 교육과정"))
  })

  it("[별표 N] + (관련) 패턴 병합", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "[별표 3]" },
      { type: "paragraph", text: "(제5조 관련)" },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("## [별표 3] (제5조 관련)"))
  })

  it("(조 관련) 패턴을 italic으로", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "(제10조제2항 관련)" },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("*(제10조제2항 관련)*"))
  })

  it("colSpan 병합 셀은 HTML <table>로 출력", () => {
    const blocks: IRBlock[] = [
      {
        type: "table",
        table: buildTable([
          [{ text: "병합셀", colSpan: 2, rowSpan: 1 }],
          [{ text: "값1", colSpan: 1, rowSpan: 1 }, { text: "값2", colSpan: 1, rowSpan: 1 }],
        ])
      },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("<table>"), "병합 테이블은 HTML로 출력")
    assert.ok(md.includes('colspan="2"'), "colSpan 속성 포함")
    assert.ok(md.includes("병합셀"), "병합 셀 텍스트 존재")
    assert.ok(md.includes("값1"))
    assert.ok(md.includes("값2"))
  })

  it("rowSpan 병합 셀은 HTML <table>로 출력", () => {
    const blocks: IRBlock[] = [
      {
        type: "table",
        table: buildTable([
          [{ text: "헤더1", colSpan: 1, rowSpan: 1 }, { text: "헤더2", colSpan: 1, rowSpan: 1 }],
          [{ text: "행병합", colSpan: 1, rowSpan: 2 }, { text: "값1", colSpan: 1, rowSpan: 1 }],
          [{ text: "값2", colSpan: 1, rowSpan: 1 }],
        ])
      },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("<table>"), "병합 테이블은 HTML로 출력")
    assert.ok(md.includes('rowspan="2"'), "rowSpan 속성 포함")
    assert.ok(md.includes("행병합"))
    assert.ok(md.includes("값2"))
  })

  it("수식이 있는 병합 표는 Markdown 표로 출력", () => {
    const blocks: IRBlock[] = [
      {
        type: "table",
        table: buildTable([
          [{ text: "각도($^\\circ$)", colSpan: 2, rowSpan: 1 }],
          [{ text: "값1", colSpan: 1, rowSpan: 1 }, { text: "$\\frac{1}{2}$", colSpan: 1, rowSpan: 1 }],
        ])
      },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(!md.includes("<table>"), "수식 렌더링을 위해 HTML table을 피함")
    assert.ok(md.includes("| 각도($^\\circ$) |  |"))
    assert.ok(md.includes("$\\frac{1}{2}$"))
  })

  it("일반 달러 기호만 있는 병합 표는 HTML <table>로 출력", () => {
    const blocks: IRBlock[] = [
      {
        type: "table",
        table: buildTable([
          [{ text: "예산 $5", colSpan: 2, rowSpan: 1 }],
          [{ text: "값1", colSpan: 1, rowSpan: 1 }, { text: "값2", colSpan: 1, rowSpan: 1 }],
        ])
      },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("<table>"), "일반 달러 표기는 병합 정보를 보존")
    assert.ok(md.includes('colspan="2"'))
  })

  it("테이블 블록을 마크다운 테이블로 변환", () => {
    const blocks: IRBlock[] = [
      {
        type: "table",
        table: buildTable([
          [{ text: "헤더1", colSpan: 1, rowSpan: 1 }, { text: "헤더2", colSpan: 1, rowSpan: 1 }],
          [{ text: "값1", colSpan: 1, rowSpan: 1 }, { text: "값2", colSpan: 1, rowSpan: 1 }],
        ])
      },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("| 헤더1 | 헤더2 |"))
    assert.ok(md.includes("| --- | --- |"))
    assert.ok(md.includes("| 값1 | 값2 |"))
  })
})

describe("convertTableToText", () => {
  it("기본 셀 텍스트를 슬래시로 연결 (외부 테이블 pipe 충돌 방지)", () => {
    const rows: CellContext[][] = [
      [{ text: "A", colSpan: 1, rowSpan: 1 }, { text: "B", colSpan: 1, rowSpan: 1 }],
      [{ text: "C", colSpan: 1, rowSpan: 1 }, { text: "D", colSpan: 1, rowSpan: 1 }],
    ]
    const text = convertTableToText(rows)
    assert.equal(text, "A / B\nC / D")
  })

  it("셀 내 pipe 문자는 이스케이프", () => {
    const rows: CellContext[][] = [
      [{ text: "A|B", colSpan: 1, rowSpan: 1 }, { text: "C", colSpan: 1, rowSpan: 1 }],
    ]
    const text = convertTableToText(rows)
    assert.equal(text, "A\\|B / C")
  })

  it("빈 셀은 필터링", () => {
    const rows: CellContext[][] = [
      [{ text: "A", colSpan: 1, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1 }],
    ]
    const text = convertTableToText(rows)
    assert.equal(text, "A")
  })
})
