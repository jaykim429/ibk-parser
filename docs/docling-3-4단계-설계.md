<!-- Docling 사이드카 통합 3·4단계 설계 — 워크플로(검토→설계→적대비판→재조정, 7에이전트) 산출. 적대비판 high 4·med 5·low 3 처분. -->

# IBK 규제변동 영향분석 — PDF 파싱 사이드카 통합 3·4단계 **최종 설계**

> 작성: 수석 아키텍트 / 범위: 읽기·분석 기반 설계(코드 미수정) / 산출물: 로컬 텍스트(외부 송출 없음)
> 원칙: 근본·최소, 무중단(kordoc 폴백 불변), 외부화(env), 폐쇄망
> 본 최종본은 초안에 대해 제기된 high 3건·medium 4건·low 3건을 코드 재검증으로 모두 확정하고, 반영 또는 기각 근거를 명시한다. 재검증 출처는 각 항목에 파일:라인으로 인용.

---

## 0. 설계 불변식 (코드 재확인 완료)

1. **폴백은 단방향이고 견고하다.** `parse-document.ts:188-194` — `pdfParser==="docling"`이면 어댑터를 호출하고, 어댑터 throw 시 `catch`가 흡수한 뒤 **그 아래로 자연 낙하**해 `loadKordoc()`(L197~) 본경로를 탄다. 어댑터(`pdf-docling.ts`)는 HTTP 5xx(L80-81), 빈 markdown(L84), image 디코드 실패(L53-55), 표 ragged(L67-68)를 전부 throw로 변환. **3단계 OCR 추가는 이 라인을 건드리지 않는다.**

2. **docling 어댑터는 `qualitySummary`를 하류로 전달하지 않는다 (초안 핵심 오류 — 재확인 완료).** `ParsedDoc`(`parse-document.ts:42-56`)에 `qualitySummary` 필드 자체가 없고, `parsePdfViaDocling` 반환객체(`pdf-docling.ts:93-104`)는 `markdown/blocks/usedOcr/lowQuality/...`만 싣고 `data.qualitySummary`를 **버린다**. L233 `const qs = result.qualitySummary`는 kordoc `parse()`의 `ParseResult`에서만 읽힌다. → **docling 경로에서 needsOcr 신호 소거는 하류 효과가 0이다.** (high-A 반영, §4·§1-c에서 "신호 소거가 중복방지 핵심" 주장 전면 삭제.)

3. **kordoc 경로의 OCR 트리거는 둘이다 (초안 §4 누락 — 재확인 완료).** (a) **kordoc 내부 ocrPages**: `parser.ts:167` `totalChars / parsedPageCount < 10`(문서 평균 10자 미만)이면 `parse()` 내부에서 `ocrPages`(provider.ts)를 돌려 `isImageBased:true`로 종결(L171-180), 자체 `qualitySummary` 반환. 이는 페이지비율 0.3 트리거와 **무관한 별개 트리거**다. (b) 그 후 `parse-document.ts:234` `kordocNeedsOcr` → `recoverLowQualityPages`(B경로). (high-D 반영, §4 2계층 모델로 재서술.)

4. **캐시키는 단 하나.** `pipeline.ts:72` `report-${cacheVersion}-${cfgSig}:${fileHash}`(쓰기 L118/161/316). search-catalog optCache·UI v20은 파서 무관. 무효화 대상은 이 키와 `REPORT_CACHE_VERSION`(현 v56) 하나뿐(전수 확인).

5. **사이드카↔Node는 같은 URL을 공유하나, compose에 doc-ai는 없다 (재확인 완료).** `pdf-docling.ts:74`는 `config.rookieParserUrl`(기본 `http://rookie-parser:8900`)로 POST. `docker-compose.poc.yml`에는 `rookie-parser`(8900)만 있고 `doc-ai` 서비스·healthcheck·depends_on이 **전무**(L25-42). → 도달성 게이트(§5)·기본전환 게이트4(§7)의 **선결 미충족**이며 순환의존을 §C에서 해소한다.

---

# 3단계: OCR 흡수 (사이드카가 부분 손상/스캔 페이지를 DGX VLM으로 직접 OCR)

## (1) 사이드카 OCR 절차 — pypdfium2 렌더 → DGX `/v1/chat/completions`

`pdf-ocr-recover.ts` + `vlm-provider.ts` 계약을 Python으로 재현한다. `app.py`의 `_page_text_scan` 직후, Docling 변환(do_ocr=False 불변) 직후에 OCR 단계를 삽입한다.

### (1-a) 페이지 렌더 (pypdfium2 단일 의존)

```python
def _render_pages_to_png(pdf_bytes, pages, scale):
    """ocrCandidatePages(1-based)를 PNG로 렌더. 실패 페이지는 결과에서 제외(격리)."""
    import pypdfium2 as pdfium, io
    out = {}
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        n = len(pdf); consec_fails = 0
        for p in pages:                    # 1-based
            if p < 1 or p > n: continue
            try:
                bmp = pdf[p-1].render(scale=scale)   # 72*scale DPI
                buf = io.BytesIO(); bmp.to_pil().save(buf, format="PNG")
                out[p] = buf.getvalue(); consec_fails = 0
            except Exception:
                consec_fails += 1
                if consec_fails >= settings.ocr_max_consec_fails:  # 기본 3, 비용상한
                    break
    finally:
        pdf.close()
    return out
```

