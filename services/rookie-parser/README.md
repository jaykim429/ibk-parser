# rookie-parser 사이드카 (PDF 고품질 파싱)

PDF를 OpenDataLoader(ODL)/CG Rookie Parser로 파싱해 **IBK 앱 계약(ParsedDoc)** JSON으로 반환하는
경량 HTTP 서비스. Next 앱은 `PDF_PARSER=rookie` 일 때 PDF만 이 서비스에 위임하고, **실패 시 kordoc 으로 자동 폴백**한다. (HWP/HWPX는 항상 kordoc)

## 왜 분리?
- kordoc(JS)은 HWP/HWPX 네이티브 파싱이 강점이나, 복잡·무선표/스캔 PDF는 한계.
- ODL/Rookie는 표(0.928)·bbox·읽기순서·한국어 OCR이 강점이지만 **Java(+Python)** 런타임 필요.
- → 포맷별 라우팅: **HWP=kordoc, PDF=이 사이드카**.

## 계약 (HTTP)
```
POST /parse   { "filename": str, "content_base64": str }
200  {
  markdown: str,
  blocks: IRBlock[],        # kordoc IRBlock 동일 스키마(heading/paragraph/table/list/image/separator)
  outline: OutlineItem[],
  pageCount?: int, isImageBased?: bool, usedOcr?: bool, warnings?: str[]
}
GET /health  → {"status":"ok"}
```
`blocks[]` 가 kordoc IRBlock 과 동일하므로, 앱의 청킹/복원 렌더(render-blocks)가 그대로 동작한다.

## 엔진 교체 지점
`app.py`의 `run_parser()`가 기본 **ODL CLI**(JSON)를 호출한다.
- CG **rookie-parser**(Docling+ODL 라우팅)로 바꾸려면 `run_parser()`를 rookie-parser 호출로 교체하고
  `map_element()`을 실제 출력 스키마(DocIR/Structured)에 맞춰 조정.
- ⚠️ ODL/rookie의 JSON 필드명은 버전에 따라 다를 수 있으니 배포 시 `map_element()`/`run_parser()`의
  키(`elements`/`bbox`/`type`/`rows` 등)를 실제 출력으로 1회 검증할 것.

## 실행
```bash
# 로컬
pip install -r requirements.txt   # + JRE 11+ 설치
uvicorn app:app --port 8900

# Docker
docker build -t rookie-parser ./services/rookie-parser
docker run -p 8900:8900 rookie-parser
```

## 앱 연동(env)
```
PDF_PARSER=rookie
ROOKIE_PARSER_URL=http://rookie-parser:8900
ROOKIE_TIMEOUT_MS=120000
```
미설정/`PDF_PARSER=kordoc` 이면 기존대로 kordoc 사용(무중단).

## 폐쇄망
- 이미지에 JRE + ODL(또는 rookie) + (OCR 모델)까지 포함해 빌드 → 런타임 외부망 0.
- OCR 언어: `ODL_OCR_LANG=ko,en` (기본).
