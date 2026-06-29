/**
 * Docling doc-AI 사이드카 클라이언트 — PDF를 순수 Python Docling 사이드카에 위임.
 *   (레거시 Rookie/ODL Java CLI 대체. HTTP 계약은 Rookie와 호환 — 같은 /parse·URL.)
 *
 * 계약(HTTP):
 *   POST {rookieParserUrl}/parse  { filename, content_base64 }
 *   200  { markdown, title?, blocks[], outline[]?, pageCount?, isImageBased?, usedOcr?,
 *          lowQuality?, qualitySummary?, warnings?[] }
 *        · blocks 는 kordoc IRBlock 호환. 단 image 블록은 imageData.dataBase64(base64 string)로 전송
 *          → 어댑터가 data:Uint8Array 로 '키 리네임 + 디코드'(IRBlock 의 data 는 Uint8Array).
 *
 * 안전장치(설계 §3 + 적대검증 4개 break point 방어):
 *   ① image 키 리네임+디코드(렌더 무음누락 방지)  ② 표 그리드 정합 검증(ragged → amendPairs 무음 과소 차단)
 *   ③ demoteProseHeadings 공통 적용(복원 헤딩벽 방지)  ④ blocks=[] 폴백(복원·색인 정합)  ⑤ title 전달(현 rookie 누락분)
 * 검증 실패는 throw → 호출부(parse-document)가 kordoc 으로 폴백(무중단).
 */
import type { IRBlock, OutlineItem } from "kordoc";
import { config } from "./config";
import { normalizeMarkdown, pickTitle } from "./doc-text";
import { blocksFromMarkdown, demoteProseHeadings, type ParsedDoc } from "./parse-document";

/** 사이드카 raw 블록 — image 는 imageData.dataBase64(base64 string)로 온다(IRBlock 의 data:Uint8Array 와 다름). */
type RawImage = { dataBase64?: string; mimeType?: string; filename?: string };
type RawBlock = { type?: string; imageData?: RawImage } & Record<string, unknown>;

type DoclingResponse = {
  markdown?: string;
  title?: string;
  blocks?: RawBlock[];
  outline?: OutlineItem[];
  pageCount?: number;
  isImageBased?: boolean;
  usedOcr?: boolean;
  lowQuality?: boolean;
  qualitySummary?: { needsOcr?: boolean; ocrCandidatePages?: number[]; avgHangulRatio?: number };
  warnings?: string[];
};

/** ① image 블록 dataBase64 → data:Uint8Array 키 리네임+디코드. 디코드 실패/빈 데이터 = throw → 폴백. */
function adaptBlocks(raw: RawBlock[]): IRBlock[] {
  return raw.map((b): IRBlock => {
    if (b.type !== "image") return b as unknown as IRBlock;
    const img = b.imageData;
    if (!img?.dataBase64) {
      // 데이터 없는 이미지(캡션만) — imageData 제거하고 통과(렌더가 빈 처리)
      const { imageData: _omit, ...rest } = b;
      return rest as unknown as IRBlock;
    }
    let data: Uint8Array;
    try {
      data = Uint8Array.from(Buffer.from(img.dataBase64, "base64"));
    } catch {
      throw new Error("docling: image dataBase64 디코드 실패");
    }
    if (data.length === 0) throw new Error("docling: image 데이터 0바이트(디코드 실패)");
    return { ...b, imageData: { data, mimeType: img.mimeType, filename: img.filename } } as unknown as IRBlock;
  });
}

/** ② 표 그리드 정합 — 모든 데이터 행이 cols 길이여야(ragged → amendment-table 쌍 무음 과소). 위반 = throw → 폴백. */
function assertTableIntegrity(blocks: IRBlock[]): void {
  for (const b of blocks) {
    const t = b as { type?: string; table?: { cols?: number; cells?: unknown[][] } };
    if (t.type !== "table" || !t.table?.cells) continue;
    const cells = t.table.cells;
    const cols = t.table.cols ?? Math.max(0, ...cells.map((r) => (Array.isArray(r) ? r.length : 0)));
    if (cells.some((r) => !Array.isArray(r) || r.length !== cols)) {
      throw new Error(`docling: 표 그리드 비정합(cols=${cols}, ragged row) — 사이드카가 조밀 그리드로 패딩 필요`);
    }
  }
}

export async function parsePdfViaDocling(buffer: Buffer, filename: string): Promise<ParsedDoc> {
  const res = await fetch(`${config.rookieParserUrl}/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, content_base64: buffer.toString("base64") }),
    signal: AbortSignal.timeout(config.rookieTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`docling /parse HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const data = (await res.json()) as DoclingResponse;
  if (!data.markdown || !data.markdown.trim()) throw new Error("docling: 추출된 텍스트 없음");

  const markdown = normalizeMarkdown(data.markdown);

  let blocks = adaptBlocks(data.blocks ?? []);                       // ① image 키리네임+디코드(실패=throw)
  assertTableIntegrity(blocks);                                      // ② 표 그리드 정합(실패=throw)
  blocks = demoteProseHeadings(blocks).blocks;                       // ③ 헤딩 과분류 정규화(kordoc 경로와 동일)
  if (blocks.length === 0 && markdown.trim()) blocks = blocksFromMarkdown(markdown); // ④ blocks=[] 폴백

  return {
    markdown,
    fileType: "pdf",
    pageCount: data.pageCount,
    isImageBased: !!data.isImageBased,
    usedOcr: !!data.usedOcr,
    lowQuality: !!data.lowQuality,
    blocks,
    outline: data.outline ?? [],
    title: pickTitle(data.title, markdown, filename),                // ⑤ 사이드카 title 우선(현 rookie 는 버림)
    warnings: data.warnings ?? [],
  };
}
