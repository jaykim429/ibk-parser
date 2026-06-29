"""
doc-ai 사이드카 — PDF를 순수 Python Docling으로 파싱해 IBK 앱 계약(ParsedDoc) JSON으로 반환.

레거시 rookie-parser(ODL Java CLI) 대체. **Java 없음.** compliance-ibk/law-core-ai 컨벤션 정합
(FastAPI · Python 3.11 · uv · pydantic v2) → 종국엔 law-core-ai로 흡수 가능.

계약(HTTP) — pdf-docling.ts 어댑터와 1:1:
  POST /parse  { filename, content_base64 }
  200  { markdown, title?, blocks[], outline[], pageCount, isImageBased, usedOcr,
         lowQuality, qualitySummary{needsOcr,ocrCandidatePages,avgHangulRatio}, warnings[] }
       blocks: kordoc IRBlock 호환. image 는 imageData.dataBase64(base64)로 전송(어댑터가 Uint8Array 디코드).
       table.cells: 조밀 2D 그리드(rows×cols, 병합 빈셀 채움) — ragged 금지(amendPairs 무음 과소 차단).

티어링(설계 §4):
  · 스캔/저텍스트(needsOcr) → qualitySummary 로 신호만(실제 OCR 흡수는 3단계, DGX VLM). do_ocr=False 로 EasyOCR/CRAFT 배제(라이선스).
  · 디지털/복잡(표·신구조문대비표 포함) → Docling(Layout + TableFormer).
  · [TODO 최적화] 표 없는 순수 디지털의 pypdfium2/pdfminer 빠른경로 — 성능 분석상 파싱은 종단의 ~1~2%라 후순위.

⚠️ Docling API 버전 의존: docling 2.x 기준 작성. 배포 시 핀된 버전과 대조(특히 TableData.table_cells·PictureItem.get_image).
"""
from __future__ import annotations

import base64
import io
import threading
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """env 외부화(law-core-ai pydantic-settings 패턴). 임계는 kordoc quality.ts 와 정렬."""
    model_config = SettingsConfigDict(env_prefix="DOCAI_", extra="ignore")

    max_concurrency: int = 1          # GPU 단일 가정 — Docling 추론 직렬화. 포화 시 503 → 클라가 kordoc 폴백.
    scan_max_chars_per_page: int = 10  # 페이지당 이 미만이면 스캔/이미지 PDF 의심(needsOcr)
    ocr_min_chars_per_page: int = 80   # 이 미만(스캔 아님)이면 저품질 의심
    docling_do_ocr: bool = False       # ★ EasyOCR/CRAFT(비상업 가중치) 배제 — OCR 은 3단계 DGX VLM 정본
    docling_table_structure: bool = True
    generate_picture_images: bool = True  # 이미지 복원용(restoredHtml) — PictureItem 바이트 추출


settings = Settings()
_sema = threading.BoundedSemaphore(settings.max_concurrency)

# Docling 변환기는 무겁다(모델 상주) → 프로세스당 1회 로드 후 영구 상주(콜드스타트/언로드 방지, 설계 §9).
_converter: Any = None
_converter_ready = False
_converter_err: str | None = None


def _build_converter() -> Any:
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions

    opts = PdfPipelineOptions()
    opts.do_ocr = settings.docling_do_ocr           # False → 사이드카 OCR 미수행(라이선스·3단계 이관)
    opts.do_table_structure = settings.docling_table_structure
    opts.generate_picture_images = settings.generate_picture_images
    return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # 기동 시 모델 프리로드 → /health 는 로드 완료 후에만 ok(설계 §8-2: depends_on service_healthy 게이트).
    global _converter, _converter_ready, _converter_err
    try:
        _converter = _build_converter()
        # 워밍업(첫 추론 그래프 컴파일) — 첫 사용자 요청이 콜드스타트를 떠안지 않게.
        _converter_ready = True
    except Exception as e:  # 모델 번들 누락 등 → /health 5xx, /parse 503 (폴백 유발, 무음통과 금지)
        _converter_err = f"{type(e).__name__}: {e}"
    yield


app = FastAPI(title="doc-ai-sidecar (docling)", lifespan=lifespan)


class ParseReq(BaseModel):
    filename: str
    content_base64: str


@app.get("/health")
def health() -> dict[str, str]:
    # 모델 미준비면 503 → compose healthcheck 가 컨테이너를 unhealthy 로(요청 라우팅 차단).
    if not _converter_ready:
        raise HTTPException(status_code=503, detail=f"model not ready: {_converter_err or 'loading'}")
    return {"status": "ok"}


