/**
 * VLM(Vision-Language Model) 기반 OCR 프로바이더.
 *
 * OpenAI 호환 `/v1/chat/completions` 멀티모달 엔드포인트(vLLM, Ollama, OpenAI,
 * Gemma/Qwen-VL 등)에 스캔 페이지 이미지를 보내, 한국어 표/양식(별표·별지서식)을
 * 구조화된 Markdown으로 복원한다. 단순 텍스트 OCR보다 표·계층 보존에 강하다.
 *
 * kordoc은 VLM을 번들하지 않는다 — 이 팩토리는 `OcrProvider` 함수를 반환하므로
 * `parse(buf, { ocr: createVlmOcrProvider({...}) })`로 주입한다.
 *
 * @example
 * ```ts
 * import { parse, createVlmOcrProvider } from "kordoc"
 * const ocr = createVlmOcrProvider({
 *   endpoint: "http://localhost:8000/v1/chat/completions",
 *   model: "google/gemma-4-26B-A4B-it",
 * })
 * const result = await parse(pdfBuffer, { ocr })
 * ```
 */

import type { OcrProvider } from "../types.js"

export interface VlmOcrConfig {
  /** OpenAI 호환 chat/completions 엔드포인트 URL */
  endpoint: string
  /** 모델 ID */
  model: string
  /** API 키 (필요 시 Authorization: Bearer) */
  apiKey?: string
  /** 프롬프트 오버라이드 (기본: 한국어 구조화 Markdown 복원) */
  prompt?: string
  /** 생성 토큰 상한 (기본 2048) */
  maxTokens?: number
  /** 요청 타임아웃 ms (기본 120000) */
  timeoutMs?: number
  /** fetch 구현 주입 (테스트/커스텀 런타임용, 기본 global fetch) */
  fetchImpl?: typeof fetch
}

const DEFAULT_PROMPT =
  "이 스캔 문서 이미지의 내용을 한국어 GitHub-flavored Markdown으로 정확히 복원해줘. " +
  "표는 Markdown 표로(병합셀은 내용 반복), 제목/조항/항목 계층(#, -, 번호)도 살려줘. " +
  "원문에 없는 설명·머리말은 붙이지 말고 복원 결과만 출력해."

/** VLM 기반 OcrProvider 생성. 반환 함수는 페이지 이미지를 받아 Markdown 문자열을 돌려준다. */
export function createVlmOcrProvider(config: VlmOcrConfig): OcrProvider {
  const {
    endpoint, model, apiKey,
    prompt = DEFAULT_PROMPT,
    maxTokens = 2048,
    timeoutMs = 120000,
    fetchImpl = fetch,
  } = config

  if (!endpoint) throw new Error("createVlmOcrProvider: endpoint가 필요합니다")
  if (!model) throw new Error("createVlmOcrProvider: model이 필요합니다")

  return async (pageImage: Uint8Array, _pageNumber: number, mimeType: "image/png"): Promise<string> => {
    const b64 = Buffer.from(pageImage).toString("base64")
    const body = {
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${b64}` } },
        ],
      }],
      max_tokens: maxTokens,
      temperature: 0,
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const res = await fetchImpl(endpoint, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`VLM 요청 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`)
      }
      const json = await res.json() as {
        choices?: { message?: { content?: string } }[]
      }
      return json.choices?.[0]?.message?.content?.trim() ?? ""
    } finally {
      clearTimeout(timer)
    }
  }
}
