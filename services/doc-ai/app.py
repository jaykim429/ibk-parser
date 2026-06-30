"""
doc-ai 사이드카 — PDF를 순수 Python Docling으로 파싱해 IBK 앱 계약(ParsedDoc) JSON으로 반환.

레거시 rookie-parser(ODL Java CLI) 대체. **Java 없음.** compliance-ibk/law-core-ai 컨벤션 정합
(FastAPI · Python 3.11 · uv · pydantic v2) → 종국엔 law-core-ai로 흡수 가능.

계약(HTTP) — pdf-docling.ts 어댑터와 1:1:
  POST /parse  { filename, content_base64 }
  200  { markdown, title?, blocks[], outline[], pageCount, isImageBased, usedOcr,
         lowQuality, qualitySummary{needsOcr,ocrCandidatePages,avgHangulRatio}, warnings[] }

티어링/OCR(설계 §3·§4):
  · 디지털/복잡(표·신구조문대비표) → Docling(Layout+TableFormer, do_ocr=False).
  · 스캔/손상(저텍스트 또는 PUA/글꼴손상) → **사이드카가 DGX VLM으로 직접 OCR(3단계)**.
    do_ocr=False 로 EasyOCR/CRAFT(비상업 가중치) 배제 — OCR 정본은 DGX VLM(pdf-ocr-recover.ts 계약 재현).
  · DGX 미도달/복구 실패 → markdown 빈약/그대로 → 어댑터가 throw → kordoc 폴백(무중단).

⚠️ Docling API 버전 의존(docling 2.x). 배포 시 핀 버전과 대조(TableData.table_cells·PictureItem.get_image).
"""
from __future__ import annotations

import base64
import io
import re
import threading
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """env 외부화(law-core-ai pydantic-settings 패턴, DOCAI_ 접두). 임계는 kordoc quality.ts 와 정렬."""
    model_config = SettingsConfigDict(env_prefix="DOCAI_", extra="ignore")

    max_concurrency: int = 1            # GPU 단일 가정 — Docling 추론 직렬화. 포화 시 503 → 클라가 kordoc 폴백.
    scan_max_chars_per_page: int = 10   # 페이지당 이 미만이면 스캔/이미지 PDF 의심(needsOcr)
    ocr_min_chars_per_page: int = 80    # 이 미만(스캔 아님)이면 저품질 의심
    pua_ratio_threshold: float = 0.01   # 페이지 PUA(U+E000–F8FF)/제어문자 비율 임계 — 글꼴손상 감지(assessQuality 정합)
    docling_do_ocr: bool = False        # ★ EasyOCR/CRAFT(비상업 가중치) 배제 — OCR 은 DGX VLM 정본
    docling_table_structure: bool = True
    generate_picture_images: bool = True  # 이미지 복원용(restoredHtml)

    # ── 3단계 OCR(스캔/손상 페이지 → DGX VLM 직접). pdf-ocr-recover.ts + vlm-provider.ts 계약 재현 ──
    dgx_url: str = "http://172.23.80.102:8000"          # Node config.dgxSparkUrl 정합
    dgx_model: str = "google/gemma-4-26B-A4B-it"
    dgx_api_key: str = ""
    vlm_max_tokens: int = 2048
    vlm_page_timeout: float = 30.0      # 페이지당 DGX timeout(s)
    ocr_total_timeout: float = 100.0    # OCR 총 데드라인(s) < rookieTimeoutMs(120) < GOLDEN_TIMEOUT_MS(권장 130)
    ocr_render_scale: float = 2.0       # pypdfium2 render scale = 72×2 = 144DPI (pdfjs viewport scale 2.0 과 동일)
    ocr_max_consec_fails: int = 3       # 연속 렌더 실패 비용상한(워커전파 차단 아님 — pypdfium2 무공유)
    vlm_recover_max_pages: int = 20     # 복구 페이지 상한(비용)
    vlm_seed: int | None = None         # 부분 결정화 시도(무해, 선택)


