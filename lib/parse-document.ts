/**
 * 파일 → Markdown 파싱 (kordoc, 로컬)
 * 지원: hwp3/hwp/hwpx/hwpml/pdf/xls/xlsx/docx
 * 스캔(이미지) PDF는 DGX Spark VLM(gemma-4-26B)로 OCR 라우팅.
 *
 * 임베딩/저장 없음 — 순수 텍스트 추출만 수행.
 */
import type {
  ParseOptions,
  ParseResult,
  IRBlock,
  OutlineItem,
  SearchChunk,
} from "kordoc";
import { config } from "./config";
import { normalizeMarkdown, pickTitle } from "./doc-text";
import { recoverLowQualityPages, type OcrFn } from "./pdf-ocr-recover";

// kordoc는 ESM 전용 + 네이티브 의존성(sharp/pdfium 등)을 가지므로
// webpack 번들링을 피해 런타임 네이티브 ESM 동적 import로 로드한다.
// (new Function 으로 감싸 webpack 정적 분석을 우회)
export type KordocModule = {
  parse: (input: Buffer | ArrayBuffer | string, options?: ParseOptions) => Promise<ParseResult>;
  createVlmOcrProvider: (cfg: { endpoint: string; model: string; apiKey?: string }) => unknown;
  // 구조 기반 검색/렌더 유틸(매뉴얼형 내규 청킹·복원에 사용)
  toSearchChunks: (blocks: IRBlock[]) => SearchChunk[];
  chunkToText: (c: SearchChunk) => string;
  linearizeTable: (table: NonNullable<IRBlock["table"]>) => string;
  blocksToMarkdown: (blocks: IRBlock[]) => string;
  renderHtml: (markdown: string, options?: Record<string, unknown>) => string;
};
let _kordoc: KordocModule | undefined;
const _dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<KordocModule>;
export async function loadKordoc(): Promise<KordocModule> {
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
  /** 추출 품질 의심(텍스트층은 있으나 비정상적으로 빈약/깨짐) — silent하지 않게 표면화 */
  lowQuality: boolean;
  /** 구조화 중간표현(표/헤딩/스타일/이미지/PDF bbox) — 매뉴얼형 청킹·복원용 */
  blocks: IRBlock[];
  /** 헤딩 트리 */
  outline: OutlineItem[];
  title?: string;
  warnings: string[];
};

/**
 * 추출 품질 게이트 — 텍스트 PDF인데 결과가 비정상적으로 빈약하거나(페이지당 글자 부족)
 * 치환문자(�)가 과다하면 '의심'으로 표시한다. (스캔 PDF는 이미 OCR로 라우팅되므로 제외)
 * 무음으로 깨진 텍스트가 흘러가지 않게 하기 위함. 향후 VLM 재OCR 승격의 트리거로도 사용 가능.
 */
function assessQuality(
  markdown: string,
  isImageBased: boolean,
  pageCount?: number
): { lowQuality: boolean; warning?: string } {
  if (isImageBased) return { lowQuality: false }; // 스캔본은 이미 OCR 경로
  const len = markdown.replace(/\s+/g, "").length;
  const garbled = (markdown.match(/�/g) ?? []).length;
  if (garbled > 0 && garbled / Math.max(1, markdown.length) > 0.01) {
    return { lowQuality: true, warning: `깨진 문자(�) 과다 — 추출 품질 의심(${garbled}자)` };
  }
  if (pageCount && pageCount > 0 && len / pageCount < config.ocrMinCharsPerPage) {
    return {
      lowQuality: true,
      warning: `페이지당 추출 글자수 부족(${Math.round(len / pageCount)}자/p < ${config.ocrMinCharsPerPage}) — 스캔/이미지 PDF일 수 있음`,
    };
  }
  return { lowQuality: false };
}

// 조/장/절/관/편 제목 — 다소 길어도(≤55) 진짜 헤딩(예: "제25조의4(재난관리책임기관의 장의 …)")
const HEADING_JO = /^\s*제\s*\d+\s*(조(\s*의\s*\d+)?|장|절|관|편)/;
// 흔한 표제어(짧음)
const HEADING_WORD =
  /^\s*(목적|정의|적용\s*범위|적용\s*대상|주요\s*내용|제안\s*이유|개정\s*이유|개정\s*취지|부\s*칙|총\s*칙|통\s*칙|구성|개요|배경|용어의?\s*정의|시행일|경과조치|별표|별지|서식)\b/;
