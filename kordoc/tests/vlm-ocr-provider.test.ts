import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createVlmOcrProvider } from "../src/ocr/vlm-provider.js"

// VLM OCR provider — 네트워크 없이 fetchImpl 주입으로 검증.
describe("createVlmOcrProvider", () => {
  it("이미지를 base64 data URL로 멀티모달 요청에 실어 보낸다", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null
    const fakeFetch = (async (url, init) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "| 구분 | 값 |\n| --- | --- |\n| A | 1 |" } }] }) } as Response
    }) as typeof fetch

    const ocr = createVlmOcrProvider({
      endpoint: "http://vlm.local/v1/chat/completions",
      model: "test-vlm",
      apiKey: "k",
      fetchImpl: fakeFetch,
    })
    const out = await ocr(new Uint8Array([1, 2, 3]), 1, "image/png")

    assert.match(out, /구분 \| 값/, "VLM이 돌려준 Markdown 표를 반환")
    assert.equal(captured.url, "http://vlm.local/v1/chat/completions")
    assert.equal(captured.body.model, "test-vlm")
    const content = captured.body.messages[0].content
    assert.equal(content[1].type, "image_url")
    assert.match(content[1].image_url.url, /^data:image\/png;base64,/, "data URL로 이미지 첨부")
  })

  it("HTTP 에러는 명확한 메시지로 throw", async () => {
    const fakeFetch = (async () => ({ ok: false, status: 500, text: async () => "boom" }) as Response) as typeof fetch
    const ocr = createVlmOcrProvider({ endpoint: "http://x/v1", model: "m", fetchImpl: fakeFetch })
    await assert.rejects(() => ocr(new Uint8Array([0]), 1, "image/png"), /VLM 요청 실패 \(500\)/)
  })

  it("endpoint/model 누락 시 생성 단계에서 throw", () => {
    assert.throws(() => createVlmOcrProvider({ endpoint: "", model: "m" }), /endpoint/)
    assert.throws(() => createVlmOcrProvider({ endpoint: "u", model: "" }), /model/)
  })

  it("choices가 비면 빈 문자열 반환", async () => {
    const fakeFetch = (async () => ({ ok: true, json: async () => ({}) }) as Response) as typeof fetch
    const ocr = createVlmOcrProvider({ endpoint: "http://x/v1", model: "m", fetchImpl: fakeFetch })
    assert.equal(await ocr(new Uint8Array([0]), 1, "image/png"), "")
  })
})