**scale 정합 (medium-DPI 비판 반영 — 정정 완료).** 초안의 "2x≈300DPI vs 실제 150DPI" 및 "CSS 96dpi 192px/in 환산" 설명은 **틀렸다**. 정확히는: TS는 `getViewport({scale:2.0})`(`pdf-ocr-recover.ts:63`)을 쓰고, **pdfjs viewport는 PDF user space(72 units/in) 기준**이므로 `scale=2.0 = 72×2 = 144 DPI`다. pypdfium2 `render(scale=2.0)`도 `72×2 = 144 DPI`로 **정확히 동일**하다. 코드 주석의 "2x≈300DPI"는 부정확한 주석이며 실제는 ~144DPI. → `DOCAI_OCR_RENDER_SCALE` 기본 2.0 유지(결론 불변, 근거 강화). 무리하게 4.17(=300/72)로 올리면 base64 페이로드가 ~4배 커져 DGX timeout·메모리 리스크.

**circuit breaker 근거 정정 (medium-breaker 반영).** TS의 `MAX_CONSEC_FAILS=3`(`pdf-ocr-recover.ts:75-77,97-101)`는 **pdfjs 워커 사망("Worker task terminated")이 이후 페이지로 전파되는 것을 막는 장치**다. pypdfium2는 워커 공유 상태가 없어 한 페이지 실패가 다음으로 전파되지 않으므로, 사이드카에서 이 breaker의 **원래 목적(전파 차단)은 성립하지 않는다.** 따라서 "TS 정합"이 아니라 **"연속 N페이지 렌더 실패 = 구조적 손상 PDF의 조기 중단(DGX 호출 낭비 비용 차단)"**이라는 독립 근거로 채택한다. 페이지별 격리는 `try/except`가 담당하고, breaker는 비용 상한으로만 의미를 갖는다. 수치 3은 무해하므로 유지하되 근거를 재서술했다. (TS의 "렌더 2회 재시도"는 워커 재오픈 전용이라 사이드카에서 **불필요** — 함의 C② 일치.)

### (1-b) DGX VLM HTTP 호출 — `vlm-provider.ts:59-92` 계약 재현

```python
_DEFAULT_PROMPT = (  # vlm-provider.ts:41-44 그대로
  "이 스캔 문서 이미지의 내용을 한국어 GitHub-flavored Markdown으로 정확히 복원해줘. "
  "표는 Markdown 표로(병합셀은 내용 반복), 제목/조항/항목 계층(#, -, 번호)도 살려줘. "
  "원문에 없는 설명·머리말은 붙이지 말고 복원 결과만 출력해.")

def _vlm_ocr_page(png, *, client, model, prompt, max_tokens, timeout):
    b64 = base64.b64encode(png).decode("ascii")
    body = {"model": model,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}],
            "max_tokens": max_tokens, "temperature": 0}          # vlm-provider:71 정합
    if settings.vlm_seed is not None: body["seed"] = settings.vlm_seed  # 선택, 무해
    headers = {"Content-Type": "application/json"}
    if settings.dgx_api_key: headers["Authorization"] = f"Bearer {settings.dgx_api_key}"
    r = client.post(f"{settings.dgx_url}/v1/chat/completions", json=body, headers=headers, timeout=timeout)
    if r.status_code != 200:
        raise RuntimeError(f"VLM 요청 실패 ({r.status_code}): {r.text[:200]}")
    return (r.json().get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
```

- endpoint `${DOCAI_DGX_URL}/v1/chat/completions`(Node `config.dgxSparkUrl` 정합), 응답 `choices[0].message.content.trim()`(`vlm-provider.ts:88`). `requirements.txt`에 `httpx>=0.27` 추가, 모듈 레벨 `httpx.Client` 1개 상주(pool 재사용). EasyOCR/CRAFT 미적재 불변(라이선스 스모크 유지).

### (1-c) 에이전틱 복구 + 결과 머지 — demote/ lowQuality 비대칭 명시 해소

```python
def _recover_pages(pdf_bytes, candidate_pages):
    target = list(dict.fromkeys(candidate_pages))[: settings.vlm_recover_max_pages]  # uniq+상한20
    if not target: return {}
    pngs = _render_pages_to_png(pdf_bytes, target, settings.ocr_render_scale)
    recovered = {}
    for p in target:
        png = pngs.get(p)
        if png is None: continue                 # 렌더 실패 격리
        for _ in range(2):                        # 빈응답 페이지당 2회 (TS L136)
            try:
                text = _vlm_ocr_page(png, ...)
                if text: recovered[p] = text; break
            except Exception:
                continue
    return recovered
```

**머지 (kordoc 경로와 동형):**

```python
if recovered:
    for p in sorted(recovered):
        markdown += f"\n\n<!-- VLM 복구 페이지 {p} -->\n{recovered[p]}"
        blocks.append({"type": "heading", "level": 3, "text": f"[복구 페이지 {p}]"})
        for para in [s for s in re.split(r"\n{2,}", recovered[p]) if s.strip()]:
            blocks.append({"type": "paragraph", "text": para.strip()})
    used_ocr = True
    needs_ocr = False
    low_quality = False        # ★ medium-lowQuality 반영: OCR 복구 성공 시 lowQuality 소거
    warnings.append(f"글꼴 손상/스캔 의심 {len(recovered)}개 페이지를 VLM OCR로 복구함(p.{', '.join(map(str, sorted(recovered)))}).")
```

**lowQuality 재평가 (medium-lowQuality 반영 — 필수).** 현 `app.py:253` `low_quality = isImageBased or avgCharsPerPage<80`는 **OCR 전 `_page_text_scan` 기준**이라, OCR 복구에 성공해도 `low_quality=True`로 남는다. 어댑터 `pdf-docling.ts:99`는 `data.lowQuality`를 **재계산 없이 그대로** 사용한다. 반면 kordoc 경로는 `parse-document.ts:294` `q.lowQuality || (kordocNeedsOcr && !recoveredOcr)`로 **복구 성공 시 needsOcr 기여분을 끈다**. 정합을 위해 사이드카도 복구 성공 시 `low_quality=False`로 내린다(또는 복구 텍스트 포함 avgCharsPerPage 재계산). 그래야 §9-2 lowQuality diff가 0이 된다.

**demote 비대칭 (medium-demote — 의도 명시 + 권고).** kordoc 경로는 `recoveredBlocks`를 demote **이후에** append한다(`parse-document.ts:275` demote는 `normBlocks0`에만 적용, L279에서 `[...normBlocks0, ...recoveredBlocks]`로 단순 concat) → **복구 블록은 demote를 안 거친다.** 반면 사이드카가 OCR 문단을 blocks에 넣어 반환하면 어댑터 `pdf-docling.ts:90`이 **전체 blocks**에 demote를 적용 → **복구 블록도 demote를 거친다.** 즉 동일 OCR 산출물이라도 heading/paragraph 분포가 두 경로에서 갈릴 수 있다. 본 설계는 이 비대칭을 **인지된 차이로 명시**하고, §9-2 골든에서 blocks 분포 diff로 실측한다. 갈리면(읽기전용이라 권고): (a) 사이드카 복구 블록에 demote-skip 마커를 두거나, (b) kordoc 경로도 `recoveredBlocks`에 demote를 적용해 양 경로를 일치시킨다. 사이드카가 복구 문단을 **paragraph로만** 넣으므로 실제 분포 차이는 "복구 텍스트에 헤딩성 라인이 섞일 때"로 한정된다.

---

## (2) `quality.ts`의 Python 포팅 — 단, 엔진 비대칭을 BLOCKING 가정으로 격상

현 `_page_text_scan`은 텍스트 길이·한글비율만 측정 → ToUnicode 손상 PDF(글자수 충분·PUA 깨짐)를 못 잡는다(무음통과 갭). `computePageQuality`/`summarizeDocumentQuality`를 포팅한다(임계 상수·매크로 평균·needsOcr 0.3 비율은 §0 인용대로 `quality.ts:108-113,160-170` 확인 완료).

**현 `app.py` 대비 수정 3건:**

| 항목 | 현재 (app.py) | 포팅 후 (quality.ts) |
|---|---|---|
| 저텍스트 임계 | `scan_max_chars_per_page=10` | `LOW_TEXT_THRESHOLD=20` |
| needsOcr 판정 | `bool(ocrCandidatePages)`(1p라도) | `cand/n >= 0.3` |
| avgHangulRatio | 마이크로 평균 | 매크로 평균(`quality.ts:164`) |
| PUA/제어/replacement | **미측정** | computePageQuality로 측정 |

### ⚠️ 엔진 비대칭 — 진짜 비대칭원은 순회 방식이 아니라 추출 엔진 (high-B 반영, BLOCKING 가정 격상)

초안은 두 경로의 needsOcr 차이를 "plane15/16 PUA 순회 정밀도(UTF-16 vs 코드포인트)"로 축소했으나, 이는 **부차적**이다. **진짜 비대칭원은 텍스트 추출 엔진이다:** kordoc은 pdfjs(`parser.ts:148-155` pageText→computePageQuality), 사이드카는 pypdfium2(`app.py` get_text_range). **동일 ToUnicode 손상 PDF에서 두 엔진이 같은 코드포인트를 반환한다는 보장이 없다** — pdfjs는 ToUnicode CMap을 적용해 PUA로 떨어뜨리는 반면, pypdfium2는 글리프 인덱스나 다른 대체문자를 줄 수 있어, 같은 PDF가 한쪽은 `high_pua`(needsOcr), 다른쪽은 `low_text` 또는 무신호로 갈릴 수 있다. 임계를 1:1 포팅해도 **입력 텍스트가 다르면 판정이 갈린다.**

**조치(BLOCKING):**
1. 골든 세트 ④(ToUnicode 손상, 한글 추출비율 39%류 — `pdf-ocr-recover.ts` 주석의 실제 케이스)에서 **두 엔진의 페이지별 puaRatio/controlRatio/needsOcr을 실측 대조**하는 단계를 §9에 추가한다(단순 포팅 검증이 아니라 엔진 출력 대조).
2. 차이가 크면 둘 중 택1을 **기본값으로 검토**한다: (a) 사이드카 needsOcr 임계를 pypdfium2 텍스트 기준으로 독립 재보정, 또는 (b) **손상 PDF는 어댑터가 `needsOcr && !usedOcr`일 때 throw(`DOCAI_FALLBACK_ON_NEEDSOCR`)하여 kordoc(pdfjs) 경로로 넘겨 판정 일관성을 확보**(권장 기본 — 판정 정본을 pdfjs 하나로 통일). plane15/16 PUA 순회 차이는 BMP PUA(한글 손상 대다수)에서 동일하므로 이 대조의 부차 변수일 뿐이다.

**어댑터 계약 무손실 확장:** `pdf-docling.ts:35` `qualitySummary` 타입은 `{needsOcr,ocrCandidatePages,avgHangulRatio}` 3필드만 받지만, 사이드카가 추가 필드(`lowTextPageCount` 등)를 보내도 TS는 무시(무손실)하므로 throw 위험 없음. **단 §4-후퇴모드 가드가 needsOcr를 어댑터에서 분기하려면 어댑터에 신규 분기가 필요하다(아래 §4·§C에서 신규 구현 항목으로 분류).**

---

## (3) VLM OCR 비결정성 처리

- 클라이언트측 그리디 `temperature:0` 하드코딩(`vlm-provider:71` 정합) → 클라측 샘플링 변동 제거.
- **서버측 잔여 비결정**(vLLM 배치 구성·부동소수 비결합)은 사이드카가 못 잡는다. 완전 결정화는 **DGX vLLM의 seed 고정+배치 결정화(백엔드 책임)** 동반이 필수 — 본 설계 범위 밖, 컴플라이언스 재현성 미결 항목.
- 사이드카 최선(권고, 무해): `DOCAI_VLM_SEED` 옵션 전송. vLLM이 존중하면 부분 결정화, 무시하면 무해.
- 빈응답 2회 재시도는 temperature=0에서 동일 출력을 받을 수 있으나, 실측상 vLLM 간헐 빈응답은 서버측 일시 상태라 재시도가 유효 — TS 동작 그대로 보존.
- **결정성 노출면 (low-title 반영):** OCR이 트리거되는 needsOcr 문서로 한정되며, **OCR 복구가 markdown을 바꾸면 `pickTitle→titleFromContent`(`doc-text.ts`) 및 `cleanLawName`(`pipeline.ts:89`) 등 markdown 파생값도 run마다 흔들릴 수 있다**(영향 경미하나 완결성). 디지털 PDF는 Docling 결정적 경로만 타므로 비결정 노출 면적은 needsOcr 문서로 한정.

---

## (4) 중복 회피 — 정정된 2계층 모델 (high-A·high-D 반영)

**초안의 "needsOcr 신호 소거가 중복방지 핵심"은 삭제한다.** §0-2에서 확인했듯 docling 경로는 qualitySummary를 하류로 전달하지 않으므로 그 논리는 코드상 무의미하다. **중복을 막는 유일·실제 메커니즘은 단 하나다:** `pdfParser` 분기 배타 + docling 성공 시 `parse-document.ts:191` `return`으로 L197 이하 kordoc 본경로(`recoverLowQualityPages` 포함)에 **구조적으로 미도달**.

**kordoc 경로의 OCR은 2계층이다 (초안 다이어그램 누락 보정):**

```
                       parse-document.ts:188
                              │  (pdfParser 분기 — 배타)
        ┌─────────────────────┴──────────────────────┐
 docling                                        kordoc 본경로(L197~)
   │                                                  │
 사이드카 /parse                            kordoc parse() 내부
   │                                          │
 ① 사이드카가 OCR 수행(3단계 신규)        [1계층] parser.ts:167
   = pypdfium2 렌더 + DGX                  문서평균<10자 → ocrPages(provider.ts)
   = 부분 손상 페이지 타게팅                = 스캔본 전체 라우팅, isImageBased=true
   → markdown/blocks 머지                          │
   → return(L191) → 종결                    [2계층] parse-document.ts:234
   (L197 이하 미도달 = B경로 실행불가)      kordocNeedsOcr → recoverLowQualityPages
                                            = 부분 손상 페이지 타게팅(B경로)
```

**사이드카가 재현해야 하는 것은 B경로(부분 손상 페이지 타게팅)이지, kordoc 내부 ocrPages(스캔본 전체 라우팅)가 아니다.** 사이드카는 이미 `isImageBased` 신호를 낸다(`app.py:125,272`). 따라서 책임은 다음 2계층으로 분리된다:

- **스캔본 전체(isImageBased)**: 사이드카 markdown이 빈약 → 어댑터 빈 markdown throw(`pdf-docling.ts:84`) → kordoc 폴백 → kordoc 내부 ocrPages(parser.ts:167)가 처리. (또는 사이드카가 직접 OCR해 본문을 채워 return — 둘 다 단일 처리.)
- **부분 손상 페이지(needsOcr, 텍스트층은 있음)**: 사이드카가 §1-c로 직접 처리(B경로의 사이드카 이식).

같은 문서가 두 경로를 동시에 타는 일은 `pdfParser` 분기 배타로 구조적으로 불가. `pdf-ocr-recover.ts`는 **Python 이식의 참조 정본일 뿐 삭제·변경 대상이 아니다**(폴백 보존).

---

## (5) GATE — 사이드카→DGX 도달성 + compose 선결 (high-C 반영, 순환의존 해소)

**3단계 최대 리스크이자 BLOCKING 게이트.** Node는 호스트 WireGuard로 DGX(172.23.80.102:8000)에 닿지만, 사이드카는 docker 브리지(`law-ai_default`, 172.24.x, `docker-compose.poc.yml:42`)에 있어 호스트 wg0 라우팅을 **자동 상속하지 않는다.** core-ai(172.24.x) 도달이 DGX(172.23.x) 도달을 보장하지 않는다.

### 선결 조건 (초안 §0-4가 미룬 것을 게이트 앞으로 끌어옴 — 순환의존 해소)

초안의 게이트 명령 `docker compose ... exec doc-ai curl ...`은 **compose에 doc-ai가 없어 실행 불가**(§0-5). 따라서 게이트 절차의 0단계로 compose 정의를 고정한다:

```
0단계 (선결, 신규 구현): docker-compose.poc.yml에 doc-ai 서비스 추가.
  - rookie-parser 자리 대체(서비스명을 rookie-parser로 점유) 또는
  - 별도 서비스 + ROOKIE_PARSER_URL=http://doc-ai:8900 지정(pdf-docling.ts:74가 이 URL로 POST)
  - /health healthcheck(app.py:88-93의 503/200 계약 활용) + depends_on: service_healthy
  → docker compose up → /health 200 확인.
```

### 도달성 실측 (0단계 통과 후, 순서 고정)

```bash
# 1) 사이드카 컨테이너 내부에서 DGX 도달성 (서비스명은 0단계 정의명과 일치)
docker compose -f docker-compose.poc.yml exec doc-ai \
  curl -sS -m 5 http://172.23.80.102:8000/v1/models     # 기대: 200 + 모델목록
# 2) (보강) 작은 PNG 1장으로 /v1/chat/completions 200·content 비어있지 않음 확인
```

권고: 사이드카 기동 시 **DGX preflight**(`GET /v1/models` 1회)를 `/health`에 반영 — 실패면 OCR 수행을 비활성(후퇴 모드)으로 자동 강등하고 warnings 기록 → 도달성 변동에도 무중단.

### 도달성 미달 시 — 분할 흡수 후퇴

DGX가 사이드카에서 안 닿으면 **억지로 라우팅을 뚫지 말고** OCR을 Node에 잔존시킨다:
- 사이드카는 needsOcr 신호만(§2 quality 포팅으로 정밀화), `usedOcr:False` 유지.
- docling 성공 시 B경로 미도달 문제(§4)는 후퇴 모드 가드로 해소: 사이드카가 `needsOcr=true && usedOcr=false`이고 markdown 빈약(스캔)이면 이미 빈 markdown throw가 흡수. **ToUnicode 손상(글자수 충분+OCR 미수행) 케이스만** 추가 가드 필요 → **신규 구현 항목**으로 어댑터에 `needsOcr && !usedOcr이면 throw`(`DOCAI_FALLBACK_ON_NEEDSOCR`)를 둔다. **단 이 가드는 §2 PUA 포팅의 후행 의존**(PUA 포팅이 사이드카에 먼저 들어가야 needsOcr=true가 산출됨)임을 순서로 고정. 이 가드는 현 어댑터에 없으며(L86-104는 needsOcr 미검사), DoclingResponse 타입은 needsOcr를 이미 보유하므로 **분기 추가만 신규**다(low-fallback 반영).
- 라우팅 해결 1순위: docker network에 172.23.0.0/16 라우트 추가(호스트 wg0 게이트웨이 경유). host network/extra_hosts는 라우팅 문제라 무효.

**게이트 판정:** 0단계+curl 200이 안 나오면 3단계 OCR 흡수 **착수 보류**, 분할 흡수 후퇴로 무중단 운영.

---

## (6) 폴백 안전 — OCR 실패가 전체 파싱 실패로 번지지 않게

- **페이지 격리:** 모든 렌더/OCR 루프 `try/except`(§1-a,1-c). 한 페이지 실패가 나머지·Docling 본문을 죽이지 않음.
- **OCR 단계 전체 try/except:** OCR 블록이 통째 실패해도(DGX 일시 503) Docling 본문+신호는 정상 반환. `needsOcr=true,usedOcr=false`로 남아 후퇴 정책(§5)에 따름.
- **5xx 계약 불변:** Docling 변환 실패는 기존대로 500(`app.py`)→어댑터 throw→kordoc 폴백. **OCR 실패는 500으로 승격하지 않는다**(본문 유효).
- **self-timeout 정합 (§9 timeout 충돌 반영):** 어댑터는 `AbortSignal.timeout(config.rookieTimeoutMs)`(기본 120s, `pdf-docling.ts:78`)로 끊는다. 사이드카 OCR 총 데드라인을 그보다 짧게(예: 100s) 두고, 초과 시 **그때까지 복구분만 머지하고 반환**(부분 복구 > 전체 실패). DGX 페이지당 timeout은 30s(20p 상한과 곱해도 폭주 방지). **단 골든 하네스 `GOLDEN_TIMEOUT_MS`(현 90s, 베이스라인에 90018ms timeout 7건 실측)는 사이드카 총 데드라인 100s보다 작아 충돌** → §9에서 골든 timeout을 사이드카 데드라인보다 크게(예: 130s) 잡아 ERR 오분류를 방지한다.

---

# 4단계: 기본 전환 (PDF_PARSER 기본 docling + 캐시 무효화)

## (7) PDF_PARSER 기본 docling 전환 게이트

`config.ts:32` 기본값 `"kordoc"` → `"docling"`. **무조건 전환 금지** — 아래 전부 통과:

1. **3단계 도달성 게이트(§5) 통과** — compose doc-ai 정의(0단계) + curl 200, 또는 후퇴 모드 무중단 검증.
2. **골든 회귀(§9) 통과** — 디지털 PDF는 엄격 회귀0, OCR 문서는 분포 하한 판정(아래).
3. **cfgSig에 pdfParser 선반영(§8)** — 무효화 메커니즘이 전환 전에 먼저 들어가야 A/B 교차오염 차단.
4. **compose 정합 — '권고'가 아니라 '미충족 선결'로 격상 (medium-compose 반영).** 현 `docker-compose.poc.yml`에 doc-ai·healthcheck·depends_on이 **없으므로**(§0-5), 이 compose 변경(§5 0단계)이 머지되기 전엔 `PDF_PARSER=docling` **스테이징 검증조차 불가**하다. 이를 BLOCKING 선결로 명기한다.

전환은 env 한 줄(`PDF_PARSER=docling`)로 스테이징 검증 후, 통과하면 코드 기본값을 바꾼다(코드 변경은 골든 통과의 사후 확정).

---

## (8) 캐시 무효화 — cfgSig에 pdfParser 추가 + cacheVersion bump

### 8-1. cfgSig에 pdfParser 추가 (1순위, 근본)

`pipeline.ts:61-71` cfgSig에 `config.pdfParser`를 추가. `llmTemperature/llmRetryTemperature`가 이미 들어있는 확립된 패턴과 동형(L69-70 확인).

```ts
const cfgSig = [
  config.subQueryMax, config.canonicalTermMax, config.matchTopK,
  config.vectorTopK, config.bm25TopK, config.rrfK,
  config.maxAnalyzeChars, config.llmTemperature, config.llmRetryTemperature,
  config.pdfParser,            // ★ 추가 — 파서별 key 분리로 A/B 교차오염 차단
].join("-");
```

효과: 같은 fileHash라도 kordoc/docling이 다른 캐시키를 가져 파서 토글 시 stale 차단. OCR 노브(`ocrMinCharsPerPage`/`vlmRecoverMaxPages`)는 cfgSig에 넣지 않는다(비대화 비용 > 이득, 변경 시 cacheVersion bump로 대응 — 근본·최소).

### 8-2. 동시 bump 대상 = REPORT_CACHE_VERSION 하나뿐 (전수 확인)

| 캐시 | 키 | 파서 영향 | 조치 |
|---|---|---|---|
| `pipeline.ts:72` report | `report-${cacheVersion}-${cfgSig}:${fileHash}`(쓰기 L118/161/316) | 있음 | cfgSig+pdfParser + cacheVersion bump |
| `search-catalog.ts:217` optCache | `CatalogKind`, 5분 TTL | 없음(ODS 드롭다운) | 무관 |
| UI "v20" | — | — | 별개 키 아님(commit ee22cea의 과거 `REPORT_CACHE_VERSION` 값). localStorage/SWR/unstable_cache 전무 |

→ **cacheVersion v56 → v57로 1회 bump.** 역할 분리: cfgSig+pdfParser = 파서별 영구 분리(A/B·롤백 교차오염 차단), cacheVersion bump = 전환 시점 1회 전량 청소(인메모리 무재시작 대비). 둘 다 적용(다른 축, 중복 아님).

---

## (9) 골든 게이트 — OCR 문서를 별도 트랙으로 분리 (high-골든 반영, 핵심 보정)

### 9-0. OCR 문서에서 "회귀 0"은 구조적으로 불가 — 베이스라인이 증명 (실측)

`golden-baseline.json`(capturedFiles 210, metrics 210) 실측: usedOcr=true 문서 9건의 amendPairs가 **0~23으로 산포**한다 —

| 문서(식별) | amendPairs | ms |
|---|---|---|
| 김영란 일부개정(스캔) | 23 | 46,706 |
| 2215442 의약국 의안 | 22 | 58,007 |
| 2218725 의약 의안 | 13 | 16,494 |
| 정보보호법 의안 | 11 | 18,275 |
| 2218335 의약 의안 (2종) | 1 / 1 | 35,013 / 31,505 |
| 나머지 3건 | 0 | 31k~54k |

추가로 **`ms=90018`류 timeout ERR 7건**(`ok:false, error:timeout`)이 별도로 존재. 즉 OCR 문서의 amendPairs·blocks·bodyChars는 DGX 서버측 비결정(§3)에 좌우되어, "docling이 kordoc 대비 amendPairs를 잃었다"와 "OCR이 이번 run에 우연히 적게 뽑았다"를 **단일 diff로 구분할 수 없다**. 이 앱의 1순위 타깃이 신구조문대비표 스캔본임을 감안하면 치명적.

### 9-1. 판정 트랙 분리

- **디지털 PDF(usedOcr=false): 엄격 회귀 0.** amendPairs/blocks/bodyChars/dataUri/파생값 diff=0(또는 설명 가능한 정밀도 향상).
- **OCR 문서(usedOcr=true): 분포 하한 판정.** 동일 입력을 **N회(예: 5회) 반복 실행**해 kordoc 경로에서 amendPairs/bodyChars/blocks의 **분산·최소값**을 캡처하고, docling 결과가 **kordoc N회 분포의 하한 이상**이면 통과(회귀 = 하한 미달). markdown 완전일치는 요구하지 않는다.
- **timeout 보정:** 골든 하네스 `GOLDEN_TIMEOUT_MS`(현 90s — 베이스라인 90018ms ERR 7건의 출처)를 사이드카 OCR 총 데드라인(100s)보다 크게(예: 130s) 잡아, 정상적인 긴 OCR이 '회귀'로 오분류되지 않게 한다.

### 9-2. diff 대상 (회귀 기준)

| 산출물 | 출처 | 디지털(엄격0) | OCR(분포하한) |
|---|---|---|---|
| amendPairs | blocks→표 추출 | 무유의 감소 0(표 ragged면 어댑터 throw로 방어) | kordoc N회 하한 이상 |
| blocks 수·타입 분포 | `doc.blocks` | heading/para/table/image 동형 | 분포 하한, **demote 비대칭(§1-c) 실측** |
| dataUri | restoredHtml(`pipeline.ts:94`) | 이미지 수·디코드 성공 | 동일 |
| bodyChars | `pipeline.ts:100` | minBodyChars(300) 게이트 동일 | 하한 이상 |
| 시행일·docNature·itemType | `pipeline.ts:90-91` | 동일 | 안정성 |
| **qualitySummary 엔진 대조** | §2 | — | **pdfjs vs pypdfium2 페이지별 puaRatio/needsOcr 실측 대조(BLOCKING, high-B)** |
| lowQuality | §1-c 재평가 후 | 동일(복구 성공시 false 정합) | 동일 |
| usedOcr | 복구 페이지 | — | 사이드카가 B경로와 동등 복구(복구 페이지 수) |

### 9-3. 판정

- 디지털 회귀0 + OCR 분포하한 통과 → 4단계 전환.
- 정밀도 향상(plane15/16 PUA, 더 정확한 표 그리드)으로 설명 가능 → 베이스라인 갱신+문서화.
- 설명 불가한 amendPairs 감소·blocks 손실·bodyChars 급감 → 전환 보류, 사이드카 수정 후 재실행.

---

## (10) 롤백 — `PDF_PARSER=kordoc` 한 줄

- **즉시:** env `PDF_PARSER=kordoc`(재배포). 코드 변경 불요.
- **캐시 오염 없음:** §8-1이 전제 — cfgSig에 pdfParser가 들어가 있으면 롤백 후 kordoc 키가 docling 키와 분리돼 과거 kordoc 캐시를 즉시 안전 재사용. cfgSig에 없으면 docling이 쓴 캐시를 kordoc으로 오인 hit하므로 **§8-1이 롤백 안전의 전제**다.
- **무중단:** 롤백은 어댑터를 우회하고 kordoc 본경로(`parse-document.ts:197~`)로 직행. 사이드카를 끄지 않아도 됨.
- 트리거 예시: 사이드카 장애율 급증, amendPairs 회귀 사후 발견, OCR 비결정 컴플라이언스 클레임.

---

## 부록: 신규 env (DOCAI_ 외부화)

| env | 기본값 | 용도 |
|---|---|---|
| `DOCAI_DGX_URL` | `http://172.23.80.102:8000` | DGX VLM(Node `dgxSparkUrl` 정합) |
| `DOCAI_DGX_MODEL` | `google/gemma-4-26B-A4B-it` | 모델 ID |
| `DOCAI_DGX_API_KEY` | (없음) | Bearer |
| `DOCAI_VLM_MAX_TOKENS` | 2048 | vlm-provider 정합 |
| `DOCAI_VLM_PAGE_TIMEOUT` | 30s | 페이지당 DGX timeout |
| `DOCAI_OCR_TOTAL_TIMEOUT` | 100s | OCR 총 데드라인(< rookieTimeoutMs 120s, < GOLDEN_TIMEOUT_MS 130s) |
| `DOCAI_OCR_RENDER_SCALE` | 2.0 | pypdfium2 render scale = 72×2 = **144DPI**(pdfjs viewport 2.0과 동일) |
| `DOCAI_OCR_MAX_CONSEC_FAILS` | 3 | 연속 렌더 실패 비용상한(전파 차단 아님 — §1-a) |
| `DOCAI_VLM_RECOVER_MAX_PAGES` | 20 | 복구 페이지 상한 |
| `DOCAI_VLM_SEED` | (미전송) | 부분 결정화 시도(무해, 선택) |
| `DOCAI_FALLBACK_ON_NEEDSOCR` | false | 후퇴 모드: needsOcr&&!usedOcr이면 **어댑터가 throw**(신규 분기) → kordoc 경로. §2 PUA 포팅의 후행 의존 |

`requirements.txt` 추가: `httpx>=0.27`. EasyOCR/CRAFT 미적재 불변(라이선스 스모크 유지).

---

## 비판 반영 요약표

| # | 심각도 | 비판 요지 | 반영/기각 | 본문 위치 | 근거(파일:라인) |
|---|---|---|---|---|---|
| A | high | docling 경로는 qualitySummary를 하류로 안 넘김 — "신호 소거가 중복방지 핵심" 오류 | **반영(주장 삭제)** | §0-2, §4 | ParsedDoc L42-56 필드 부재; pdf-docling.ts:93-104 drop |
| B | high | needsOcr 비대칭의 진짜 원인은 순회 정밀도가 아니라 추출 엔진(pdfjs vs pypdfium2) | **반영(BLOCKING 격상)** | §2, §9-2 | parser.ts:148-155 vs app.py get_text_range |
| C | high | 도달성 게이트 exec가 compose에 없는 doc-ai 호출, rookieParserUrl 순환의존 | **반영(0단계 선결 신설)** | §5, §7-게이트4 | docker-compose.poc.yml L25-42; config.ts:33 |
| D | high | kordoc OCR 트리거가 둘(parser.ts:167 내부 ocrPages 누락) — '단일 책임' 부정확 | **반영(2계층 모델)** | §0-3, §4 | parser.ts:167-180 |
| E | medium | §1-c demote 비대칭(kordoc 미적용 vs docling 적용) | **반영(명시+권고)** | §1-c | parse-document.ts:275,279 vs pdf-docling.ts:90 |
| F | medium | OCR 성공 시 lowQuality 재평가 누락(사이드카 OCR-전 기준 잔존) | **반영(필수 추가)** | §1-c | app.py:253; pdf-docling.ts:99 vs parse-document.ts:294 |
| G | medium | circuit breaker 근거 정합 오류(pypdfium2엔 워커 전파 없음) | **반영(근거 재서술)** | §1-a | pdf-ocr-recover.ts:75-77,97-101 |
| H | medium | scale DPI 환산 오류(144DPI이지 300/192 아님) | **반영(정정)** | §1-a, 부록 | pdf-ocr-recover.ts:63 |
| I | medium | compose 게이트4를 '권고' 아닌 '미충족 선결'로 격상 | **반영** | §7-게이트4 | docker-compose.poc.yml |
| J | high | 골든 회귀0이 OCR 문서에서 구조적 불가(amendPairs 0~23 산포·timeout 7건) | **반영(트랙 분리)** | §9-0~9-3 | golden-baseline.json 실측 |
| K | low | 후퇴모드 가드는 어댑터 신규 구현(현 어댑터 needsOcr 미검사) | **반영(신규 분류+순서고정)** | §5, 부록 | pdf-docling.ts:86-104 |
| L | low | 결정성 노출면에 title/cleanLawName 파생 누락 | **반영** | §3 | pipeline.ts:89 |
| M | low | scale 정합 근거가 오히려 강함(과소평가) | **반영(근거 강화)** | §1-a | provider.ts:83 |
| — | — | OCR 노브를 cfgSig에 추가 | **기각** | §8-1 | 비대화 비용>이득, cacheVersion bump로 대응(근본·최소) |

---

## 최종 추천 (가/부 · 게이트 · 진행순서)

**판정: 조건부 가(可).** 골격(폴백 단방향·캐시키 단일·cfgSig+pdfParser 패턴·VLM 계약 재현·외부화)은 코드와 정확히 일치하여 **승인**한다. 단 **§2 엔진 비대칭(B)·§9 OCR 트랙 분리(J)·§5 compose 선결(C)** 3건은 4단계 기본전환 전 BLOCKING으로, 미보정 착수는 부(不).

**게이트(BLOCKING, 통과 순서):**
1. **G1 compose 선결(C,I)** — doc-ai 서비스 + /health + depends_on:service_healthy 정의, `up` 후 /health 200. (이게 없으면 스테이징 검증조차 불가)
2. **G2 도달성(C)** — 컨테이너 내부 `curl 172.23.80.102:8000/v1/models` 200 + 멀티모달 1장 왕복. 미달 시 분할 흡수 후퇴(무중단).
3. **G3 엔진 대조(B)** — 골든 ④에서 pdfjs vs pypdfium2 페이지별 puaRatio/needsOcr 실측. 차이 크면 `DOCAI_FALLBACK_ON_NEEDSOCR=true`를 기본으로(판정 정본 pdfjs 통일).
4. **G4 골든(J)** — 디지털 회귀0 + OCR 분포하한(N=5 반복). GOLDEN_TIMEOUT_MS를 사이드카 데드라인보다 크게.

**진행순서:**
1. (3단계) §2 quality.ts 포팅 → 사이드카 needsOcr 정밀화 (PUA 포팅이 후퇴모드 가드의 선행 의존).
2. (3단계) §1 OCR 절차 이식(렌더+DGX+머지+lowQuality 재평가) — **G1·G2 통과 후**. 미통과면 분할 흡수 후퇴(needsOcr 신호만).
3. (4단계 준비) §8-1 cfgSig+pdfParser 추가(전환 전 선반영) — 롤백·A/B 안전의 전제.
4. (4단계 검증) §9 골든 트랙 분리 실행(**G3·G4**) → env `PDF_PARSER=docling` 스테이징.
5. (4단계 확정) 통과 시 cacheVersion v56→v57 bump + 코드 기본값 docling 전환. 롤백은 항상 env 한 줄.

관련 파일(절대경로): `c:\Users\admin1\Documents\Claude\Projects\IBK 프로젝트 테스트\services\doc-ai\app.py`, `...\kordoc\src\ocr\vlm-provider.ts`, `...\kordoc\src\ocr\provider.ts`, `...\kordoc\src\pdf\quality.ts`, `...\kordoc\src\pdf\parser.ts`, `...\lib\pdf-ocr-recover.ts`, `...\lib\parse-document.ts`, `...\lib\pdf-docling.ts`, `...\lib\pipeline.ts`, `...\lib\config.ts`, `...\services\doc-ai\requirements.txt`, `...\docker-compose.poc.yml`, `...\scratchpad\golden-baseline.json`.