# 순수 Python doc-AI 사이드카(Docling) 통합 — 최종 설계 (ADR)

> 대상: `lib/parse-document.ts` · `lib/pdf-docling.ts`(신규) · `services/doc-ai`(신규)
> 원칙: 근본·최소수정 / 외부화 / 무중단(kordoc·`PDF_PARSER` 폴백 유지) / 과한 모듈·언어 이전 지양 / 폐쇄망
> 산출 근거: 7개 서브시스템 심층분석 + 3개 적대적 비판 검토(다운스트림 계약·성능·배포/라이선스) + 코드 직접 재확인
> **판정: 가(조건부)** — 0~2단계 즉시 착수, 3·4단계는 GPU 용량·DGX 도달성·골든 회귀 게이트 통과 전제

---

## 1. 목표와 비목표 — 무엇을 바꾸고 무엇을 그대로 두나

교체 표면을 **사이드카 내부로 한정**한다. 현 코드는 이미 `config.pdfParser` 분기 + `parse-document.ts` try/catch 폴백으로 PDF 파서를 격리해 두었다. 새 Docling 사이드카는 기존 Rookie의 HTTP 계약(`POST /parse`, 포트 8900)을 물려받는다.

**정정(초안 "TS 변경 0"은 과장)**: `config.ts`의 `pdfParser`는 `'kordoc'|'rookie'`로만 정의돼 `'docling'` 추가는 실제 TS 변경이다. 정직하게 한정 — **신규 TS = config 분기 1줄 + 어댑터 1파일(`pdf-docling.ts`)**. 무수정인 것은 **다운스트림 4소비자 · compose 토폴로지 · env 키**.

| 목표 (바꾼다) | 비목표 (그대로 둔다) |
|---|---|
| Rookie/ODL **Java CLI 제거** → 순수 Python Docling 일원화 | **HWP/HWPX/HWPML/DOCX/XLS는 kordoc-TS 인프로세스 유지** |
| 사이드카 **티어링**: 디지털=pypdfium2/pdfminer, 복잡·스캔=Docling | `ParsedDoc`·`IRBlock` **외부 스키마 불변**(4소비자 무수정) |
| OCR/VLM 복구 **사이드카 흡수**(3단계) → Node `@napi-rs/canvas` 제거 | kordoc PDF 폴백(pdfjs-dist) **당분간 보존**(무중단 안전망) |
| 사이드카가 **품질신호(needsOcr/lowQuality)** 응답 포함 → 재OCR 트리거 복원 | `bbox` 통합·`outline` 고품질화 — 다운스트림 미소비(과투자 금지) |
| Docling 표를 **kordoc IRTable 조밀 2D 그리드**로 정규화 | kordoc formula/Print(puppeteer) — dead path, 손대지 않음 |
| 이미지 **base64→Uint8Array + 키 리네임** 어댑터 | |

**HWP를 kordoc-TS에 두는 이유**: ① 경계가 이미 깨끗(PDF만 분기, 비PDF 전부 kordoc 단일 진입). ② HWP는 이미지 렌더가 없어 사이드카 이전의 최대 이득(네이티브 렌더 deps 제거)이 없음. ③ 한국 공문서 HWP 파싱은 kordoc의 핵심 자산 — Python HWP는 열위. "과한 언어 이전 지양" 원칙 부합. 단, `IRBlock` 스키마는 HWP 경로와 **공유**되므로 사이드카 blocks가 이를 어기면 일관성이 깨진다(§3이 절대 요건).

## 2. 최종 아키텍처 · 데이터 흐름