settings = Settings()
_sema = threading.BoundedSemaphore(settings.max_concurrency)
_http = httpx.Client()  # 연결 풀 재사용(모듈 상주)

# DGX VLM 프롬프트 — kordoc vlm-provider.ts 기본 프롬프트 정합.
_VLM_PROMPT = (
    "이 스캔 문서 이미지의 내용을 한국어 GitHub-flavored Markdown으로 정확히 복원해줘. "
    "표는 Markdown 표로(병합셀은 내용 반복), 제목/조항/항목 계층(#, -, 번호)도 살려줘. "
    "원문에 없는 설명·머리말은 붙이지 말고 복원 결과만 출력해."
)

# Docling 변환기는 무겁다(모델 상주) → 프로세스당 1회 로드 후 영구 상주(콜드스타트/언로드 방지, 설계 §9).
_converter: Any = None
_converter_ready = False
_converter_err: str | None = None


def _build_converter() -> Any:
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions

    opts = PdfPipelineOptions()
    opts.do_ocr = settings.docling_do_ocr           # False → 사이드카 Docling-OCR 미수행(라이선스). OCR 은 DGX VLM.
    opts.do_table_structure = settings.docling_table_structure
    opts.generate_picture_images = settings.generate_picture_images
    return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # 기동 시 모델 프리로드 → /health 는 로드 완료 후에만 ok(설계 §8-2: depends_on service_healthy 게이트).
    global _converter, _converter_ready, _converter_err
    try:
        _converter = _build_converter()
        _converter_ready = True
    except Exception as e:  # 모델 번들 누락 등 → /health 5xx, /parse 503(폴백 유발, 무음통과 금지)
        _converter_err = f"{type(e).__name__}: {e}"
    yield


app = FastAPI(title="doc-ai-sidecar (docling)", lifespan=lifespan)


class ParseReq(BaseModel):
    filename: str
    content_base64: str


@app.get("/health")
def health() -> dict[str, str]:
    if not _converter_ready:
        raise HTTPException(status_code=503, detail=f"model not ready: {_converter_err or 'loading'}")
    return {"status": "ok"}


# ── 페이지 사전 스캔(pypdfium2, 가벼움) → 티어/품질 신호 ─────────────────────────────
def _is_garbled(ch: str) -> bool:
    """글꼴(ToUnicode) 손상 신호: U+FFFD(치환)·PUA(E000–F8FF)·제어문자(탭/개행 제외). assessQuality 정합."""
    cc = ord(ch)
    return cc == 0xFFFD or (0xE000 <= cc <= 0xF8FF) or (0 < cc < 9) or (0x0E <= cc <= 0x1F)


