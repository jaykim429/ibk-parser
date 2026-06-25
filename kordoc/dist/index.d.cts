/** kordoc 공통 타입 정의 */
interface CellContext {
    text: string;
    colSpan: number;
    rowSpan: number;
    /** HWP5 셀 열 주소 (0-based) — 병합 테이블 배치용 */
    colAddr?: number;
    /** HWP5 셀 행 주소 (0-based) — 병합 테이블 배치용 */
    rowAddr?: number;
    /** HWP5 셀 폭 (HWPUNIT, 1/7200인치) — 컬럼 너비 재현용 */
    width?: number;
    /** HWP5 셀 borderFill ID — 테두리 해석용 */
    borderFillId?: number;
}
/** 블록 타입 — v2.0에서 heading, list, image, separator 추가 */
type IRBlockType = "paragraph" | "table" | "heading" | "list" | "image" | "separator";
interface IRBlock {
    type: IRBlockType;
    text?: string;
    table?: IRTable;
    /** 헤딩 레벨 (1-6), type="heading"일 때 사용 */
    level?: number;
    /** 원본 페이지 번호 (1-based) */
    pageNumber?: number;
    /** 바운딩 박스 — PDF에서만 제공 */
    bbox?: BoundingBox;
    /** 텍스트 스타일 정보 (선택) */
    style?: InlineStyle;
    /** 리스트 타입, type="list"일 때 사용 */
    listType?: "ordered" | "unordered";
    /** 중첩 리스트 아이템 */
    children?: IRBlock[];
    /** 하이퍼링크 URL */
    href?: string;
    /** 각주/미주 텍스트 (인라인 삽입용) */
    footnoteText?: string;
    /** 이미지 데이터 (type="image"일 때) */
    imageData?: ImageData;
}
/** 추출된 이미지 바이너리 데이터 */
interface ImageData {
    /** 이미지 바이너리 */
    data: Uint8Array;
    /** MIME 타입 (image/png, image/jpeg, image/gif, image/bmp, image/wmf, image/emf) */
    mimeType: string;
    /** 원본 파일명 (있는 경우) */
    filename?: string;
}
/** 바운딩 박스 — PDF 포인트 단위 (72pt = 1인치) */
interface BoundingBox {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
}
/** 인라인 텍스트 스타일 */
interface InlineStyle {
    bold?: boolean;
    italic?: boolean;
    fontSize?: number;
    fontName?: string;
}
interface IRTable {
    rows: number;
    cols: number;
    cells: IRCell[][];
    /** 첫 행을 헤더로 렌더링할지 여부 (현재: rows > 1이면 true — 의미적 감지가 아닌 레이아웃 힌트) */
    hasHeader: boolean;
    /** 컬럼별 너비 (HWPUNIT). 원본 서식의 열 비율 재현용 (HWP5 표에서만 제공) */
    colWidths?: number[];
}
/** 셀 4변 테두리 굵기 (px, 0 = 무테두리) */
interface CellBorder {
    top: number;
    right: number;
    bottom: number;
    left: number;
}
interface IRCell {
    text: string;
    colSpan: number;
    rowSpan: number;
    /** 4변 테두리 굵기 (HWP5 borderFill 해석 결과) — 서식 충실 렌더링용 */
    border?: CellBorder;
    /** @internal HWP5 borderFill ID (post-pass에서 border로 해석 후 제거) */
    borderFillId?: number;
}
/** 문서 메타데이터 — 각 포맷에서 추출 가능한 필드만 채워짐 */
interface DocumentMetadata {
    /** 문서 제목 */
    title?: string;
    /** 작성자 */
    author?: string;
    /** 작성 프로그램 (예: "한글 2020", "Adobe Acrobat") */
    creator?: string;
    /** 생성일시 (ISO 8601) */
    createdAt?: string;
    /** 수정일시 (ISO 8601) */
    modifiedAt?: string;
    /** 페이지/섹션 수 */
    pageCount?: number;
    /** 문서 포맷 버전 (예: HWP "5.1.0.1") */
    version?: string;
    /** 설명 */
    description?: string;
    /** 키워드 */
    keywords?: string[];
}
/** 파싱 옵션 — parse() 함수에 전달 */
interface ParseOptions {
    /**
     * 파싱할 페이지/섹션 범위 (1-based).
     * - 배열: [1, 2, 3]
     * - 문자열: "1-3", "1,3,5-7"
     *
     * PDF: 정확한 페이지 단위. HWP/HWPX: 섹션 단위 근사치.
     */
    pages?: number[] | string;
    /** 이미지 기반 PDF용 OCR 프로바이더 (선택) */
    ocr?: OcrProvider;
    /** 진행률 콜백 — current: 현재 페이지/섹션, total: 전체 수 */
    onProgress?: (current: number, total: number) => void;
    /** PDF 머리글/바닥글 자동 제거 */
    removeHeaderFooter?: boolean;
    /** 원본 파일 경로 (DRM COM fallback에 필요, 내부 전용) */
    filePath?: string;
    /**
     * PDF 수식 OCR 활성화 (기본 false).
     *
     * 활성화 시 각 PDF 페이지를 이미지로 렌더링 → YOLOv8 기반 수식 영역 검출 →
     * TrOCR 기반 LaTeX 인식. 감지된 수식은 `$...$` (inline) / `$$...$$` (display) 로
     * 블록 텍스트에 삽입된다.
     *
     * 필수 optional 의존성: `onnxruntime-node`, `@huggingface/transformers`,
     * `@hyzyla/pdfium`, `sharp`. 미설치 시 parse 에 실패하지 않고 **경고만** 남기고
     * 수식 인식은 skip 한다 (일반 텍스트 추출은 정상 동작).
     *
     * 모델(~155MB) 은 첫 사용 시 HuggingFace 에서 자동 다운로드 되어
     * `~/.cache/kordoc/models/pix2text/` 에 SHA-256 검증과 함께 저장된다.
     */
    formulaOcr?: boolean;
}
/** 파싱 중 스킵/실패한 요소 보고 */
interface ParseWarning {
    /** 관련 페이지 번호 (알 수 있는 경우) */
    page?: number;
    /** 경고 메시지 */
    message: string;
    /** 구조화된 경고 코드 */
    code: WarningCode;
}
type WarningCode = "SKIPPED_IMAGE" | "SKIPPED_OLE" | "TRUNCATED_TABLE" | "OCR_FALLBACK" | "UNSUPPORTED_ELEMENT" | "BROKEN_ZIP_RECOVERY" | "HIDDEN_TEXT_FILTERED" | "MALFORMED_XML" | "PARTIAL_PARSE" | "LENIENT_CFB_RECOVERY";
/** 문서 구조 (헤딩 트리) */
interface OutlineItem {
    level: number;
    text: string;
    pageNumber?: number;
}
/** 구조화된 에러 코드 — 프로그래밍적 에러 핸들링용 */
type ErrorCode = "EMPTY_INPUT" | "UNSUPPORTED_FORMAT" | "ENCRYPTED" | "DRM_PROTECTED" | "CORRUPTED" | "DECOMPRESSION_BOMB" | "ZIP_BOMB" | "IMAGE_BASED_PDF" | "NO_SECTIONS" | "PARSE_ERROR" | "MISSING_DEPENDENCY";
type FileType = "hwpx" | "hwp" | "hwp3" | "hwpml" | "pdf" | "xlsx" | "xls" | "docx" | "unknown";
interface ParseResultBase {
    fileType: FileType;
    /** 페이지/섹션 수 — PDF: 실제 페이지 수, HWP/HWPX: 섹션 수, XLSX: 시트 수 */
    pageCount?: number;
    /** 이미지 기반 PDF 여부 (텍스트 추출 불가) */
    isImageBased?: boolean;
}
interface ParseSuccess extends ParseResultBase {
    success: true;
    /** 추출된 마크다운 텍스트 */
    markdown: string;
    /** 중간 표현 블록 (구조화된 데이터 접근용) */
    blocks: IRBlock[];
    /** 문서 메타데이터 */
    metadata?: DocumentMetadata;
    /** 문서 구조 (헤딩 트리) — v2.0 */
    outline?: OutlineItem[];
    /** 파싱 중 발생한 경고 — v2.0 */
    warnings?: ParseWarning[];
    /** 추출된 이미지 목록 — 마크다운에서 파일명으로 참조됨 */
    images?: ExtractedImage[];
    /** 페이지별 텍스트 품질 신호 — PDF에서만 제공 */
    pageQuality?: PageQuality[];
    /** 문서 단위 품질 요약 — PDF에서만 제공 */
    qualitySummary?: DocumentQualitySummary;
}
/** 페이지별 텍스트 품질 신호 (PDF 전용). 자세한 설명은 src/pdf/quality.ts */
interface PageQuality {
    page: number;
    textChars: number;
    hangulRatio: number;
    controlCharRatio: number;
    replacementCharRatio: number;
    puaRatio: number;
    needsOcr: boolean;
    ocrReason?: "low_text" | "high_pua" | "high_control" | "high_replacement";
}
/** 문서 단위 품질 요약 (PDF 전용). */
interface DocumentQualitySummary {
    totalPages: number;
    totalTextChars: number;
    avgHangulRatio: number;
    avgControlCharRatio: number;
    avgReplacementCharRatio: number;
    avgPuaRatio: number;
    lowTextPageCount: number;
    highPuaPageCount: number;
    needsOcr: boolean;
    ocrCandidatePages: number[];
}
/** 추출된 이미지 — ParseSuccess.images에 포함 */
interface ExtractedImage {
    /** 마크다운에서 참조되는 파일명 (예: image_001.png) */
    filename: string;
    /** 이미지 바이너리 */
    data: Uint8Array;
    /** MIME 타입 */
    mimeType: string;
}
interface ParseFailure extends ParseResultBase {
    success: false;
    /** 오류 메시지 */
    error: string;
    /** 구조화된 에러 코드 */
    code?: ErrorCode;
}
type ParseResult = ParseSuccess | ParseFailure;
type DiffChangeType = "added" | "removed" | "modified" | "unchanged";
interface BlockDiff {
    type: DiffChangeType;
    /** 원본 블록 (added이면 undefined) */
    before?: IRBlock;
    /** 변경 후 블록 (removed이면 undefined) */
    after?: IRBlock;
    /** modified 테이블의 셀 단위 diff */
    cellDiffs?: CellDiff[][];
    /** 유사도 (0-1) */
    similarity?: number;
}
interface CellDiff {
    type: DiffChangeType;
    before?: string;
    after?: string;
}
interface DiffResult {
    stats: {
        added: number;
        removed: number;
        modified: number;
        unchanged: number;
    };
    diffs: BlockDiff[];
}
interface FormField {
    label: string;
    value: string;
    /** 0-based 소스 행 */
    row: number;
    /** 0-based 소스 열 */
    col: number;
}
interface FormResult {
    fields: FormField[];
    /** 양식 확신도 (0-1) */
    confidence: number;
}
/** 사용자 제공 OCR 함수 — 페이지 이미지를 받아 텍스트 반환 */
type OcrProvider = (pageImage: Uint8Array, pageNumber: number, mimeType: "image/png") => Promise<string>;
interface WatchOptions {
    dir: string;
    outDir?: string;
    webhook?: string;
    format?: "markdown" | "json";
    pages?: string;
    silent?: boolean;
}