```
Next.js 런타임(Node, 폐쇄망)
  업로드 buffer → parseDocument(buffer, filename)        [lib/parse-document.ts]
        ├─ .txt → 인프로세스 직접 처리
        ├─ PDF && pdfParser==='docling' ─ HTTP POST /parse {filename, content_base64} ─┐
        │     (try/catch 실패 시 ↓ kordoc 폴백 = 무중단)                                │
        ├─ HWP/HWPX/DOCX/XLS + 폴백된 PDF → loadKordoc() (동적 import) ── kordoc-TS     │
        │     · PDF 폴백(pdfjs-dist) + VLM 재OCR(B경로)                                  │
        ▼                                                                               │
  어댑터(pdf-docling.ts): base64→Uint8Array+키리네임 · 표 그리드 검증 · markdown 신뢰 · blocks=[] 폴백
        ▼
  pipeline.run() → render-blocks · amendment-table · manual-chunk · analyze/judge
                                                                                        │ HTTP :8900
  doc-ai 사이드카(FastAPI, 순수 Python, services/doc-ai) · 워커=1~2 + 세마포어 ◀────────┘
   /health → 모델 프리로드 완료 후에만 ok(로딩 중 503) · compose healthcheck 신규
   /parse  → ① pypdfium2 1-pass 스캔(텍스트량·이미지비율·표선/2열 신호)
            ├─ 디지털·단순 → 빠른경로 pypdfium2/pdfminer.six → IRBlock + pageQuality
            └─ 복잡·스캔·신구표 → Docling(Layout+TableFormer, do_ocr=False)
                                   → 스캔/손상 페이지 → DGX VLM(정본)  [172.23.80.102:8000]
```

## 3. 사이드카 HTTP 계약 (IRBlock 불변식)

기존 Rookie 계약을 보존·확장. 응답 200(`ParsedDoc` 직매핑):

```jsonc
{
  "markdown": "...",            // §3-B: 사이드카 markdown 신뢰 + normalizeMarkdown (재생성 비채택)
  "title": "○○○ 운영규정 일부개정",  // ★신규: pickTitle 첫 인자(현 rookie는 title 버림)
  "blocks": [ /* IRBlock — 불변식 아래 */ ],
  "outline": [],                // 업로드경로 미소비 — 형식만 충족
  "pageCount": 12, "isImageBased": false, "usedOcr": false,
  "lowQuality": false,          // ★신규: 사이드카 직접 계산(현 rookie는 false 고정 — 결함)
  "qualitySummary": {           // ★신규: kordoc DocumentQualitySummary 상당(품질게이트 복원)
    "needsOcr": false, "ocrCandidatePages": [], "avgHangulRatio": 0.41
  },
  "warnings": []                // 평탄 string[]
}
```

**어댑터는 캐스팅 금지, 명시 매핑 + 런타임 검증(실패=throw → kordoc 폴백).** 필드별 충족 책임:

| 필드 | 불변식 / 소비자 | 책임 |
|---|---|---|
| `type` | 정확히 6개 리터럴(heading/paragraph/table/list/image/separator). 신규 타입 금지(render-blocks switch) | 사이드카 |
| `table.cells` | 조밀 rows×cols + 병합 빈셀 채움 + 좌상단 span. **모든 데이터 행을 cols 길이로 패딩.** amendment-table `cells[r][c]` | **사이드카(핵심)** |
| `colSpan/rowSpan` | 항상 ≥1 | 사이드카 |
| `hasHeader` | = rows>1(레이아웃 힌트). 의미적 헤더로 바꾸면 검색 recall 회귀 | 사이드카 |
| `cell.text`의 `\n` | mergeContinuationRows·linearize 분리자. '\n' 통일 | 사이드카 |
| `level` | heading 1–6, 단조. manual-chunk path 스택 | 사이드카 raw → TS 후처리 |
| `pageNumber` | 1-based | 사이드카 |
| `imageData` | **(high)** `dataBase64`(string) 전송 → `data:Uint8Array` **키 리네임 + 디코드**. 얕은 spread 시 `data` undefined → 폐쇄망 이미지 무음 누락 | 어댑터 |
| `markdown` | 비면 throw→폴백. **사이드카 신뢰 + normalizeMarkdown**(재생성 비채택) | 어댑터 |
| `title` | 응답에 `title` 추가 → `pickTitle(data.title, markdown, filename)`. 미제공 시 graceful fallback | 어댑터+사이드카 |
| blocks=[] 폴백 | 비면 markdown 문단으로 폴백(`parse-document` L268-276 복제/공통화) | 어댑터 |

