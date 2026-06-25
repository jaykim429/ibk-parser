import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mergeAdjacentTableBlocks } from "../src/pdf/parser.js"
import type { IRBlock, IRTable, BoundingBox } from "../src/types.js"

function tableBlock(cols: number, rows: number, bbox: BoundingBox, tag: string): IRBlock {
  const cells = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => ({ text: `${tag}${r}${c}`, colSpan: 1, rowSpan: 1 })),
  )
  const table: IRTable = { rows, cols, cells, hasHeader: false }
  return { type: "table", table, pageNumber: 1, bbox }
}

// P1: mergeAdjacentTableBlocks는 열 수가 같아도 X구간이 거의 겹치지 않으면(좌우 나란히)
// 병합하지 않아야 한다. 세로로 이어진(X구간 겹치는) 표는 기존대로 병합.
describe("mergeAdjacentTableBlocks X중첩 가드 (P1)", () => {
  it("좌우 나란한 동일 열수 표는 병합하지 않음", () => {
    const left = tableBlock(3, 4, { page: 1, x: 50, y: 300, width: 200, height: 80 }, "L")
    const right = tableBlock(3, 4, { page: 1, x: 450, y: 300, width: 200, height: 80 }, "R")
    const result = mergeAdjacentTableBlocks([left, right])
    assert.equal(result.length, 2, "X구간이 분리된 좌우 표는 별개로 유지")
  })

  it("세로로 이어진 동일 열수 표는 병합함 (회귀 가드)", () => {
    const top = tableBlock(3, 4, { page: 1, x: 50, y: 300, width: 200, height: 80 }, "T")
    const bottom = tableBlock(3, 3, { page: 1, x: 52, y: 200, width: 196, height: 60 }, "B")
    const result = mergeAdjacentTableBlocks([top, bottom])
    assert.equal(result.length, 1, "X구간이 겹치는 세로 연속 표는 병합")
    assert.equal(result[0].table!.rows, 7, "행 수가 합산되어야 함")
  })

  it("bbox가 없으면 기존 동작(열수 일치 시 병합) 보존", () => {
    const a = tableBlock(2, 2, undefined as unknown as BoundingBox, "A")
    const b = tableBlock(2, 2, undefined as unknown as BoundingBox, "B")
    delete (a as { bbox?: BoundingBox }).bbox
    delete (b as { bbox?: BoundingBox }).bbox
    const result = mergeAdjacentTableBlocks([a, b])
    assert.equal(result.length, 1, "bbox 없으면 병합 (보수적 기존 동작)")
  })
})