def _page_text_scan(pdf_bytes: bytes) -> dict[str, Any]:
    """페이지당 텍스트량·글꼴손상으로 스캔/needsOcr 후보 산출(Docling 추론 전 가벼운 1-pass)."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        n = len(pdf)
        per_page: list[int] = []
        garbled_ratio: list[float] = []
        hangul = 0
        total = 0
        for i in range(n):
            tp = pdf[i].get_textpage()
            txt = tp.get_text_range() or ""
            per_page.append(len(txt.strip()))
            g = sum(1 for ch in txt if _is_garbled(ch))
            garbled_ratio.append(g / max(1, len(txt)))
            for ch in txt:
                total += 1
                if "가" <= ch <= "힣":
                    hangul += 1
        # needsOcr 후보: 저텍스트(스캔) 또는 글꼴손상(PUA/제어문자 과다) — 엔진 비대칭(pdfjs vs pypdfium2) 대비 2신호.
        ocr_candidates = sorted(set(
            [i + 1 for i, c in enumerate(per_page) if c < settings.scan_max_chars_per_page]
            + [i + 1 for i, r in enumerate(garbled_ratio) if r > settings.pua_ratio_threshold]
        ))
        avg = sum(per_page) / n if n else 0
        return {
            "pageCount": n,
            "avgCharsPerPage": avg,
            "ocrCandidatePages": ocr_candidates,
            "avgHangulRatio": (hangul / total) if total else 0.0,
            "isImageBased": n > 0 and len([c for c in per_page if c < settings.scan_max_chars_per_page]) >= max(1, n * 0.6),
        }
    finally:
        pdf.close()


# ── 3단계 OCR: 손상/스캔 페이지 렌더 → DGX VLM(pdf-ocr-recover.ts 재현) ─────────────
def _render_pages_to_png(pdf_bytes: bytes, pages: list[int]) -> dict[int, bytes]:
    """ocrCandidatePages(1-based)를 PNG 렌더. 페이지별 격리(실패 제외) + 연속실패 비용상한."""
    import pypdfium2 as pdfium

    out: dict[int, bytes] = {}
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        n = len(pdf)
        consec = 0
        for p in pages:
            if p < 1 or p > n:
                continue
            try:
                bmp = pdf[p - 1].render(scale=settings.ocr_render_scale)  # 72×scale DPI
                buf = io.BytesIO()
                bmp.to_pil().save(buf, format="PNG")
                out[p] = buf.getvalue()
                consec = 0
            except Exception:
                consec += 1
                if consec >= settings.ocr_max_consec_fails:  # 구조적 손상 PDF 조기중단(DGX 호출 낭비 차단)
                    break
    finally:
        pdf.close()
    return out


def _vlm_ocr_page(png: bytes) -> str:
    """단일 페이지 PNG → DGX VLM(OpenAI 호환 /v1/chat/completions). temperature=0(vlm-provider 정합)."""
    b64 = base64.b64encode(png).decode("ascii")
    body: dict[str, Any] = {
        "model": settings.dgx_model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": _VLM_PROMPT},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
        ]}],
        "max_tokens": settings.vlm_max_tokens,
        "temperature": 0,
    }
    if settings.vlm_seed is not None:
        body["seed"] = settings.vlm_seed
    headers = {"Content-Type": "application/json"}
    if settings.dgx_api_key:
        headers["Authorization"] = f"Bearer {settings.dgx_api_key}"
    r = _http.post(f"{settings.dgx_url}/v1/chat/completions", json=body, headers=headers, timeout=settings.vlm_page_timeout)
    if r.status_code != 200:
        raise RuntimeError(f"VLM 요청 실패({r.status_code}): {r.text[:200]}")
    return (r.json().get("choices", [{}])[0].get("message", {}).get("content") or "").strip()


def _recover_pages(pdf_bytes: bytes, candidate_pages: list[int]) -> dict[int, str]:
    """손상/스캔 페이지를 렌더→VLM OCR 복구. 총 데드라인·페이지상한 내. 페이지별 2회 재시도."""
    import time

    target = list(dict.fromkeys(candidate_pages))[: settings.vlm_recover_max_pages]
    if not target:
        return {}
    pngs = _render_pages_to_png(pdf_bytes, target)
    recovered: dict[int, str] = {}
    deadline = time.monotonic() + settings.ocr_total_timeout
    for p in target:
        if time.monotonic() > deadline:
            break
        png = pngs.get(p)
        if png is None:
            continue
        for _ in range(2):  # 빈 응답 대비 페이지당 2회
            try:
                text = _vlm_ocr_page(png)
                if text:
                    recovered[p] = text
                    break
            except Exception:
                continue
    return recovered


# ── Docling 문서 → IRBlock 매핑 ────────────────────────────────────────────────────
def _table_to_dense_grid(table_item: Any) -> dict[str, Any] | None:
    """Docling TableData → 조밀 rows×cols 그리드(병합 빈셀 채움). ragged 금지(amendment-table 정합)."""
    data = getattr(table_item, "data", None)
    if data is None:
        return None
    n_rows = int(getattr(data, "num_rows", 0) or 0)
    n_cols = int(getattr(data, "num_cols", 0) or 0)
    cells_in = list(getattr(data, "table_cells", []) or [])
    if n_rows <= 0 or n_cols <= 0 or not cells_in:
        return None
    grid = [[{"text": "", "colSpan": 1, "rowSpan": 1} for _ in range(n_cols)] for _ in range(n_rows)]
    for c in cells_in:
        r0 = int(getattr(c, "start_row_offset_idx", 0) or 0)
        c0 = int(getattr(c, "start_col_offset_idx", 0) or 0)
        r1 = int(getattr(c, "end_row_offset_idx", r0 + 1) or (r0 + 1))
        c1 = int(getattr(c, "end_col_offset_idx", c0 + 1) or (c0 + 1))
        if 0 <= r0 < n_rows and 0 <= c0 < n_cols:
            grid[r0][c0] = {
                "text": (getattr(c, "text", "") or "").strip(),
                "colSpan": max(1, c1 - c0),
                "rowSpan": max(1, r1 - r0),
            }
    return {"rows": n_rows, "cols": n_cols, "hasHeader": n_rows > 1, "cells": grid}


def _picture_base64(doc: Any, pic_item: Any) -> str | None:
    try:
        img = pic_item.get_image(doc)
        if img is None:
            return None
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return None


def _page_no(item: Any) -> int | None:
    prov = getattr(item, "prov", None)
    if prov:
        try:
            return int(prov[0].page_no)
        except Exception:
            return None
    return None


def _map_document(doc: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    from docling_core.types.doc import (
        DocItemLabel, TableItem, PictureItem, SectionHeaderItem, TextItem, ListItem,
    )

    blocks: list[dict[str, Any]] = []
    outline: list[dict[str, Any]] = []
    for item, level in doc.iterate_items():
        page = _page_no(item)
        if isinstance(item, TableItem):
            grid = _table_to_dense_grid(item)
            if grid:
                b: dict[str, Any] = {"type": "table", "table": grid}
                if page:
                    b["pageNumber"] = page
                blocks.append(b)
            continue
        if isinstance(item, PictureItem):
            b = {"type": "image"}
            data64 = _picture_base64(doc, item)
            if data64:
                b["imageData"] = {"dataBase64": data64, "mimeType": "image/png"}
            cap = (item.caption_text(doc) if hasattr(item, "caption_text") else "") or ""
            if cap:
                b["text"] = cap
            if page:
                b["pageNumber"] = page
            blocks.append(b)
            continue
        text = (getattr(item, "text", "") or "").strip()
        if not text:
            continue
        lbl = getattr(item, "label", None)
        is_heading = isinstance(item, SectionHeaderItem) or lbl in (DocItemLabel.TITLE, DocItemLabel.SECTION_HEADER)
        is_list = isinstance(item, ListItem) or lbl == DocItemLabel.LIST_ITEM
        if is_heading:
            lvl = int(level) if isinstance(level, int) and level > 0 else 2
            lvl = min(6, max(1, lvl))
            blocks.append({"type": "heading", "level": lvl, "text": text, **({"pageNumber": page} if page else {})})
            outline.append({"level": lvl, "text": text, **({"pageNumber": page} if page else {})})
        elif is_list:
            blocks.append({"type": "list", "text": text, **({"pageNumber": page} if page else {})})
        else:
            blocks.append({"type": "paragraph", "text": text, **({"pageNumber": page} if page else {})})
    return blocks, outline


def _run_parse(pdf_bytes: bytes, filename: str) -> dict[str, Any]:
    """PDF → ParsedDoc dict (순수 파싱·OCR 흡수). 가드는 _guarded_parse. /parse·/convert 공용."""
    scan = _page_text_scan(pdf_bytes)
    warnings: list[str] = []

    from docling.datamodel.base_models import DocumentStream

    result = _converter.convert(DocumentStream(name=filename, stream=io.BytesIO(pdf_bytes)))
    doc = result.document
    markdown = doc.export_to_markdown() or ""
    blocks, outline = _map_document(doc)

    # ── 3단계: 스캔/손상 페이지 OCR 흡수(사이드카가 DGX VLM 직접) ──
    needs_ocr = bool(scan["ocrCandidatePages"]) and not settings.docling_do_ocr
    used_ocr = False
    if needs_ocr and settings.dgx_url:
        try:
            recovered = _recover_pages(pdf_bytes, scan["ocrCandidatePages"])
        except Exception as e:
            recovered = {}
            warnings.append(f"VLM OCR 복구 실패: {type(e).__name__}: {e}")
        if recovered:
            for p in sorted(recovered):
                markdown += f"\n\n<!-- VLM 복구 페이지 {p} -->\n{recovered[p]}"
                blocks.append({"type": "heading", "level": 3, "text": f"[복구 페이지 {p}]"})
                for para in [s.strip() for s in re.split(r"\n{2,}", recovered[p]) if s.strip()]:
                    blocks.append({"type": "paragraph", "text": para})
            used_ocr = True
            needs_ocr = False  # 복구 완료 → 신호 해소
            warnings.append(
                f"글꼴 손상/스캔 의심 {len(recovered)}개 페이지를 VLM OCR로 복구함(p.{', '.join(map(str, sorted(recovered)))})."
            )

    # lowQuality 재평가(설계 §1-c): OCR 복구 성공 시 해소(OCR-전 기준 잔존 방지)
    low_quality = (bool(scan["isImageBased"]) or scan["avgCharsPerPage"] < settings.ocr_min_chars_per_page) and not used_ocr
    if needs_ocr:
        warnings.append(f"저텍스트/손상 페이지 {len(scan['ocrCandidatePages'])}개 — OCR 미복구(DGX 미도달 가능, 어댑터가 kordoc 폴백).")

    title = None
    try:
        title = doc.name or None
    except Exception:
        title = None

    return {
        "markdown": markdown, "title": title, "blocks": blocks, "outline": outline,
        "pageCount": scan["pageCount"], "isImageBased": scan["isImageBased"],
        "usedOcr": used_ocr, "lowQuality": low_quality,
        "qualitySummary": {
            "needsOcr": needs_ocr,
            "ocrCandidatePages": scan["ocrCandidatePages"],
            "avgHangulRatio": round(scan["avgHangulRatio"], 4),
        },
        "warnings": warnings,
    }


def _guarded_parse(pdf_bytes: bytes, filename: str) -> dict[str, Any]:
    """모델 준비·동시성 가드 + 폴백 계약(503/500). 포화/실패 시 throw → 클라가 kordoc 폴백."""
    if not _converter_ready:
        raise HTTPException(status_code=503, detail=f"model not ready: {_converter_err or 'loading'}")
    if not _sema.acquire(blocking=False):  # 동시성 가드(설계 §9): 포화 시 503
        raise HTTPException(status_code=503, detail="busy: max concurrency reached")
    try:
        return _run_parse(pdf_bytes, filename)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"docling parse 실패: {type(e).__name__}: {e}")
    finally:
        _sema.release()


@app.post("/parse")
def parse(req: ParseReq) -> dict[str, Any]:
    """ibk-parser 계약(JSON base64 → 풍부한 ParsedDoc/IRBlock). lib/pdf-docling.ts 어댑터용."""
    return _guarded_parse(base64.b64decode(req.content_base64), req.filename)


@app.post("/convert")
async def convert(file: UploadFile = File(...)) -> dict[str, Any]:
    """law-core-ai 계약(multipart file → {data:{text}}) — 종국 통합용.
    law-core-ai 가 converter_url=http://doc-ai:8900, use_local=False 로 연결하면 PyPDF2 대신 Docling 텍스트 사용
    (G3에서 본 과잉OCR/복잡표 문서도 깨끗). PDF 외엔 415 → law-core-ai 가 local(_convert_local) 폴백.
    구조(blocks)는 ibk-parser 전용 /parse 로, law-core-ai 는 평문 text 만 소비 → 단일 Docling 서비스로 변환 dedup."""
    name = file.filename or "upload.pdf"
    ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    if ext != "pdf":
        raise HTTPException(status_code=415, detail="doc-ai /convert: PDF 전용(비PDF는 law-core-ai local 변환)")
    content = await file.read()
    r = _guarded_parse(content, name)
    return {"data": {"text": r["markdown"]}}