/** 문서 비교 엔진 — IR 레벨 블록 비교로 신구대조표 생성 */

/**
 * 두 문서를 비교하여 블록 단위 diff 생성.
 * 크로스 포맷 지원 — HWP vs HWPX 비교 가능 (IR 레벨).
 */
declare function compare(bufferA: ArrayBuffer, bufferB: ArrayBuffer, options?: ParseOptions): Promise<DiffResult>;
/** IRBlock[] 간 diff — LCS 기반 정렬 */
declare function diffBlocks(blocksA: IRBlock[], blocksB: IRBlock[]): DiffResult;

/** 양식(서식) 필드 인식 — 테이블 기반 label-value 패턴 매칭 */

/** 라벨처럼 보이는 셀인지 판별 */
declare function isLabelCell(text: string): boolean;
/**
 * IRBlock[]에서 양식 필드를 인식하여 추출.
 * 테이블의 label-value 패턴을 감지.
 */
declare function extractFormFields(blocks: IRBlock[]): FormResult;

/** 양식 서식 필드 값 채우기 — IRBlock[] 기반 in-place 교체 */

/** 필드 채우기 결과 */
interface FillResult {
    /** 값이 교체된 IRBlock[] */
    blocks: IRBlock[];
    /** 실제 채워진 필드 목록 */
    filled: FormField[];
    /** 매칭 실패한 라벨 (입력에는 있지만 서식에서 못 찾은 것) */
    unmatched: string[];
}
/**
 * IRBlock[]에서 양식 필드를 찾아 값을 교체.
 *
 * @param blocks 원본 IRBlock[] (변경하지 않음 — deep clone)
 * @param values 채울 값 맵 (라벨 → 새 값). 라벨은 접두사 매칭 지원.
 * @returns FillResult
 *
 * @example
 * ```ts
 * const result = await parse("신청서.hwp")
 * if (!result.success) throw new Error(result.error)
 * const { blocks, filled } = fillFormFields(result.blocks, {
 *   "성명": "홍길동",
 *   "전화번호": "010-1234-5678",
 *   "주소": "서울시 강남구",
 * })
 * ```
 */
