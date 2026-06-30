# compliance-ibk 통합 — law-core-ai 문서변환기 → kordoc(/api/convert) (ADR + E2E 검증)

> 대상: `compliance-ibk/docker-compose.yml` · `ibk-poc/app/api/convert/route.ts`(신규) · law-core-ai `conversion.py`/`container.py`(무수정, 설정만)
> 원칙: 근본·최소수정 / 외부화 / 무중단(local 폴백 유지) / 과한 모듈 지양 / 폐쇄망 / main 무손상(브랜치)
> **판정: PASS-WITH-RISKS** (2026-06-30 E2E 실증 — 11개 에이전트 적대 검증, high 차단 이슈 없음)

---

## 1. 결정 — 무엇을, 왜 kordoc 인가

law-core-ai 의 분석 파이프라인(bill/policy 처리)이 문서를 변환할 때 **기존 PyPDF2(평문) 대신 ibk-poc 의 kordoc 파서**를 쓰도록 변환기를 재지정한다.

**왜 kordoc** — law-core-ai 의 신구조문대비표 추출은 변환 **텍스트의 표 구조에 의존**한다(`bill_parser.py`: `split_by_comparison_table`·`has_current_revised_headers`·`_parse_with_llm(comparison)`). 따라서 변환기가 신구표를 표로 보존해야 분석이 산다.

| | 스캔/OCR | 신구조문대비표 | HWP/HWPX |
|---|---|---|---|
| PyPDF2(기존 local) | ✗ 깨짐 | ✗ 평탄화 | ✓ |
| doc-ai(Docling) | ✓ | **✗ 한글 신구표 표 미인식**(평탄화) | ✗(415) |
| **kordoc(채택)** | ✓ | **✓ 표로 보존 → `\| 현행 \| 개정안 \|`** | ✓ |

doc-ai(Docling 사이드카)는 한글 신구표를 표로 잡지 못해(`docling-사이드카-통합설계.md` 참조) law-core-ai 분석엔 손해였다. kordoc 은 신구표를 표로 보존(+`extractAmendmentPairs` 로 `{현행,개정}` 구조쌍까지)하고 HWP/HWPX·스캔 OCR 도 처리 → PyPDF2·Docling 양쪽보다 분석 입력이 우수. **doc-ai 는 `profiles:["docling"]` opt-in 폴백으로 강등**(기본 미기동).

## 2. 아키텍처 — 순수 설정 배선(law-core-ai 코드 변경 0)

```
law-core-ai (core-ai/worker, FastAPI 배치)
  └ DocumentConverter(use_local=false, converter_url=http://compliance-poc:4000/api)
      └ _convert_remote: POST {url}/convert  multipart "file"  → result["data"]["text"]
          └ (4xx/5xx/timeout) → _convert_local(PyPDF2/hwp5txt) 폴백  ← 무중단
              ▼
ibk-poc compliance-poc:4000  POST /api/convert
  └ parseDocument(buffer, filename)  ← kordoc (신구표=표, HWP/HWPX, 스캔 OCR)
      └ { data: { text: doc.markdown } }   (미지원 ext → 415)
```

**compose**(`compliance-ibk` 브랜치 `feat/ibk-docai`, docker-compose.yml 단일 변경):
- `PDFHWP_CONVERTER_USE_LOCAL=false`, `PDFHWP_CONVERTER_URL=http://compliance-poc:4000/api`
  (core-ai + worker 가 `&core_ai_environment` 앵커로 동일 상속)
- `doc-ai` 서비스 `profiles:["docling"]` — 기본 비활성. core-ai `depends_on` 미추가(변환기는 lazy + local 폴백이라 기동 결합 불요)

**계약 일치**: law-core-ai `SUPPORTED_FORMATS`(pdf/hwp/hwpx/docx) = ibk-poc `allowedUploadExts` → 정상 트래픽에서 스퓨리어스 415 없음. `_convert_remote` 의 `{url}/convert` = `http://compliance-poc:4000/api/convert` = Next.js 라우트 경로.

**소비처**: `bill_processor`/`policy_processor` → `parse_bill`/`parse_policy` → LLM(comparison/body) 추출 → `matcher`. **bill 안전망**: `bill_processor` 는 `get_bill_provisions`(국회 의안 API/DB)에서 신구표를 변환 텍스트와 **독립 회수** → 변환이 부실해도 bill 신구표 매칭 가능.

## 3. E2E 검증 결과 (PASS-WITH-RISKS, 2026-06-30)

백엔드(core-ai/qdrant/dgx) WireGuard 도달 활성 상태에서 라이브 실측.

