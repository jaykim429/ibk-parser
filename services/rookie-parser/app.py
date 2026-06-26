"""
Rookie Parser 사이드카 — PDF를 고품질 파싱해 IBK 앱 계약(ParsedDoc) JSON으로 반환.

계약:
  POST /parse  { "filename": str, "content_base64": str }
  200  { markdown, blocks[], outline[], pageCount, isImageBased, usedOcr, warnings[] }
       blocks: kordoc IRBlock 동일 스키마
         { type: "heading"|"paragraph"|"table"|"list"|"image"|"separator",
           text?, level?, pageNumber?, bbox?{page,x,y,width,height},
           table?{ rows, cols, hasHeader, cells: [[{text,colSpan,rowSpan}]] } }

엔진:
  기본 = OpenDataLoader(ODL) CLI(JSON, bbox/표/읽기순서, Apache-2.0).
  ▶ CG 'rookie-parser'(Docling+ODL 라우팅)로 교체하려면 run_parser()의 ODL 호출을
    rookie-parser 호출로 바꾸고 매핑만 맞추면 된다(아래 TODO).

※ ODL/rookie의 실제 JSON 필드명은 버전에 따라 다를 수 있으니 배포 시 map_element() 확인.
"""
import base64
import json
import os
import subprocess
import tempfile
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="rookie-parser-sidecar")

OCR_LANG = os.environ.get("ODL_OCR_LANG", "ko,en")


class ParseReq(BaseModel):
    filename: str
    content_base64: str


def _bbox(el: dict[str, Any]) -> dict[str, Any] | None:
    # ODL bbox: [left, bottom, right, top] (PDF point)
    b = el.get("bbox") or el.get("bounding_box")
    if not b or len(b) < 4:
        return None
    left, bottom, right, top = b[0], b[1], b[2], b[3]
    return {
        "page": el.get("page", el.get("page_number", 1)),
        "x": left,
        "y": top,
        "width": abs(right - left),
        "height": abs(top - bottom),
    }


def _table(el: dict[str, Any]) -> dict[str, Any] | None:
    rows = el.get("rows") or el.get("cells")
    if not rows:
        return None
    grid = []
    for r in rows:
        cells = r if isinstance(r, list) else r.get("cells", [])
        grid.append(
            [
                {
                    "text": (c.get("text") if isinstance(c, dict) else str(c)) or "",
                    "colSpan": (c.get("colSpan", c.get("col_span", 1)) if isinstance(c, dict) else 1),
                    "rowSpan": (c.get("rowSpan", c.get("row_span", 1)) if isinstance(c, dict) else 1),
                }
                for c in cells
            ]
        )
    n_rows = len(grid)
    n_cols = max((len(r) for r in grid), default=0)
    return {"rows": n_rows, "cols": n_cols, "hasHeader": n_rows > 1, "cells": grid}


# ODL/rookie element type → 우리 IRBlock type
TYPE_MAP = {
    "title": "heading", "heading": "heading", "section-header": "heading", "header": "heading",
    "paragraph": "paragraph", "text": "paragraph", "body": "paragraph",
    "list": "list", "list-item": "list",
    "table": "table",
    "figure": "image", "image": "image", "picture": "image",
}


def map_element(el: dict[str, Any]) -> dict[str, Any] | None:
    raw_type = str(el.get("type", el.get("category", "paragraph"))).lower()
    btype = TYPE_MAP.get(raw_type, "paragraph")
    block: dict[str, Any] = {"type": btype}
    text = el.get("text") or el.get("content") or ""
    if btype == "heading":
        block["text"] = text
        block["level"] = int(el.get("level", el.get("heading_level", 2)) or 2)
    elif btype == "table":
        t = _table(el)
        if not t:
            return None
        block["table"] = t
    elif btype == "image":
        block["text"] = text  # 캡션/대체텍스트
    else:
        if not text.strip():
            return None
        block["text"] = text
    bb = _bbox(el)
    if bb:
        block["bbox"] = bb
    if el.get("page") or el.get("page_number"):
        block["pageNumber"] = el.get("page", el.get("page_number"))
    return block


def blocks_to_markdown(blocks: list[dict]) -> str:
    out = []
    for b in blocks:
        if b["type"] == "heading":
            out.append("#" * min(6, b.get("level", 2)) + " " + b.get("text", ""))
        elif b["type"] == "table" and b.get("table"):
            for row in b["table"]["cells"]:
                out.append("| " + " | ".join((c.get("text") or "").replace("\n", " ") for c in row) + " |")
        elif b["type"] == "image":
            if b.get("text"):
                out.append(f"![{b['text']}]()")
        else:
            out.append(b.get("text", ""))
    return "\n\n".join(x for x in out if x)


def run_parser(pdf_path: str) -> dict[str, Any]:
    """ODL CLI → JSON. (TODO: CG rookie-parser 로 교체 시 이 함수만 변경)"""
    with tempfile.TemporaryDirectory() as outdir:
        cmd = [
            "opendataloader-pdf",
            "--input", pdf_path,
            "--format", "json",
            "--output", outdir,
            "--ocr-lang", OCR_LANG,
        ]
        subprocess.run(cmd, check=True, capture_output=True, timeout=300)
        files = [f for f in os.listdir(outdir) if f.endswith(".json")]
        if not files:
            raise RuntimeError("ODL: JSON 출력 없음")
        with open(os.path.join(outdir, files[0]), encoding="utf-8") as fp:
            return json.load(fp)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/parse")
def parse(req: ParseReq) -> dict[str, Any]:
    data = base64.b64decode(req.content_base64)
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(data)
        pdf_path = tmp.name
    try:
        doc = run_parser(pdf_path)
        # ODL JSON: 보통 {"elements"|"blocks"|"content": [...]} 형태 — 버전별 확인
        elements = doc.get("elements") or doc.get("blocks") or doc.get("content") or []
        blocks = [b for el in elements if (b := map_element(el))]
        outline = [
            {"level": b.get("level", 2), "text": b["text"], "pageNumber": b.get("pageNumber")}
            for b in blocks
            if b["type"] == "heading"
        ]
        pages = doc.get("pageCount") or doc.get("page_count") or doc.get("num_pages")
        return {
            "markdown": blocks_to_markdown(blocks),
            "blocks": blocks,
            "outline": outline,
            "pageCount": pages,
            "isImageBased": bool(doc.get("isImageBased", doc.get("is_scanned", False))),
            "usedOcr": bool(doc.get("usedOcr", doc.get("used_ocr", False))),
            "warnings": doc.get("warnings", []),
        }
    finally:
        try:
            os.unlink(pdf_path)
        except OSError:
            pass
