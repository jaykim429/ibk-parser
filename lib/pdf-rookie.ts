/**
 * Rookie Parser(CG Inside) 사이드카 클라이언트 — PDF를 외부 파싱 서비스에 위임.
 *
 * 계약(HTTP):
 *   POST {rookieParserUrl}/parse  { filename, content_base64 }
 *   200  { markdown, blocks[], outline[]?, pageCount?, isImageBased?, usedOcr?, warnings?[] }
 *        ↑ blocks/outline 은 kordoc IRBlock/OutlineItem 과 동일 스키마(사이드카 래퍼가 매핑)
 *
 * 사이드카가 우리 ParsedDoc 형태로 직접 반환하므로 매핑이 단순하다.
 * 실패 시 throw → 호출부(parse-document)가 kordoc 으로 폴백.
 */
import type { IRBlock, OutlineItem } from "kordoc";
import { config } from "./config";
import { normalizeMarkdown, pickTitle } from "./doc-text";
import type { ParsedDoc } from "./parse-document";

type RookieResponse = {
  markdown?: string;
  blocks?: IRBlock[];
  outline?: OutlineItem[];
  pageCount?: number;
  isImageBased?: boolean;
  usedOcr?: boolean;
  warnings?: string[];
};

export async function parsePdfViaRookie(buffer: Buffer, filename: string): Promise<ParsedDoc> {
  const res = await fetch(`${config.rookieParserUrl}/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, content_base64: buffer.toString("base64") }),
    signal: AbortSignal.timeout(config.rookieTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`rookie /parse HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const data = (await res.json()) as RookieResponse;
  if (!data.markdown || !data.markdown.trim()) throw new Error("rookie: 추출된 텍스트 없음");

  const markdown = normalizeMarkdown(data.markdown);
  return {
    markdown,
    fileType: "pdf",
    pageCount: data.pageCount,
    isImageBased: !!data.isImageBased,
    usedOcr: !!data.usedOcr,
    lowQuality: false,
    blocks: data.blocks ?? [],
    outline: data.outline ?? [],
    title: pickTitle(undefined, markdown, filename),
    warnings: data.warnings ?? [],
  };
}