**imageData 매핑(어댑터 의사코드)**:
```ts
imageData: img ? {
  data: Uint8Array.from(Buffer.from(img.dataBase64, 'base64')),  // ★키 리네임 dataBase64→data
  mimeType: img.mimeType, filename: img.filename,
} : undefined
// 검증: type==='image'면 imageData.data가 length>0인 Uint8Array. 실패→throw(무음통과 금지)
```

**markdown 재생성 비채택(초안 변경)**: `blocksToMarkdown` 재생성은 (a) `loadKordoc()`을 정상경로에 상주시켜 "PDF는 kordoc 경계 무관" 서술과 충돌, (b) 표를 HTML `<table>`로 직렬화해 `extractEffectiveDate` 시행일 정규식이 표 안 날짜를 놓칠 수 있고, (c) `bodyChars<minBodyChars(300)` 게이트로 정상 문서가 '추출 불가' 단락 위험. → **사이드카 markdown 신뢰 + normalizeMarkdown만 적용**(현 rookie 방식), 동등성은 골든으로 보증.

## 4. 티어링 라우팅 규칙 · 워크로드 가정

티어 판별은 **사이드카 내부**, 외부 계약 불변. 진입부 pypdfium2 1-pass 스캔 후 분기. 모든 임계는 **env 외부화** + kordoc `quality.ts` 상수 정렬.

| 티어 | 판별 신호(페이지 집계) | 엔진 | 임계(env) |
|---|---|---|---|
| 빠른경로 | 텍스트층 충분·이미지면적비 낮음·표선 없음·신구표 신호 없음 | pypdfium2 + pdfminer.six | `FAST_MIN_CHARS_PER_PAGE=80`, `IMG_AREA_MAX=0.5` |
| Docling | 표선/복잡 레이아웃·**신구조문대비표(현행│개정)**·다단 컬럼·이미지면적비 높음 | Docling(Layout+TableFormer) | `TABLE_LINE_TRIGGER=true`, `DOCLING_FORCE_ON_TABLE=true` |
| Docling+OCR | 스캔(<10자/페이지) 또는 needsOcr 손상 페이지 | Docling(do_ocr=False) + DGX VLM | `SCAN_MAX_CHARS_PER_PAGE=10`, `DOC_OCR_RATIO=0.3` |

**⚠️ 워크로드 가정(성능 high 수용)**: "디지털=대다수 빠른경로" 전제는 **주력 워크로드에서 뒤집힌다**. 이 앱의 주력 입력은 규제 개정안이고 한국 개정 문서의 핵심은 신구조문대비표인데, amendment-table 추출(pipeline L183)이 살아나려면 그 문서가 전부 Docling으로 간다. → **SLO 산정 기준 = "주력 개정문서는 Docling 티어가 정상"**, 빠른경로 절감은 신구표 없는 단순 텍스트에 한정해 보수적 회계. (장기 옵션: 페이지 단위 혼합 티어링 — 1차 범위 제외, 과투자 방지.)

## 5. Docling 출력 → IRBlock 매핑

- **표**: Docling TableFormer 출력 → `IRTable{rows, cols, hasHeader, cells[][]}`. 병합셀은 좌상단에 span 표기 + 나머지 좌표 빈셀 채움. **모든 데이터 행을 cols 길이로 패딩**(ragged 그리드 → amendPairs 무음 과소추출 차단).
- **heading level**: Docling raw level 수신 → TS `detectLegalStructure` 단조 승격 1회. **demoteProseHeadings를 PDF 사이드카 반환 경로에도 공통 적용**(현재 kordoc 경로에만 있어 비대칭 → 과분류 헤딩 복원 벽 방지).
- **읽기순서**: Docling 레이아웃 순서 보존. header/footer 반복 요소 드롭.

