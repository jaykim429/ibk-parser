# kordoc — OCR 연동 통합 가이드

한국 공문서(HWP·HWPX·PDF·XLSX·DOCX) → Markdown / IRBlock 파서 + VLM OCR 연동.

## 설치

```bash
# 패키지 설치 (전달된 tgz)
npm install ./kordoc-2.9.0.tgz

# PDF 파싱용 (선택, 4.x 권장)
npm install "pdfjs-dist@^4.10"
# PDF→PDF 렌더용 (선택)
npm install puppeteer-core
```

## 1. 기본 파싱 (텍스트 레이어 문서)

```ts
import { parse } from "kordoc"
import { readFileSync } from "node:fs"

const r = await parse(readFileSync("문서.pdf"))
r.markdown      // Markdown 문자열
r.blocks        // IRBlock[] (heading/paragraph/table/...)
r.pageQuality   // PDF: 페이지별 품질 신호 (needsOcr 등)
r.isImageBased  // PDF가 스캔(이미지)인지
```

지원 구조 인식(자동): 제목·장·절·조·항·호·목·부칙·별표·별지서식 heading,
신구조문대비표(일부개정법률안) 2단 표, 표 셀 너비/테두리(HWP).

## 2. 스캔 문서 → VLM OCR 연동 (핵심)

스캔/이미지 PDF·성적서 등 텍스트 레이어가 없는 문서는 OpenAI 호환 멀티모달
엔드포인트(vLLM/Gemma-VL 등)로 구조화 복원한다.

```ts
import { parse, createVlmOcrProvider } from "kordoc"

const ocr = createVlmOcrProvider({
  endpoint: "http://<OCR서버>:8000/v1/chat/completions",
  model: "google/gemma-4-26B-A4B-it",
  apiKey: process.env.VLM_KEY,   // 선택
  // prompt: "...",              // 문서 유형별 프롬프트 오버라이드 가능
})

// 이미지 기반 PDF는 ocr provider로 자동 라우팅
const r = await parse(pdfBuffer, { ocr })
```

`createVlmOcrProvider`가 반환하는 함수 시그니처(직접 호출도 가능):
```ts
(pageImagePng: Uint8Array, pageNumber: number, mimeType: "image/png") => Promise<string>
```
→ 페이지 PNG를 받아 한국어 구조화 Markdown(표·계층)을 반환. 직접 페이지를
렌더(pdfium/sharp 등)해 호출하면 텍스트+스캔 혼합 문서도 페이지별 처리 가능.

## 3. 검색(임베딩/BM25) 최적화 출력

원본 충실 파싱과 별개로, 벡터 검색에 맞춘 청크/텍스트를 생성한다.

```ts
import { parse, toSearchChunks, summarizeChunks, createLlmSummarizer, chunksToSearchText } from "kordoc"

const { blocks } = await parse(buf)
let chunks = toSearchChunks(blocks)
// chunks[i] = { type, headingPath:[제N장>제N조...], text, needsSummary, pageNumber }

// 별표/별지서식 표에 LLM 요약 부착 (검색 recall ↑)
const summarizer = createLlmSummarizer({ endpoint, model })
chunks = await summarizeChunks(chunks, summarizer)

const searchText = chunksToSearchText(chunks)  // 청크 빈줄 구분 + 섹션경로 컨텍스트
```

- 문단 줄바꿈 정규화, 섹션 경로(제N장 > 제N조) 컨텍스트 부착, 표 "헤더=값" 선형화.

## 4. 렌더링 (검수/표시용)

```ts
import { parse, renderHtml, markdownToPdf } from "kordoc"
const r = await parse(buf)
const html = renderHtml(r.markdown)          // 표 colgroup 너비 + 셀 테두리 반영
const pdf  = await markdownToPdf(r.markdown)  // puppeteer-core 필요
```

## 권장 파이프라인 (OCR 시스템 연동)

```
문서 → parse()
  ├─ r.isImageBased == false → 네이티브 markdown/blocks 사용
  └─ r.isImageBased == true (또는 pageQuality[*].needsOcr)
        → 해당 페이지 PNG 렌더 → createVlmOcrProvider 호출 → 구조화 Markdown
→ toSearchChunks → (별표/별지 summarizeChunks) → 임베딩/색인
```

## CLI / MCP

```bash
npx kordoc 문서.pdf -o out.md      # CLI 변환
npx kordoc-mcp                      # MCP 서버 (Claude/Cursor 연동)
```
