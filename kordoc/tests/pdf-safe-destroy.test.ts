import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { safeDestroy } from "../src/pdf/parser.js"

// P2 회귀: pdfjs v5/v6에서 정리 API 시그니처가 바뀌어 `destroy`가 없을 때
// `doc.destroy is not a function` 동기 TypeError로 정상 파싱까지 가려지던 문제.
// safeDestroy는 메서드 유무를 검사해 어떤 경우에도 throw하지 않아야 한다.
describe("safeDestroy (P2 pdfjs 버전 안전 정리)", () => {
  it("destroy()가 있으면 호출한다", async () => {
    let called = false
    await safeDestroy({ destroy: () => { called = true } })
    assert.equal(called, true)
  })

  it("async destroy()를 await한다", async () => {
    let resolved = false
    await safeDestroy({ destroy: async () => { await Promise.resolve(); resolved = true } })
    assert.equal(resolved, true)
  })

  it("destroy()가 없고 cleanup()만 있으면 cleanup을 호출한다 (v5/v6 대비)", async () => {
    let called = false
    await safeDestroy({ cleanup: () => { called = true } })
    assert.equal(called, true)
  })

  it("destroy/cleanup 둘 다 없어도 throw하지 않는다 (핵심 회귀 가드)", async () => {
    await assert.doesNotReject(() => safeDestroy({}))
    await assert.doesNotReject(() => safeDestroy(null))
    await assert.doesNotReject(() => safeDestroy(undefined))
  })

  it("destroy()가 내부에서 throw해도 삼킨다", async () => {
    await assert.doesNotReject(() => safeDestroy({ destroy: () => { throw new Error("boom") } }))
  })

  it("destroy()가 reject해도 삼킨다", async () => {
    await assert.doesNotReject(() => safeDestroy({ destroy: () => Promise.reject(new Error("boom")) }))
  })
})