## 6. OCR/VLM 복구 흡수 (3단계, 게이트)

- kordoc `quality.ts` 임계를 Python 포팅 → `qualitySummary`/`lowQuality` 응답 포함.
- 스캔/손상 페이지 OCR을 사이드카에서 종결: **`do_ocr=False`(EasyOCR 배제) + DGX VLM 직접 호출**(정본).
- **게이트: 사이드카→DGX 도달성 선검증** — 미달 시 분할 흡수(OCR은 Node 잔존)로 후퇴.
- **폴백: kordoc B경로(pdf-ocr-recover) 잔존 — 삭제 금지.**

## 7. 의존성 · 라이선스 · 모델 번들

**Node 제거**: `@huggingface/transformers`(Apache-2.0)·`onnxruntime-node`(MIT)·`sharp`(Apache-2.0)·`@hyzyla/pdfium`(MIT)·`puppeteer-core`(Apache-2.0) = **kordoc formula/Print dead path → 0단계 즉시 제거**. `@napi-rs/canvas`(MIT) = OCR 이관 후. `pdfjs-dist`(Apache-2.0) = kordoc PDF 폴백 폐기 후에만.

**라이선스(코드 vs 가중치 분리 — 배포 high 수용)**:
| 항목 | 코드 | **가중치** |
|---|---|---|
| Docling | MIT | **ds4sd/docling-models = CDLA-Permissive-2.0** (MIT 아님 — 고지 동봉) |
| EasyOCR | Apache-2.0 | **기본 CRAFT(Clova) = 연구·비상업 제한** → `do_ocr=False`로 **배제** |
| pypdfium2 | BSD-3(PDFium) | — |
| pdfminer.six | MIT | — |

**폐쇄망 모델 번들**: Docling Layout/TableFormer 가중치를 **이미지에 굽기 + 커밋 해시 핀** · `HF_HUB_OFFLINE=1` + 모델경로 env 고정 · **빌드 스모크(필수 모델 존재 + EasyOCR/CRAFT 미포함 검증)** · pip 사내 미러 `--no-index` · `docker save`→tar 분할 반입. footprint: PyTorch로 이미지 수GB → **CPU-only torch wheel + 멀티스테이지**(155MB 상쇄는 오류 — Node/Python 별개 이미지).

## 8. 무중단 마이그레이션 단계

각 단계 독립 롤백 가능, 전 단계에서 `config.pdfParser` 라우팅 + kordoc 폴백 유지(무중단). 3·4단계에 명시적 게이트.

| 단계 | 작업 | 폴백/게이트 |
|---|---|---|
| **0 사전** | dead-path deps 제거(transformers/onnx/sharp/pdfium/puppeteer), `@napi-rs/canvas` 명시 선언. **골든 하네스**(`scripts/test-parse-samples.ts` 확장: kordoc↔사이드카 diff — amendPairs·청크수·data URI·markdown 파생값(시행일/bodyChars/docNature)·**Docling 지연 p50/p95**·표밀도↔지연 상관) | 파싱 동작 무변경(dead path만) |
| **1 계약** | `config.pdfParser`에 `'docling'` 추가 + 어댑터 `pdf-docling.ts`(base64 키리네임 디코드 + 표 그리드 검증 `cells[r].length===cols` + title 전달 + blocks=[] 폴백 + demoteProseHeadings 공통). 기본값 kordoc | opt-in(기본 kordoc) |
| **2 사이드카** | ODL subprocess → Docling `iterate_items()`. 빠른경로 + 티어판별 + 표 조밀그리드 + header/footer 드롭. **compose healthcheck 신규**(`/health`, start_period≥워밍업, `depends_on: service_healthy`). **self-timeout < `rookieTimeoutMs`** + 서버측 취소(좀비 차단). **동시성 세마포어**(워커1~2, 포화 503). Dockerfile JRE 삭제 + 모델 번들 | 사이드카 실패/503→catch→kordoc |
| **3 OCR 흡수** | quality.ts Python 포팅 → `qualitySummary`/`lowQuality`. 스캔/손상 OCR 사이드카 종결(do_ocr=False + DGX VLM) | **GATE: DGX 도달성** / 폴백: kordoc B경로 잔존 |
| **4 전환** | 골든 회귀 통과 후 `PDF_PARSER` 기본 docling. **cfgSig에 `config.pdfParser` 추가**(수동 bump 의존 제거, A/B 오염 방지). 파싱 캐싱 키 전수 열거(REPORT v56 + UI v20 등) 동시 bump 확인 | **GATE: 골든 회귀** / 롤백: `PDF_PARSER=kordoc` 한 줄 |
| **5 정리** | 안정 후 `@napi-rs/canvas` 제거 → (최종) `pdfjs-dist`·next.config externals 정리. **HWP/HWPX kordoc 끝까지 유지** | 폴백 폐기는 운영 데이터 확보 후 |