# ── 페이지 사전 스캔(pypdfium2, 가벼움) → 티어/품질 신호 ─────────────────────────────
def _page_text_scan(pdf_bytes: bytes) -> dict[str, Any]:
    """페이지당 텍스트량으로 스캔 여부·needsOcr 후보 페이지 산출(Docling 추론 전 가벼운 1-pass)."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        n = len(pdf)
        per_page: list[int] = []
        hangul = 0
        total = 0
        for i in range(n):
            page = pdf[i]
            tp = page.get_textpage()
            txt = tp.get_text_range() or ""
            per_page.append(len(txt.strip()))
            for ch in txt:
                total += 1
                if "가" <= ch <= "힣":
                    hangul += 1
        ocr_candidates = [i + 1 for i, c in enumerate(per_page) if c < settings.scan_max_chars_per_page]
        avg = sum(per_page) / n if n else 0
        return {
            "pageCount": n,
            "perPage": per_page,
            "avgCharsPerPage": avg,
            "ocrCandidatePages": ocr_candidates,
            "avgHangulRatio": (hangul / total) if total else 0.0,
            # 문서 다수가 저텍스트면 스캔 PDF 로 간주(이미지 기반)
            "isImageBased": n > 0 and len(ocr_candidates) >= max(1, n * 0.6),
        }
    finally:
        pdf.close()


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
    # 모든 좌표를 빈 셀로 선채움 → 병합/누락으로 인한 ragged 차단
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
    """PictureItem → PNG base64(restoredHtml 이미지 복원용). 실패 시 None(캡션만)."""
    try:
        img = pic_item.get_image(doc)  # PIL.Image | None
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
    """DoclingDocument → (blocks: IRBlock[], outline)."""
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
        # 텍스트류
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


@app.post("/parse")
def parse(req: ParseReq) -> dict[str, Any]:
    if not _converter_ready:
        raise HTTPException(status_code=503, detail=f"model not ready: {_converter_err or 'loading'}")
    # 동시성 가드(설계 §9): 포화 시 즉시 503 → 클라(어댑터)가 kordoc 폴백. 큐 폭주 방지.
    if not _sema.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="busy: max concurrency reached")
    try:
        pdf_bytes = base64.b64decode(req.content_base64)
        scan = _page_text_scan(pdf_bytes)
        warnings: list[str] = []

        # Docling 변환(do_ocr=False). 스캔 PDF 는 텍스트가 거의 안 나옴 → markdown 빈약 → 어댑터가 throw → kordoc 폴백(B경로 OCR).
        from docling.datamodel.base_models import DocumentStream

        result = _converter.convert(DocumentStream(name=req.filename, stream=io.BytesIO(pdf_bytes)))
        doc = result.document
        markdown = doc.export_to_markdown() or ""
        blocks, outline = _map_document(doc)

        needs_ocr = bool(scan["ocrCandidatePages"]) and not settings.docling_do_ocr
        low_quality = bool(scan["isImageBased"]) or scan["avgCharsPerPage"] < settings.ocr_min_chars_per_page
        if needs_ocr:
            warnings.append(
                f"저텍스트 페이지 {len(scan['ocrCandidatePages'])}개 — OCR 필요 신호(3단계 DGX VLM 이관 전까지 미복구)."
            )

        # 본문 정식 제목(Docling 가 추출하면 우선). pdf-docling.ts 가 pickTitle 첫 인자로 사용.
        title = None
        try:
            title = doc.name or None
        except Exception:
            title = None

        return {
            "markdown": markdown,
            "title": title,
            "blocks": blocks,
            "outline": outline,
            "pageCount": scan["pageCount"],
            "isImageBased": scan["isImageBased"],
            "usedOcr": False,  # 사이드카 OCR 미수행(3단계 전)
            "lowQuality": low_quality,
            "qualitySummary": {
                "needsOcr": needs_ocr,
                "ocrCandidatePages": scan["ocrCandidatePages"],
                "avgHangulRatio": round(scan["avgHangulRatio"], 4),
            },
            "warnings": warnings,
        }
    except HTTPException:
        raise
    except Exception as e:
        # 파싱 실패 → 5xx → 어댑터가 throw 처리 → kordoc 폴백(무중단).
        raise HTTPException(status_code=500, detail=f"docling parse 실패: {type(e).__name__}: {e}")
    finally:
        _sema.release()
