# doc-ai 사이드카 (순수 Python Docling)

PDF를 **Docling**(파이썬 문서-AI)으로 파싱해 IBK 앱 계약(`ParsedDoc`/`IRBlock`)으로 반환한다.
레거시 `rookie-parser`(ODL **Java** CLI)를 대체 — **Java 제거, 순수 Python**.

> 설계 전문: [`docs/docling-사이드카-통합설계.md`](../../docs/docling-사이드카-통합설계.md) · 호출부: [`lib/pdf-docling.ts`](../../lib/pdf-docling.ts)

## 왜 이 스택인가 (compliance 정합)

종국적으로 ibk-parser를 **compliance-ibk에 완전 통합**하는 것이 목표다. 그 모노레포의 Python AI 코어
`law-core-ai`가 **FastAPI · Python 3.11-slim · uv · pydantic v2**를 쓰므로, 이 사이드카도 **동일 컨벤션**으로
지어 나중에 `law-core-ai`로 드롭-인 흡수 가능하게 한다. (현재 `law-core-ai`의 PDF는 PyPDF2(기본)뿐 — Docling 미사용.)

### compliance 흡수 경로 (단일 변환 서비스)

law-core-ai의 `DocumentConverter`(`src/services/conversion.py`)는 평문 text만 반환(`convert→str`)하고,
**`_convert_remote`(POST `{converter_url}/convert`, multipart → `{data:{text}}`) + 실패 시 local 폴백**을 이미 보유.
→ **doc-ai가 두 계약을 동시 서빙**해 단일 Docling 서비스로 변환을 통합한다:

- `/parse`(JSON base64 → 풍부한 IRBlock) = **ibk-parser**(블록 소비: amendment-table·manual-chunk·render-blocks)
- `/convert`(multipart → `{data:{text}}`) = **law-core-ai**(평문 소비). law-core-ai 설정: `converter_url=http://doc-ai:8900`, `use_local=False`.

효과: law-core-ai가 PyPDF2 대신 **Docling 텍스트**(복잡표·과잉OCR 문서 품질↑), ibk-parser는 **구조 그대로**, PyPDF2는 폴백으로 격하. 변환 dedup·완전통합 정합. (law-core-ai 측은 비PDF를 local로, PDF만 remote로 라우팅하면 최적 — 그건 compliance repo 작업.)

## 계약 (HTTP)

```
GET  /health → 200 {"status":"ok"}         # 모델 프리로드 완료 후에만 ok(로딩/실패 시 503)
POST /parse  { filename, content_base64 }  # ibk-parser 계약(풍부한 blocks) — lib/pdf-docling.ts
  200 { markdown, title?, blocks[], outline[], pageCount, isImageBased, usedOcr,
        lowQuality, qualitySummary{needsOcr, ocrCandidatePages, avgHangulRatio}, warnings[] }
POST /convert  (multipart file)            # law-core-ai 계약(평문) — 종국 통합용
  200 { data: { text } }                   # Docling 텍스트. PDF 외 415 → law-core-ai local 폴백
```

- `blocks`: kordoc **IRBlock 호환**. `image`는 `imageData.dataBase64`(base64)로 전송 → 어댑터가 `Uint8Array`로 디코드.
- `table.cells`: **조밀 2D 그리드**(rows×cols, 병합 빈셀 채움) — ragged 금지(신구조문대비표 amendPairs 무음 과소 차단).
- 실패/포화 → **5xx/503** → 어댑터(`pdf-docling.ts`)가 throw → **kordoc 폴백**(무중단).

## 티어링 / OCR (단계적)

- **디지털·복잡(표·신구조문대비표)** → Docling(Layout + TableFormer, `do_ocr=False`).
- **스캔/저텍스트** → `qualitySummary.needsOcr`로 **신호만**. 실제 OCR 흡수는 **3단계**(DGX VLM 정본). 그 전엔 markdown이 빈약해
  어댑터가 kordoc 폴백(B경로 VLM OCR)으로 처리 — 무중단.
- ⚠️ `do_ocr=False`로 **EasyOCR 기본 CRAFT(비상업 가중치) 미적재**(라이선스).
- [TODO 최적화] 표 없는 순수 디지털의 pypdfium2/pdfminer **빠른경로** — 성능상 파싱은 종단의 ~1~2%라 후순위(현재 Docling 단일 경로).

## 라이선스 (폐쇄망 반입 고지)

| 구성 | 코드 | 가중치 |
|---|---|---|
| Docling | MIT | ds4sd/docling-models = **CDLA-Permissive-2.0** (고지 동봉 필요) |
| pypdfium2 | BSD-3 (PDFium) | — |
| EasyOCR/CRAFT | (미사용) | 비상업 — `do_ocr=False`로 **배제**, 빌드 스모크로 미포함 검증 |

## 배포 (폐쇄망)

- `Dockerfile`: 멀티스테이지(python:3.11-slim + uv), **JRE 없음**. 온라인 빌드 단계에서 Docling 모델 프리페치 →
  `HF_HUB_OFFLINE=1`로 런타임 외부망 0. CRAFT 가중치 미포함 스모크 가드 포함.
- GPU 미할당이면 CPU-only torch wheel 권장. 모델·패키지 **커밋해시/버전 핀 + 사내 미러**.
- compose: `/health` healthcheck + `depends_on: service_healthy`로 모델 준비 전 요청 차단(설계 §8-2). 포트 8900(현 rookie 자리).

## 설정 (env, `DOCAI_` 접두)

| env | 기본 | 설명 |
|---|---|---|
| `DOCAI_MAX_CONCURRENCY` | 1 | 동시 Docling 추론(GPU 단일 직렬화). 포화 시 503 |
| `DOCAI_SCAN_MAX_CHARS_PER_PAGE` | 10 | 페이지당 이 미만 → 스캔/needsOcr 후보 |
| `DOCAI_OCR_MIN_CHARS_PER_PAGE` | 80 | 이 미만 → lowQuality |
| `DOCAI_DOCLING_DO_OCR` | false | ★ true 금지(CRAFT 라이선스). OCR은 DGX VLM |
| `DOCAI_PDF_BACKEND` | default | `default`(docling-parse, **표 감지 우수**) \| `pypdfium2`(경량·비ASCII경로 안전). 프로덕션(Linux ASCII)은 default 권장 |

## 검증 상태 (step A — 로컬 실가동, 2026-06-30)

venv(Python 3.10, docling 2.107)로 사이드카를 실제 기동해 **코드 실가동 검증 완료**:

- ✅ `/parse`·`/convert` 200, IRBlock 매핑(heading/paragraph/list)·title 추출·qualitySummary·표 dense-grid(ragged 0) 정상. `/convert`는 `{data:{text}}`(law-core-ai 계약) 동작.
- 🐞 실가동이 잡은 실버그: **python-multipart 누락**(`/convert` 필수 → requirements 반영), docling-parse 글리프 리소스가 **비ASCII(한글) 경로**에서 실패 → `DOCAI_PDF_BACKEND=pypdfium2` 옵션 추가, requirements 한글주석 cp949(Windows 로컬 한정, `PYTHONUTF8=1`).
- ⚠️ **미검증(프로덕션 G4 대상)**: **신구조문대비표(현행│개정)** 표 감지는 `default`(docling-parse) 백엔드 품질에 의존. 로컬은 한글경로 글리프 이슈로 `pypdfium2` 백엔드로 테스트했고, 이 백엔드는 신구조문대비표를 표가 아닌 텍스트로 추출함(amendPairs 이득 미확인). **Linux·ASCII·docling-parse 환경에서 G4 골든으로 확인 필요.**
