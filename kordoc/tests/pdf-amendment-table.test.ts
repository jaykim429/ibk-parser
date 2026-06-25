import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectAmendmentTable } from "../src/pdf/parser.js"

// NormItem 형태 최소 구성 (detectAmendmentTable은 text/x/y/w만 사용)
function it_(text: string, x: number, y: number, w = 60): unknown {
  return { text, x, y, w, h: 12, fontSize: 12, fontName: "T", isHidden: false }
}

// 국회 일부개정법률안 신구조문대비표: "현 행 | 개 정 안" 2단 → 깨끗한 2열 복원
describe("detectAmendmentTable (신구조문대비표 2단 재구성)", () => {
  function billPage(): unknown[] {
    const items: unknown[] = []
    // 제목 (중앙)
    items.push(it_("신ㆍ구조문대비표", 230, 760, 90))
    // 헤더: 현 행(좌) | 개 정 안(우)
    items.push(it_("현", 144, 740), it_("행", 214, 740))
    items.push(it_("개", 368, 740, 20), it_("정", 403, 740, 20), it_("안", 438, 740, 20))
    // 본문 4줄 (좌 x≈90, 우 x≈320)
    let y = 700
    const L = ["제51조(처분 등) ① 금융위원회는", "다음 각 호에 해당하는 경우", "등록을 취소할 수 있다.", "1. ~ 3. (생 략)"]
    const R = ["제51조(처분 등) ① 금융감독위원회", "------------------------", "------------------------", "1. ~ 3. (현행과 같음)"]
    for (let i = 0; i < L.length; i++) {
      items.push(it_(L[i], 90, y, 200))
      items.push(it_(R[i], 320, y, 200))
      y -= 18
    }
    return items
  }

  it("현행/개정안 헤더 + 중앙 거터로 2열 표 생성", () => {
    const out = detectAmendmentTable(billPage() as never, 7)
    assert.ok(out && out.length === 1, "대비표 블록 1개")
    const t = out[0].table
    assert.equal(t.cols, 2, "2열")
    assert.deepEqual(t.cells[0].map(c => c.text), ["현행", "개정안"], "헤더 정규화")
    // 좌측=현행, 우측=개정안 분리 확인
    const flatL = t.cells.slice(1).map(r => r[0].text).join(" ")
    const flatR = t.cells.slice(1).map(r => r[1].text).join(" ")
    assert.match(flatL, /금융위원회는/, "좌측에 현행 내용")
    assert.match(flatR, /금융감독위원회/, "우측에 개정 내용")
    assert.ok(!flatL.includes("금융감독위원회"), "좌우가 섞이지 않음")
  })

  it("대비표 시그니처 없으면 null (오탐 방지)", () => {
    const plain = [
      it_("일반 문단입니다.", 90, 700, 200),
      it_("두 번째 문단입니다.", 90, 680, 200),
      it_("세 번째 문단.", 90, 660, 200),
      it_("네 번째.", 90, 640, 200),
      it_("다섯.", 90, 620), it_("여섯.", 90, 600), it_("일곱.", 90, 580), it_("여덟.", 90, 560),
    ]
    assert.equal(detectAmendmentTable(plain as never, 1), null)
  })

  it("단일 컬럼(거터 없음)은 null", () => {
    const items: unknown[] = []
    let y = 700
    for (let i = 0; i < 10; i++) { items.push(it_(`제${i + 1}조 현행 개정안 (생 략) 내용`, 90, y, 300)); y -= 18 }
    assert.equal(detectAmendmentTable(items as never, 1), null)
  })
})