declare function fillFormFields(blocks: IRBlock[], values: Record<string, string>): FillResult;

/**
 * HWPX 원본 서식 유지 채우기 — ZIP 내 section XML 직접 수정
 *
 * IRBlock 중간 표현을 거치지 않고, 원본 HWPX ZIP의 section XML에서
 * 테이블 셀 텍스트(<hp:t>)만 교체하여 모든 스타일을 보존합니다.
 */

/** 채우기 결과 */
interface HwpxFillResult {
    /** 채워진 HWPX 바이너리 */
    buffer: ArrayBuffer;
    /** 실제 채워진 필드 목록 */
    filled: FormField[];
    /** 매칭 실패한 라벨 */
    unmatched: string[];
}
/**
 * HWPX 원본을 직접 수정하여 서식 필드를 채움 — 스타일 100% 보존.
 *
 * @param hwpxBuffer 원본 HWPX 파일 버퍼
 * @param values 채울 값 맵 (라벨 → 값)
 * @returns HwpxFillResult
 */
declare function fillHwpx(hwpxBuffer: ArrayBuffer, values: Record<string, string>): Promise<HwpxFillResult>;

/**
 * Markdown → HWPX 역변환
 *
 * 지원: 헤딩(h1~h6), 단락, 볼드, 이탤릭, 인라인코드, 코드블록,
 *       순서/비순서 리스트, 수평선, 인용문, 테이블
 * jszip으로 HWPX ZIP 패키징.
 */
