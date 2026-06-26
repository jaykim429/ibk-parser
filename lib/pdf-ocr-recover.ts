/**
 * PDF 손상 페이지 VLM 재OCR 복구 (에이전틱)
 *
 * 왜: 일부 PDF는 글꼴 ToUnicode 매핑이 손상돼 텍스트층은 있으나 추출 결과가 깨짐
 *    (예: 의안 신구조문대비표 페이지 — 한글 추출비율 39%). 시각 글리프는 정상이므로
 *    해당 페이지를 이미지로 렌더 → VLM(Gemma) OCR → 올바른 텍스트를 복구한다.
 *
 * - kordoc의 qualitySummary.ocrCandidatePages(손상 의심 페이지)만 타깃 → 비용 최소화.
 * - 렌더: pdfjs-dist + @napi-rs/canvas(프리빌트, 폐쇄망 친화). VLM 호출: kordoc createVlmOcrProvider 재사용.
 * - 라이브러리/모델 변경 시 이 파일만 손대면 됨(파이프라인 다른 부분 불변).
 */

// kordoc OcrProvider 시그니처: (pageImage, pageNumber, mimeType) => Promise<markdown>
export type OcrFn = (pageImage: Uint8Array, pageNumber: number, mimeType: "image/png") => Promise<string>;

// webpack 정적 분석을 우회한 런타임 동적 import(네이티브 ESM/프리빌트 — kordoc과 동일 전략)
const _imp = new Function("s", "return import(s)") as (s: string) => Promise<Record<string, unknown>>;

// pdfjs는 Node에서 DOMMatrix/Path2D polyfill 필요 — @napi-rs/canvas가 실제 구현 제공.
// (텍스트추출용 최소 stub과 달리 '렌더'는 실제 Path2D/DOMMatrix가 필요)
let _pdfjs: unknown;
async function loadPdfjs(): Promise<Record<string, unknown>> {
  if (_pdfjs) return _pdfjs as Record<string, unknown>;
  const napi = await _imp("@napi-rs/canvas");
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined" && napi.DOMMatrix) g.DOMMatrix = napi.DOMMatrix;
  if (typeof g.Path2D === "undefined" && napi.Path2D) g.Path2D = napi.Path2D;
  if (typeof g.ImageData === "undefined" && napi.ImageData) g.ImageData = napi.ImageData;
  try {
    g.pdfjsWorker = await _imp("pdfjs-dist/legacy/build/pdf.worker.mjs");
  } catch {
    /* worker 없으면 fake worker 폴백 */
  }
  const pdfjs = await _imp("pdfjs-dist/legacy/build/pdf.mjs");
  (pdfjs.GlobalWorkerOptions as { workerSrc: string }).workerSrc = "";
  _pdfjs = pdfjs;
  return pdfjs;
}

/** 지정 페이지들을 PNG로 렌더(2x ≈ 300DPI). 실패 페이지는 결과에서 제외. */
export async function renderPdfPagesToPng(
  buffer: Buffer,
  pages: number[],
  scale = 2.0
): Promise<Map<number, Uint8Array>> {
  const pdfjs = await loadPdfjs();
  const napi = (await _imp("@napi-rs/canvas")) as unknown as {
    createCanvas: (w: number, h: number) => { getContext(t: string): unknown; toBuffer(t: string): Buffer };
  };
  // pdfjs가 입력 버퍼의 underlying storage를 detach할 수 있어 복사본 전달
  const data = new Uint8Array(buffer.byteLength);
  data.set(buffer);
  const getDocument = pdfjs.getDocument as (opts: Record<string, unknown>) => { promise: Promise<PdfDoc> };
  const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const map = new Map<number, Uint8Array>();
  try {
    const wanted = Array.from(new Set(pages)).filter((n) => n >= 1 && n <= doc.numPages);
    for (const n of wanted) {
      try {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale });
        const canvas = napi.createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
        map.set(n, new Uint8Array(canvas.toBuffer("image/png")));
      } catch {
        /* 페이지 렌더 실패 → skip */
      }
    }
  } finally {
    try {
      await (doc as { destroy?: () => Promise<void> }).destroy?.();
    } catch {
      /* noop */
    }
  }
  return map;
}

type PdfDoc = {
  numPages: number;
  getPage(n: number): Promise<{
    getViewport(p: { scale: number }): { width: number; height: number };
    render(p: { canvasContext: unknown; viewport: unknown }): { promise: Promise<void> };
  }>;
};

export type RecoveredPage = { page: number; text: string };

/** 손상 의심 페이지들을 렌더→VLM OCR로 복구. */
export async function recoverLowQualityPages(args: {
  buffer: Buffer;
  pages: number[];
  ocr: OcrFn;
  maxPages: number;
}): Promise<RecoveredPage[]> {
  const target = Array.from(new Set(args.pages)).slice(0, args.maxPages);
  if (target.length === 0) return [];
  const pngs = await renderPdfPagesToPng(args.buffer, target);
  const out: RecoveredPage[] = [];
  for (const page of target) {
    const png = pngs.get(page);
    if (!png) continue;
    try {
      const text = await args.ocr(png, page, "image/png");
      if (text && text.trim()) out.push({ page, text: text.trim() });
    } catch {
      /* 페이지 OCR 실패 → skip */
    }
  }
  return out;
}