**✅ 실증된 작동 기능**
- 계약 정합: URL/`multipart "file"`/`{data:{text}}` 응답 — 저장 결과파일로 실측 확인
- 멀티포맷: PDF(가이드라인 57,024자/표 162행), HWP(완전추출), HWPX(충실; 원문 표0건은 XML 교차확인), 미지원 `.xyz`→415 폴백계약
- **신구조문대비표 보존**: 전자금융거래법 개정령안 PDF 표 243행 `\| 현행 \| 개정안 \|`; 예금자보호법 HWPX `\| 현 행 \| 개정안 \|`·PDF ×2
- **의안국/의안과/의안원문 12건** 전부 200, **11건 신구표 헤더 검출**(u7만 비개정), 스캔 의안도 OCR 후 검출
- 라우팅: 파이프표의 '현행/개정안' 단어가 `has_current_revised_headers` 통과 → LLM comparison 경로 진입(마크다운이 라우팅에 유리)
- **풀 파이프라인 진짜 분석**(degraded 아님):
  - `s.hwp`(광고판단기준) 336s, 영향내규 10건, 8,294자 영향분석 보고서
  - `의안 2125622`(금융소비자보호법 일부개정법률안) 305s, 영향내규 12건, 신구표 개정내용(화상권유판매 신설·명부작성·500만원 과태료)을 정확히 도출, 법률안 단계 조건부 처리
- 무중단 폴백 + 변환 성능 정상(디지털 0~1s, 성공 OCR 16~49s < 60s 캡)

**⚠️ 확정 리스크 / 운영 투입 전 권고**

| 심각도 | 이슈 | 권고 |
|---|---|---|
| med | 규칙기반 fallback(`_parse_comparison_table_text`+`JO_PATTERN ^제`+`_split_line`)이 **마크다운 파이프표에서 0건** 산출(`\|제5조(` 가 `^제` 앵커에 안 걸림). policy 경로는 DB provisions 안전망이 없어, **폐쇄망 LLM 장애 시** 신구표 안전망 붕괴 가능 | convert→parse 사이 마크다운→raw 정규화(파이프/구분선 제거·셀→탭), 또는 `JO_PATTERN`/`_split_line` 파이프표 인식. fallback 0건 시 경고/메트릭 노출 |
| med | 분석 백엔드가 dev 모드 프론트(compliance-poc, `next dev`)에 역의존하나 `depends_on`/`healthcheck` 부재 → 콜드스타트·재시작 구간 변환이 조용히 PyPDF2 폴백(`logger.warning` 1줄만) | compliance-poc healthcheck 추가 + core-ai/worker `depends_on` 게이팅, 폴백을 메트릭/알람으로 승격 |
| low | `_convert_remote` `timeout=60s` — 진짜 60s+ OCR 신구표 문서(자금조달류, amendPairs 실재)는 절단 후 PyPDF2 폴백(OCR 소실). 저빈도·국소 | OCR용 별도 타임아웃 ≥120s(`PIPELINE_TIMEOUT_MS` 180s 정합), connect/read 분리 |
| low | `policy_processor` 콘텐츠 부족 스킵 가드 부재(bill 은 `len<100 AND no provisions`) → 극소/빈 추출이 메타 대체 후 '제목만 매칭' 진입 가능 | policy 에도 콘텐츠 가드 추가, convert 경계 최소 본문길이 게이트 |
| low/info | `.doc` 포맷 비대칭(무해, 설계된 폴백) · success 플래그 3경로 동일(meta로 구분) · httpx 버전핀 불일치(req≥0.28 vs pyproject≥0.26) · 루트 .env DGX IP 불일치(doc-ai OFF라 무영향) | 필요 시 정합화, 강제 불요 |

> 적대 재검증에서 timeout 차원의 초기 high 발견은 정량 근거가 무너져(90s는 OCR 시간이 아닌 파스 하니스 타임아웃, 성공 OCR 전부 <50s) low 로 격하, doc-ai DGX 빈값 위험은 전제 오류로 거짓양성 제외됨.

## 4. 브랜치 / 재현

- **ibk-parser**(jaykim429): `feat/docai-python-sidecar` — `app/api/convert/route.ts`(kordoc 노출) + `services/doc-ai`(opt-in) + 본 문서
- **compliance-ibk**(seoyoung-3060): `feat/ibk-docai` — `docker-compose.yml` (푸시됨, main 무손상)
- ⚠️ `compliance-ibk/ibk-poc` 는 **gitignore된 독립 클론** — compliance 브랜치와 자동 연동 안 됨. 빌드 전 클론을 `feat/docai-python-sidecar` 로 수동 checkout 해야 route+doc-ai 포함됨.

## 5. 후속(미해결, law-core-ai = seoyoung 레포라 별도 결정)

med 2건 보강(마크다운→raw 정규화 또는 파서 인식 / compliance-poc healthcheck+depends_on+폴백 메트릭)과 OCR용 타임아웃 분리는 law-core-ai 분석 코드 변경을 수반하므로 운영 투입 전 별도 PR 로 진행 권고. 무중단성 자체는 현재도 폴백으로 보장됨.