/** HWPX 생성 시 적용할 시각 테마 (모두 선택) */
interface HwpxTheme {
    /**
     * 헤딩 레벨별 텍스트 색상. 미지정 시 검정.
     * 현재 charPr 매핑은 h1/h2/h3/h4 4단계 (h5, h6은 h4와 같은 charPr 공유)이므로
     * 키는 1~4만 받는다.
     */
    headingColors?: Partial<Record<1 | 2 | 3 | 4, string>>;
    /** 본문 단락 텍스트 색상. 미지정 시 검정 */
    bodyColor?: string;
    /**
     * 인용문 텍스트 색상. 미지정 시 검정.
     *
     * 주의: 이 옵션을 지정하면 인용문이 별도 charPr(이탤릭)로 렌더링된다.
     * 미지정 시 기존 동작 그대로 본문 charPr로 렌더링 (이탤릭 아님).
     */
    quoteColor?: string;
    /** 표 첫 행 텍스트 색상. 미지정 시 본문과 동일 */
    tableHeaderColor?: string;
    /** 표 첫 행 텍스트를 굵게 표시 (기본 false) */
    tableHeaderBold?: boolean;
}
/** markdownToHwpx 옵션 */
interface MarkdownToHwpxOptions {
    theme?: HwpxTheme;
}
/**
 * 마크다운 텍스트를 HWPX (ArrayBuffer)로 변환.
 */
declare function markdownToHwpx(markdown: string, options?: MarkdownToHwpxOptions): Promise<ArrayBuffer>;

