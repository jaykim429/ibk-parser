/**
 * 임베딩 클라이언트 (OpenRouter Qwen3-Embedding-8B, 4096차원)
 * 내규 인덱싱과 쿼리 임베딩에 동일 모델을 사용해야 벡터 검색이 성립한다.
 */
import { config } from "./config";

export async function embed(texts: string[]): Promise<number[][]> {
  const r = await fetch(`${config.embeddingApiUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + config.embeddingApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: config.embeddingModel, input: texts }),
    signal: AbortSignal.timeout(config.embeddingTimeoutMs),
  });
  if (!r.ok) {
    throw new Error(`임베딩 실패 (HTTP ${r.status})`);
  }
  const j = await r.json();
  return (j.data ?? []).map((d: { embedding: number[] }) => d.embedding);
}

export async function embedQuery(text: string): Promise<number[]> {
  const v = await embed([text.slice(0, 2000)]);
  if (!v[0]) throw new Error("쿼리 임베딩 결과가 비어 있습니다.");
  return v[0];
}
