/**
 * 파일 → Markdown 파싱 (kordoc, 로컬)
 * 지원: hwp3/hwp/hwpx/hwpml/pdf/xls/xlsx/docx
 * 스캔(이미지) PDF는 DGX Spark VLM(gemma-4-26B)로 OCR 라우팅.
 *
 * 임베딩/저장 없음 — 순수 텍스트 추출만 수행.
 */
import type { ParseOptions, ParseResult } from "kordoc";
import { config } from "./config";
import { normalizeMarkdown, pickTitle } from "./doc-text";

// kordoc는 ESM 전용 + 네이티브 의존성(sharp/pdfium 등)을 가지므로
// webpack 번들링을 피해 런타임 네이티브 ESM 동적 import로 로드한다.
// (new Function 으로 감싸 webpack 정적 분석을 우회)
type KordocModule = {
  parse: (input: Buffer | ArrayBuffer | string, options?: ParseOptions) => Promise<ParseResult>;
  createVlmOcrProvider: (cfg: { endpoint: string; model: string; apiKey?: string }) => unknown;
};
let _kordoc: KordocModule | undefined;
const _dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<KordocModule>;
async function loadKordoc(): Promise<KordocModule> {
  if (!_kordoc) _kordoc = await _dynamicImport("kordoc");
  return _kordoc;
}

const DGX_URL = config.dgxSparkUrl;
const DGX_MODEL = config.dgxSparkModel;

export type ParsedDoc = {
  markdown: string;
  fileType: string;
  pageCount?: number;
  isImageBased: boolean;
  usedOcr: boolean;
  title?: string;
  warnings: string[];
};

const ERROR_MESSAGES: Record<string, string> = {
  EMPTY_INPUT: "빈 파일입니다.",
  UNSUPPORTED_FORMAT: "지원하지 않는 파일 형식입니다.",
  ENCRYPTED: "암호화된 문서입니다. 암호를 해제한 후 업로드해 주세요.",
  DRM_PROTECTED: "DRM이 적용된 문서입니다.",
  CORRUPTED: "손상된 문서입니다.",
  IMAGE_BASED_PDF: "이미지 기반(스캔) PDF이며 텍스트 추출에 실패했습니다.",
  NO_SECTIONS: "본문 섹션을 찾을 수 없습니다.",
  MISSING_DEPENDENCY: "파싱에 필요한 구성요소가 누락되었습니다.",
};

export async function parseDocument(
  buffer: Buffer,
  filename: string
): Promise<ParsedDoc> {
  const { parse, createVlmOcrProvider } = await loadKordoc();

  // 이미지 기반 PDF는 자동으로 VLM OCR로 라우팅됨 (텍스트 PDF엔 호출 안 됨)
  const ocr = createVlmOcrProvider({
    endpoint: `${DGX_URL}/v1/chat/completions`,
    model: DGX_MODEL,
  });

  const result = await parse(buffer, { ocr, removeHeaderFooter: true } as ParseOptions);

  if (!result.success) {
    const msg = ERROR_MESSAGES[result.code ?? ""] ?? result.error ?? "파싱 실패";
    throw new Error(msg);
  }

  if (!result.markdown || !result.markdown.trim()) {
    throw new Error("문서에서 추출된 텍스트가 없습니다.");
  }

  const markdown = normalizeMarkdown(result.markdown);

  const usedOcr = (result.warnings ?? []).some((w) => w.code === "OCR_FALLBACK")
    || (!!result.isImageBased);

  return {
    markdown,
    fileType: result.fileType,
    pageCount: result.pageCount,
    isImageBased: !!result.isImageBased,
    usedOcr,
    title: pickTitle(result.metadata?.title, markdown, filename),
    warnings: (result.warnings ?? []).map((w) => w.message),
  };
}