// 본문 종결을 두 부류로 분리(과강등 방지):
//  · VERBAL_TAIL: 강한 서술형 어미(문장)·디코드 실패(�) — 어떤 줄이든 본문으로 강등.
//  · NOMINAL_TAIL: 명사형 종결(등/사항/경우/때) — 본문 단편일 수도, 조문 제목일 수도(예: "제8조(…한도 등)").
//    조/장/절 제목(HEADING_JO)에선 허용하고, 비-조 라인에서만 강등 신호로 본다.
const VERBAL_TAIL =
  /(다|함|음|임|됨|것임|하였음|바람|한다|된다|이다|이며|하며|하여|위함|예정이다|목적으로)\s*[.)]?\s*$|�/;
const NOMINAL_TAIL = /(등|사항|경우|때)\s*[.)]?\s*$/;

/**
 * 헤딩 분류 정규화 — PDF/HWP 공통으로 본문 줄이 통째로 '헤딩'으로 태깅되는 문제 교정.
 *  · PDF(AI 가이드라인): 본문 문장이 줄단위 h3
 *  · HWP(모범규준 등): 모든 문단이 ParaShape HeadingType=L3 ("① 이 규준은…", "1. 자산운용회사 : …")
 * 규칙(보편·하드코딩 없음): 헤딩은 **짧은 표제**만 유지한다.
 *  - 제N조/장/절 제목 → 보존(≤55). 단 '…한다/된다' 같은 강한 서술형 어미면(제N조로 시작하는 문장) 본문.
 *    명사형 종결(…등/…사항/…경우)은 정상 조문 제목이므로 강등하지 않음(과강등 방지).
 *  - 짧은 표제어 → 보존
 *  - 그 외: 서술형/명사형 종결·콜론정의·� 포함 또는 길면(>25) → '문단' 강등(시작이 ①·1.·가.여도)
 * 효과: 복원 헤딩벽 제거 + 목차 정상화 + 내규 청킹을 조(條) 단위로(항·호 과세분화 방지).
 */
