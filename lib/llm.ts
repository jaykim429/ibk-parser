/**
 * LLM 클라이언트 — core-ai의 stateless 생성 엔드포인트 사용
 * POST /api/v1/generate/completion 은 DB에 아무것도 적재하지 않는 순수 LLM 호출.
 * (DGX Spark / gemma-4-26B 를 서버가 대신 호출)
 */

import { config } from "./config";

const CORE_AI_BASE_URL = config.coreAiBaseUrl;
const TIMEOUT = config.pipelineTimeoutMs;

export async function callCompletion(opts: {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}): Promise<string> {
  const res = await fetch(`${CORE_AI_BASE_URL}/api/v1/generate/completion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: opts.prompt,
      system_prompt: opts.systemPrompt ?? null,
      max_tokens: opts.maxTokens ?? 4000,
      temperature: opts.temperature ?? null,
      json_mode: opts.jsonMode ?? false,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!res.ok) {
    throw new Error(`LLM 호출 실패 (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data.success) {
    throw new Error(`LLM 생성 실패: ${data.error ?? "알 수 없는 오류"}`);
  }
  return (data.text ?? "") as string;
}

/** LLM 응답에서 JSON(배열/객체)을 견고하게 추출 */
export function extractJson<T = unknown>(text: string): T {
  let s = text.trim();
  // ```json ... ``` 펜스 제거
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 첫 번째 배열/객체 경계 추출
  const start = s.search(/[[{]/);
  if (start === -1) throw new Error("LLM 응답에서 JSON을 찾지 못했습니다");
  const open = s[start];
  const close = open === "[" ? "]" : "}";
  const end = s.lastIndexOf(close);
  if (end <= start) throw new Error("LLM 응답 JSON 경계 오류");
  return JSON.parse(s.slice(start, end + 1)) as T;
}