/**
 * Print Renderer — Markdown / IRBlock[] → PDF (puppeteer-core 기반).
 *
 * 흐름:
 *   blocks → markdown (blocksToMarkdown)
 *   markdown → HTML (markdown-it)
 *   HTML + 프리셋 CSS → PDF (puppeteer-core)
 *
 * puppeteer-core는 optional peer dep. 미설치 시 markdownToPdf는 명확한 에러를 던지지만
 * `renderHtml()`은 항상 동작 (외부 PDF 엔진과 결합용).
 *
 * 참조: docs/SPEC.md §1.3
 */

type PrintPreset = "default" | "gov-formal" | "compact";
interface PageMargin {
    top: string | number;
    right: string | number;
    bottom: string | number;
    left: string | number;
}
interface PrintOptions {
    preset?: PrintPreset;
    pageSize?: "A4" | "Letter";
    orientation?: "portrait" | "landscape";
    margin?: PageMargin;
    /** 페이지 머리글 (HTML 허용, gov-formal 프리셋에서 자동 표시) */
    header?: string;
    /** 페이지 바닥글 (HTML 허용) */
    footer?: string;
    /** 워터마크 텍스트 (대각선 회색) */
    watermark?: string;
    /** 사용자 정의 추가 CSS */
    extraCss?: string;
}
/**
 * Markdown 또는 IRBlock[] → HTML 문자열.
 * 외부 PDF 엔진(weasyprint, wkhtmltopdf 등)과 결합 가능.
 */
declare function renderHtml(markdown: string, options?: PrintOptions): string;
/** Markdown → PDF (Buffer). */
declare function markdownToPdf(markdown: string, options?: PrintOptions): Promise<Buffer>;
/** IRBlock[] → PDF (Buffer). */
declare function blocksToPdf(blocks: IRBlock[], options?: PrintOptions): Promise<Buffer>;

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

interface VlmOcrConfig {
    /** OpenAI 호환 chat/completions 엔드포인트 URL */
    endpoint: string;
    /** 모델 ID */
    model: string;
    /** API 키 (필요 시 Authorization: Bearer) */
    apiKey?: string;
    /** 프롬프트 오버라이드 (기본: 한국어 구조화 Markdown 복원) */
    prompt?: string;
    /** 생성 토큰 상한 (기본 2048) */
    maxTokens?: number;
    /** 요청 타임아웃 ms (기본 120000) */
    timeoutMs?: number;
    /** fetch 구현 주입 (테스트/커스텀 런타임용, 기본 global fetch) */
    fetchImpl?: typeof fetch;
}
/** VLM 기반 OcrProvider 생성. 반환 함수는 페이지 이미지를 받아 Markdown 문자열을 돌려준다. */
declare function createVlmOcrProvider(config: VlmOcrConfig): OcrProvider;

/**
 * 검색(sparse/dense 벡터) 최적화 파싱.
 *
 * 원본 충실 파싱(blocksToMarkdown)과 별개로, 임베딩·BM25 검색에 맞춘 형태를 만든다.
 *  - 문단 내부 줄바꿈을 공백으로 정규화 → 한 문단 = 한 검색 단위
 *  - 섹션 경로(제N장 > 제N조 …)를 각 청크에 컨텍스트로 부착 → recall 향상
 *  - 표를 "헤더=값" 행으로 선형화 → 파이프/HTML 마크업 노이즈 제거
 *  - 제어문자/과다 공백 제거
 *  - 별표/별지서식 표는 LLM 요약을 덧붙일 수 있도록 needsSummary 표시
 *    (표 텍스트만으론 의미 검색 recall이 부족하므로)
 */

interface SearchChunk {
    /** "text" = 본문 단락, "table" = 표(별표/별지서식 포함) */
    type: "text" | "table";
    /** 섹션 경로 (예: ["제2장 임원", "제5조(임원의 책무)"]) */
    headingPath: string[];
    /** 검색용 정규화 본문 */
    text: string;
    /** 별표/별지서식 등 요약이 도움이 되는 표 여부 */
    needsSummary?: boolean;
    /** LLM 요약 (summarizeChunks로 채워짐) */
    summary?: string;
    pageNumber?: number;
}
/** 표를 검색 친화적 행 텍스트로 선형화. 헤더가 있으면 "헤더=값"으로. */
declare function linearizeTable(table: IRTable): string;
/**
 * IRBlock[] → 검색 최적화 청크 배열 (LLM 없이, 동기).
 * heading을 만나면 해당 레벨로 섹션 경로를 갱신한다.
 */