## 9. 성능 설계 · SLO · 동시성

- **동시성 이중 가드 정렬(high)**: `route.ts` `inFlight≥maxConcurrentPipelines(3)` 429는 *파이프라인* 단위 → 3개가 동시에 모델 상주 사이드카에 도착해 GPU/RAM 경합 가능. → **사이드카 자체 세마포어**(GPU 단일이면 워커=1 직렬화 + 짧은 큐/즉시 503), `maxConcurrentPipelines`와 **별도 env 정렬**. 포화 503→폴백.
- **종단지연(med)**: LLM 지배는 평균엔 맞으나(total 600s/실측 500s대, 파싱 1회) **파싱은 직렬 선행이라 오버랩 불가** → 콜드스타트/대형스캔 120s면 전체 ~20%. 파싱 지연 SLO(p50/p95)를 LLM과 분리 트래킹, 콜드스타트는 헬스체크 warmup으로 분리, 스캔 VLM 비용은 600s 예산에 파싱 몫 명시 배정.
- **웜 유지**: Docling 모델 **영구 상주(언로드 금지)**.
- **지연 SLO**: 골든 하네스에서 페이지수·복잡도·**표밀도별 Docling 지연 p50/p95** 측정 → `rookieTimeoutMs`·self-timeout·`DOCLING_MAX_PAGES` 정렬.
- **GPU 배치 결정변수**: 전용 GPU / DGX 공유 / CPU-only. DGX는 이미 임베딩·리랭크·분석LLM·VLM 호스팅(포화 가능) → **GPU 인벤토리 확인 후 결정**, 여유 없으면 CPU-only 기본 + 진입 가드.
- **타임아웃 정합**: self-timeout ≤ `rookieTimeoutMs`. 대형 스캔용 상향은 600s와 충돌하므로 진입 가드로 Docling 진입 제한.
- **네트워크/페이로드**: 30MB PDF→base64 ~40MB. imageData 많으면 응답 JSON 수십MB → 비핵심 이미지 드롭/multipart 검토. 캐시 히트 경로도 부하 테스트 포함.

## 10. 리스크 (요지)