function isShortHeadingTitle(t: string): boolean {
  // 조/장/절 제목: 명사형 종결(등/사항/경우/때)은 허용, 강한 서술형 어미만 본문으로.
  if (HEADING_JO.test(t)) return t.length <= 55 && !VERBAL_TAIL.test(t);
  if (VERBAL_TAIL.test(t) || NOMINAL_TAIL.test(t)) return false; // 비-조 라인: 서술형/명사형 종결 → 본문
  if (HEADING_WORD.test(t)) return true;
  return t.length <= 25; // 짧은 명사형 표제·절번호(1.1 등)·짧은 라벨
}
function demoteProseHeadings(blocks: IRBlock[]): { blocks: IRBlock[]; demoted: number } {
  let demoted = 0;
  const out = blocks.map((b) => {
    if (b.type !== "heading") return b;
    const t = (b.text ?? "").trim();
    if (!t || isShortHeadingTitle(t)) return b;
    demoted++;
    const { level: _omit, ...rest } = b as IRBlock & { level?: number };
    return { ...rest, type: "paragraph" } as IRBlock;
  });
  return { blocks: out, demoted };
}

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
  // PDF 라우팅: config.pdfParser==="rookie" 면 PDF만 Rookie 사이드카에 위임(HWP/HWPX는 항상 kordoc).
  //   실패/미가동 시 kordoc 으로 폴백(무중단).
  const isPdf =
    /\.pdf$/i.test(filename) ||
    (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-");
  if (isPdf && config.pdfParser === "rookie") {
    try {
      const { parsePdfViaRookie } = await import("./pdf-rookie");
      return await parsePdfViaRookie(buffer, filename);
    } catch (e) {
      console.warn(`[PARSE] Rookie PDF 파서 실패 → kordoc 폴백: ${(e as Error).message}`);
    }
  }

  const { parse, createVlmOcrProvider } = await loadKordoc();

  // 이미지 기반 PDF는 자동으로 VLM OCR로 라우팅됨 (텍스트 PDF엔 호출 안 됨)
  const ocr = createVlmOcrProvider({
    endpoint: `${DGX_URL}/v1/chat/completions`,
    model: DGX_MODEL,
  });

  // parse()는 pdfjs가 buffer의 ArrayBuffer를 detach할 수 있어, VLM 페이지 복구용 복사본을 미리 확보
  const recoverBuf = isPdf && config.vlmRecoverEnabled ? Buffer.from(buffer) : null;
  const result = await parse(buffer, { ocr, removeHeaderFooter: true } as ParseOptions);

  if (!result.success) {
    const msg = ERROR_MESSAGES[result.code ?? ""] ?? result.error ?? "파싱 실패";
    throw new Error(msg);
  }

  if (!result.markdown || !result.markdown.trim()) {
    throw new Error("문서에서 추출된 텍스트가 없습니다.");
  }

  let markdown = normalizeMarkdown(result.markdown);

  const usedOcr = (result.warnings ?? []).some((w) => w.code === "OCR_FALLBACK")
    || (!!result.isImageBased);

  const warnings = (result.warnings ?? []).map((w) => w.message);
  const q = assessQuality(markdown, !!result.isImageBased, result.pageCount);
  if (q.lowQuality && q.warning) {
    warnings.push(q.warning);
    console.warn(`[PARSE] 품질 의심: ${filename} — ${q.warning}`);
  }

  // #4: kordoc PDF 품질 신호(ToUnicode 손상/PUA/제어문자 등으로 텍스트층은 있으나 깨진 PDF) —
  //     문자수 휴리스틱보다 정확. needsOcr면 OCR 권장 경고 + lowQuality 승격.
  //     (실제 강제 재OCR은 페이지 렌더 의존성 필요 → 후속. 현 단계는 정확 감지·표면화)
  const qs = result.qualitySummary;
  const kordocNeedsOcr = !!qs?.needsOcr && !usedOcr;
  const recoveredBlocks: IRBlock[] = [];
  let recoveredOcr = false;
  if (kordocNeedsOcr) {
    const cand = qs?.ocrCandidatePages ?? [];
    const hangul = Math.round((qs?.avgHangulRatio ?? 0) * 100);
    // 에이전틱 복구: 손상 의심 페이지를 렌더→VLM OCR로 텍스트 복구(PDF·상한 내·활성화 시)
    if (isPdf && config.vlmRecoverEnabled && recoverBuf && cand.length > 0 && cand.length <= config.vlmRecoverMaxPages) {
      try {
        const rec = await recoverLowQualityPages({
          buffer: recoverBuf,
          pages: cand,
          ocr: ocr as unknown as OcrFn,
          maxPages: config.vlmRecoverMaxPages,
        });
        if (rec.length > 0) {
          recoveredOcr = true;
          // 분석/매칭이 복구 내용을 보도록 markdown에 합치고, 복원용 blocks도 추가
          for (const r of rec) {
            markdown += `\n\n<!-- VLM 복구 페이지 ${r.page} -->\n${r.text}`;
            recoveredBlocks.push({ type: "heading", level: 3, text: `[복구 페이지 ${r.page}]` } as IRBlock);
            for (const para of r.text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)) {
              recoveredBlocks.push({ type: "paragraph", text: para } as IRBlock);
            }
          }
          const msg = `글꼴 손상/스캔 의심 ${rec.length}개 페이지를 VLM OCR로 복구함(p.${rec.map((r) => r.page).join(", ")}).`;
          warnings.push(msg);
          console.log(`[PARSE] VLM 페이지 복구: ${filename} — ${msg}`);
        }
      } catch (e) {
        console.warn(`[PARSE] VLM 페이지 복구 실패: ${filename} — ${(e as Error).message}`);
      }
    }
    if (!recoveredOcr) {
      const msg = `텍스트 추출 품질 저하 — OCR 권장(품질 의심 ${cand.length}개 페이지, 한글 추출비율 ${hangul}%). 스캔본 또는 글꼴 매핑 손상 가능.`;
      warnings.push(msg);
      console.warn(`[PARSE] 품질 신호: ${filename} — ${msg}`);
    }
  }

  // 헤딩 과분류(본문 줄이 전부 헤딩) 정규화 — 복원/목차/청킹 품질 개선
  const { blocks: normBlocks0, demoted } = demoteProseHeadings(result.blocks ?? []);
  if (demoted > 0) {
    console.log(`[PARSE] 헤딩 과분류 정규화: ${filename} — 본문성 헤딩 ${demoted}개 → 문단 강등`);
  }
  const normBlocks = recoveredBlocks.length ? [...normBlocks0, ...recoveredBlocks] : normBlocks0;

  return {
    markdown,
    fileType: result.fileType,
    pageCount: result.pageCount,
    isImageBased: !!result.isImageBased,
    usedOcr: usedOcr || recoveredOcr,
    lowQuality: q.lowQuality || (kordocNeedsOcr && !recoveredOcr),
    blocks: normBlocks,
    outline: result.outline ?? [],
    title: pickTitle(result.metadata?.title, markdown, filename),
    warnings,
  };
}