declare function toSearchChunks(blocks: IRBlock[]): SearchChunk[];
/**
 * 청크 → 단일 검색 텍스트. 각 청크는 빈 줄로 구분되어 청킹이 쉽고,
 * 섹션 경로가 머리에 붙어 컨텍스트를 보존한다.
 */
declare function chunkToText(c: SearchChunk): string;
/** IRBlock[] → 검색 최적화 단일 텍스트 (동기, LLM 없이). */
declare function toSearchText(blocks: IRBlock[]): string;

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

/** (표 텍스트, 섹션 경로) → 한국어 요약 1~2문장 */
type TableSummarizer = (text: string, headingPath: string[]) => Promise<string>;
interface LlmSummarizerConfig {
    endpoint: string;
    model: string;
    apiKey?: string;
    /** 프롬프트 오버라이드 */
    prompt?: string;
    maxTokens?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
/** OpenAI 호환 텍스트 LLM 요약기 생성. */
declare function createLlmSummarizer(config: LlmSummarizerConfig): TableSummarizer;
interface SummarizeOptions {
    /** needsSummary 표시된 청크만 요약 (기본 true). false면 모든 표 요약 */
    onlyFlagged?: boolean;
    /** 동시 요청 수 (기본 4) */
    concurrency?: number;
}
/**
 * 표 청크에 LLM 요약을 부착 (needsSummary 표시 = 별표/별지서식 우선).
 * 새 배열을 반환하며 입력은 변경하지 않는다. 요약 실패는 조용히 건너뛴다.
 */
declare function summarizeChunks(chunks: SearchChunk[], summarizer: TableSummarizer, opts?: SummarizeOptions): Promise<SearchChunk[]>;
/** 요약 포함 검색 텍스트로 직렬화 (summarizeChunks 결과를 합침). */
declare function chunksToSearchText(chunks: SearchChunk[]): string;

/** 매직 바이트 기반 파일 포맷 감지 */

/** ZIP 파일 여부: PK\x03\x04 */
declare function isZipFile(buffer: ArrayBuffer): boolean;
/** HWPX (ZIP 기반 한컴 문서): PK\x03\x04 — 하위 호환용 */
declare function isHwpxFile(buffer: ArrayBuffer): boolean;
/** HWP 5.x (OLE2 바이너리 한컴 문서): \xD0\xCF\x11\xE0 */
declare function isOldHwpFile(buffer: ArrayBuffer): boolean;
/** PDF 문서: %PDF */
declare function isPdfFile(buffer: ArrayBuffer): boolean;
/** 동기 포맷 감지 — ZIP은 모두 "hwpx"로 반환 (하위 호환) */
declare function detectFormat(buffer: ArrayBuffer): FileType;
/**
 * OLE2 컨테이너 내부 스트림 기반 포맷 세분화.
 * HWP 5.x, XLS 모두 OLE2이므로 스트림 이름으로 구분.
 *  - "Workbook" 또는 "Book" → 'xls'
 *  - 그 외 (FileHeader 등) → 'hwp'
 */
declare function detectOle2Format(buffer: ArrayBuffer): "hwp" | "xls" | "unknown";
/**
 * ZIP 내부 구조 기반 포맷 세분화.
 * HWPX, XLSX, DOCX 모두 ZIP이므로 내부 파일로 구분.
 */
declare function detectZipFormat(buffer: ArrayBuffer): Promise<"hwpx" | "xlsx" | "docx" | "unknown">;

/** 2-pass colSpan/rowSpan 테이블 빌더 및 Markdown 변환 */

declare function blocksToMarkdown(blocks: IRBlock[]): string;

/** kordoc 공용 유틸리티 */
declare const VERSION: string;

/**
 * 파일 버퍼를 자동 감지하여 Markdown으로 변환
 *
 * @example
 * ```ts
 * import { parse } from "kordoc"
 * // 파일 경로로 파싱
 * const result = await parse("document.hwp")
 * // 또는 Buffer로 파싱
 * const result = await parse(buffer)
 * ```
 */
declare function parse(input: string | ArrayBuffer | Buffer, options?: ParseOptions): Promise<ParseResult>;
/** HWP 3.x (구버전 한컴 워드프로세서) 파일을 Markdown 으로 변환. */
declare function parseHwp3(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** HWPX 파일을 Markdown으로 변환 */
declare function parseHwpx(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** HWP 5.x 바이너리 파일을 Markdown으로 변환 */
declare function parseHwp(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** PDF 파일에서 텍스트를 추출하여 Markdown으로 변환 */
declare function parsePdf(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** XLSX 파일을 Markdown으로 변환 */
declare function parseXlsx(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** XLS (Excel 97-2003) 파일을 Markdown으로 변환 */
declare function parseXls(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** DOCX 파일을 Markdown으로 변환 */
declare function parseDocx(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/** HWPML (XML 기반 한컴 문서) 파일을 Markdown으로 변환 */
declare function parseHwpml(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult>;
/**
 * 서식 채우기 출력 포맷
 * - "markdown": 마크다운 텍스트
 * - "hwpx": 새로 생성한 HWPX (스타일 초기화)
 * - "hwpx-preserve": 원본 HWPX ZIP 직접 수정 (스타일 100% 보존, HWPX 입력만 가능)
 */
type FillOutputFormat = "markdown" | "hwpx" | "hwpx-preserve";
/** 서식 채우기 결과 */
interface FillFormOutput {
    /** 채워진 문서 (markdown: string, hwpx/hwpx-preserve: ArrayBuffer) */
    output: string | ArrayBuffer;
    /** 출력 포맷 */
    format: FillOutputFormat;
    /** 채우기 상세 — filled 필드 목록 + unmatched 라벨 */
    fill: {
        filled: FormField[];
        unmatched: string[];
    };
}
/**
 * 서식 문서를 파싱하여 필드를 채우고, 원하는 포맷으로 출력.
 *
 * - "hwpx-preserve": HWPX 입력 → 원본 ZIP XML 직접 수정 (테두리/폰트/병합 등 100% 보존)
 * - "hwpx": 아무 포맷 → IRBlock → Markdown → HWPX 생성 (스타일 초기화됨)
 * - "markdown": 아무 포맷 → IRBlock → Markdown
 *
 * @example
 * ```ts
 * // HWPX 원본 스타일 보존 채우기
 * const result = await fillForm("신청서.hwpx", { "성명": "홍길동" }, "hwpx-preserve")
 * writeFileSync("결과.hwpx", Buffer.from(result.output as ArrayBuffer))
 *
 * // 아무 포맷 → 마크다운 채우기
 * const result = await fillForm("신청서.hwp", { "성명": "홍길동" })
 * console.log(result.output)  // 채워진 마크다운
 * ```
 */
declare function fillForm(input: string | ArrayBuffer | Buffer, values: Record<string, string>, outputFormat?: FillOutputFormat): Promise<FillFormOutput>;

export { type BlockDiff, type BoundingBox, type CellContext, type CellDiff, type DiffChangeType, type DiffResult, type DocumentMetadata, type ErrorCode, type ExtractedImage, type FileType, type FillFormOutput, type FillOutputFormat, type FillResult, type FormField, type FormResult, type HwpxFillResult, type HwpxTheme, type IRBlock, type IRBlockType, type IRCell, type IRTable, type ImageData, type InlineStyle, type LlmSummarizerConfig, type MarkdownToHwpxOptions, type OcrProvider, type OutlineItem, type PageMargin, type ParseFailure, type ParseOptions, type ParseResult, type ParseSuccess, type ParseWarning, type PrintOptions, type PrintPreset, type SearchChunk, type SummarizeOptions, type TableSummarizer, VERSION, type VlmOcrConfig, type WarningCode, type WatchOptions, blocksToMarkdown, blocksToPdf, chunkToText, chunksToSearchText, compare, createLlmSummarizer, createVlmOcrProvider, detectFormat, detectOle2Format, detectZipFormat, diffBlocks, extractFormFields, fillForm, fillFormFields, fillHwpx, isHwpxFile, isLabelCell, isOldHwpFile, isPdfFile, isZipFile, linearizeTable, markdownToHwpx, markdownToPdf, parse, parseDocx, parseHwp, parseHwp3, parseHwpml, parseHwpx, parsePdf, parseXls, parseXlsx, renderHtml, summarizeChunks, toSearchChunks, toSearchText };