| 심각도 | 리스크 | 완화 |
|---|---|---|
| 높음 | blocks 빈약/부분성공 200 → silent degrade | 어댑터 검증=throw(cells 정합·type 6리터럴·이미지 디코드·markdown 공백). 모델 로드 실패 시 /health ok 금지·/parse 5xx. 골든 회귀 |
| 높음 | 신구조문대비표 amendPairs 무음 과소 | 규칙2 무조건 Docling. cols 패딩+검증. amendPairs=0 경보. 2열+병합 골든 픽스처 |
| 높음 | 라이선스 위반(EasyOCR/CRAFT 비상업) | do_ocr=False + 미설치, DGX VLM 정본. 빌드 스모크 검증. Docling CDLA 고지 |
| 중간 | 대형 스캔/표다수 Docling 타임아웃 | 진입 가드(DOCLING_MAX_PAGES). self-timeout 정렬. SLO 후 조정 |
| 중간 | GPU 경합/용량 미산정 | 인벤토리 확인을 배치 결정변수로. CPU-only 기본 검토. 세마포어 직렬화 |
| 중간 | compose 헬스체크 부재 | healthcheck 신규 + start_period + depends_on:service_healthy |
| 중간 | 이미지 복원 회귀(키 리네임 누락) | 어댑터 명시 매핑+length>0 단언. 이미지 PDF 골든 픽스처 |
| 낮음 | 캐시 A/B 오염 | cfgSig에 pdfParser 추가. 파싱 캐싱 키 전수 열거 |

**설계 요지**: 교체 표면 = 사이드카 내부 + 어댑터 1파일 + config 1줄(다운스트림·compose·env 무수정). 최대 위험은 코드 에러가 아니라 **"에러 없는 품질 열화"** → 어댑터 검증(실패=throw) + 골든 회귀 + 헬스체크/타임아웃 정렬 + 라이선스 분리 검증으로 차단. HWP/kordoc·bbox·outline·formula 미변경.

## 11. 비판 반영 요약

3개 적대 리뷰 23건 처분: **high 7 전부 수용 · medium 11 수용(1 대안) · low 5 수용 · 기각 1 · 정정 3**.
- **기각 1(#3)**: "amendment-table 무방비 throw"는 과대평가 — 코드 재확인 시 전부 optional chaining(throw 안 함). '무음 과소추출'로 문구 정정 + cols 패딩 대응.
- **정정 2**: #2 markdown 재생성 → 사이드카 markdown 신뢰+골든 동등성(대안). #23 footprint 155MB 상쇄 → Node/Python 별개 이미지라 상쇄 아님.
- **자기모순 해소(#4)**: title 권고 vs 응답 스키마 충돌 → 응답에 title 추가 + 어댑터 전달.
- **라이선스 high(#16/#17)**: Docling 가중치 CDLA, EasyOCR CRAFT 비상업 → do_ocr=False + DGX VLM 정본.
- **성능 high(#8/#9/#10)**: 신구표=주력=Docling 워크로드 가정 명시, p50/p95 SLO, 사이드카 세마포어 정렬.

## 12. 최종 추천 — 가(조건부)

설계 골격(HTTP 계약 보존·어댑터 1파일·티어링·kordoc 폴백 무중단·IRBlock 불변식·AGPL 회피)은 세 리뷰 모두 타당 판정. high/medium 이슈는 설계를 뒤엎는 결함이 아니라 **명세 보강·게이트 추가**로 흡수. 단 3·4단계는 게이트 전제.

**진행 순서**:
1. **즉시(저위험)**: 0단계(deps 정리 + 골든 하네스) → 1단계(config 분기 + 어댑터). opt-in이라 위험 낮음.
2. **사이드카(2단계)**: Docling app.py + 헬스체크 + self-timeout + 세마포어 + JRE 삭제 + 모델 번들. 기본 여전히 kordoc.
3. **게이트 A(GPU 용량·DGX 도달성)** 통과 시에만 **3단계(OCR 흡수)**. 미달 시 분할 흡수 후퇴.
4. **게이트 B(골든 회귀)** 통과 시에만 **4단계(기본 docling + cfgSig 파서 시그니처)**.
5. **관망 후 5단계**(네이티브 deps 정리). HWP/kordoc 끝까지 유지.

**부(중단) 조건**: (a) GPU가 Docling 상주 불가 + CPU-only로도 SLO 미달, (b) DGX 도달성 확보 불가 *그리고* 분할 흡수도 부적합, (c) 골든에서 신구표 amendPairs 유의 감소. 무중단 폴백 덕에 어느 지점에서 멈춰도 가용성 유지.
