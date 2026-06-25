/**
 * 검색 최적화용 표 요약기 — 별표/별지서식처럼 표 텍스트만으론 의미 검색이
 * 약한 블록에 대해 LLM으로 한국어 요약을 생성한다.
 *
 * OpenAI 호환 텍스트 chat/completions 엔드포인트를 사용. kordoc은 LLM을
 * 번들하지 않으므로 팩토리가 함수를 반환한다.
 *
 * @example
 * ```ts
 * import { parse } from "kordoc"
 * import { toSearchChunks, summarizeChunks, createLlmSummarizer } from "kordoc"
 * const { blocks } = await parse(buf)
 * const chunks = toSearchChunks(blocks)
 * const summarizer = createLlmSummarizer({ endpoint, model })
 * const enriched = await summarizeChunks(chunks, summarizer)
 * ```
 */

import type { SearchChunk } from "./optimize.js"
import { chunkToText } from "./optimize.js"

/** (표 텍스트, 섹션 경로) → 한국어 요약 1~2문장 */
export type TableSummarizer = (text: string, headingPath: string[]) => Promise<string>

export interface LlmSummarizerConfig {
  endpoint: string
  model: string
  apiKey?: string
  /** 프롬프트 오버라이드 */
  prompt?: string
  maxTokens?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_PROMPT =
  "다음은 한국 규정 문서의 표(별표/별지서식 등)다. 이 표가 무엇을 위한 것이고 어떤 항목·" +
  "값을 담는지 검색에 도움이 되도록 핵심 키워드를 포함해 한국어 1~2문장으로 요약해줘. " +
  "표 원문 반복 없이 요약만 출력."

/** OpenAI 호환 텍스트 LLM 요약기 생성. */
export function createLlmSummarizer(config: LlmSummarizerConfig): TableSummarizer {
  const {
    endpoint, model, apiKey,
    prompt = DEFAULT_PROMPT,
    maxTokens = 256,
    timeoutMs = 60000,
    fetchImpl = fetch,
  } = config
  if (!endpoint) throw new Error("createLlmSummarizer: endpoint가 필요합니다")
  if (!model) throw new Error("createLlmSummarizer: model이 필요합니다")

  return async (text: string, headingPath: string[]): Promise<string> => {
    const ctx = headingPath.length ? `[섹션: ${headingPath.join(" > ")}]\n` : ""
    const body = {
      model,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: ctx + text },
      ],
      max_tokens: maxTokens,
      temperature: 0,
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const res = await fetchImpl(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal })
      if (!res.ok) throw new Error(`요약 요청 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`)
      const json = await res.json() as { choices?: { message?: { content?: string } }[] }
      return json.choices?.[0]?.message?.content?.trim() ?? ""
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface SummarizeOptions {
  /** needsSummary 표시된 청크만 요약 (기본 true). false면 모든 표 요약 */
  onlyFlagged?: boolean
  /** 동시 요청 수 (기본 4) */
  concurrency?: number
}

/**
 * 표 청크에 LLM 요약을 부착 (needsSummary 표시 = 별표/별지서식 우선).
 * 새 배열을 반환하며 입력은 변경하지 않는다. 요약 실패는 조용히 건너뛴다.
 */
export async function summarizeChunks(
  chunks: SearchChunk[],
  summarizer: TableSummarizer,
  opts: SummarizeOptions = {},
): Promise<SearchChunk[]> {
  const { onlyFlagged = true, concurrency = 4 } = opts
  const result = chunks.map(c => ({ ...c }))
  const targets = result.filter(c => c.type === "table" && (onlyFlagged ? c.needsSummary : true))

  let i = 0
  async function worker() {
    while (i < targets.length) {
      const c = targets[i++]
      try { c.summary = await summarizer(c.text, c.headingPath) } catch { /* 요약 실패 무시 */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
  return result
}

/** 요약 포함 검색 텍스트로 직렬화 (summarizeChunks 결과를 합침). */
export function chunksToSearchText(chunks: SearchChunk[]): string {
  return chunks.map(chunkToText).join("\n\n")
}
