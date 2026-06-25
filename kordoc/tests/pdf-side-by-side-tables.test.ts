import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectClusterTables, type ClusterItem } from "../src/pdf/cluster-detector.js"

function item(text: string, x: number, y: number, w = 30, fontSize = 10): ClusterItem {
  return { text, x, y, w, h: fontSize, fontSize, fontName: "Test" }
}

// P1: 2단 레이아웃에서 좌측 표와 우측 표가 같은 Y에 정렬되면
// groupByBaseline이 전폭을 한 행으로 묶어 한 표로 병합되던 문제.
describe("좌우 나란한 별개 표 분리 (P1)", () => {
  it("같은 Y에 정렬된 좌/우 3열 표 → 2개의 독립 표로 분리, 좌→우 순서", () => {
    const items: ClusterItem[] = []
    const leftCols = [50, 150, 250]
    const rightCols = [450, 550, 650]
    const rowsL = [["구분", "당기", "전기"], ["자산총계", "176822", "167573"],
      ["부채총계", "58816", "57978"], ["자본총계", "118006", "109595"]]
    const rowsR = [["구분", "당기", "전기"], ["매출액", "73852", "57978"],
      ["매출총이익", "23413", "38159"], ["당기순이익", "12345", "23456"]]
    let y = 400
    for (let r = 0; r < rowsL.length; r++) {
      for (let c = 0; c < 3; c++) {
        items.push(item(rowsL[r][c], leftCols[c], y))
        items.push(item(rowsR[r][c], rightCols[c], y))
      }
      y -= 20
    }

    const res = detectClusterTables(items, 1)
    assert.equal(res.length, 2, "좌/우 표가 2개로 분리되어야 함")
    // 좌→우 순서 (bbox.x 오름차순)
    assert.ok(res[0].bbox.x < res[1].bbox.x, "첫 표가 더 왼쪽이어야 함")
    assert.equal(res[0].table.cols, 3)
    assert.equal(res[1].table.cols, 3)
    // 한 행에 좌우 데이터가 섞이지 않아야 함
    const leftFlat = res[0].table.cells.flat().map(c => c.text)
    assert.ok(leftFlat.includes("자산총계"), "왼쪽 표에 재무상태표 항목")
    assert.ok(!leftFlat.includes("매출액"), "왼쪽 표에 손익계산서 항목이 섞이면 안 됨")
    const rightFlat = res[1].table.cells.flat().map(c => c.text)
    assert.ok(rightFlat.includes("매출액"), "오른쪽 표에 손익계산서 항목")
    assert.ok(!rightFlat.includes("자산총계"), "오른쪽 표에 재무상태표 항목이 섞이면 안 됨")
  })

  it("단일 와이드 표(5열 균등 간격)는 분할되지 않음 (회귀 가드)", () => {
    const wide: ClusterItem[] = []
    const wcols = [50, 160, 270, 380, 490]
    const wrows = [["항목", "2022", "2023", "2024", "2025"], ["매출", "100", "200", "300", "400"],
      ["이익", "10", "20", "30", "40"], ["자산", "11", "22", "33", "44"]]
    let y = 400
    for (let r = 0; r < wrows.length; r++) {
      for (let c = 0; c < 5; c++) wide.push(item(wrows[r][c], wcols[c], y))
      y -= 20
    }
    const res = detectClusterTables(wide, 1)
    assert.equal(res.length, 1, "균등 간격 와이드 표는 하나로 유지되어야 함")
    assert.equal(res[0].table.cols, 5)
  })
})
