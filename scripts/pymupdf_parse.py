# -*- coding: utf-8 -*-
"""
PyMuPDF 기반 PDF 파서 — kordoc이 약한 '다단 레이아웃 매뉴얼'(좌:번호/우:본문, 점선 목차)을
깔끔히 추출(읽기순서·표·헤딩 보존, 단어 간 공백 보존)한다.
Node(pdf-pymupdf.ts)가 PDF를 temp로 저장 후 호출.

출력(JSON, stdout): {"markdown": str, "pages": int, "title": str, "blocks": [...]}
 blocks: {"type":"heading"|"paragraph", "text":str, "level"?:int}
         {"type":"table", "table":{"rows":int,"cols":int,"cells":[[{"text":str}]],"hasHeader":bool}}
폐쇄망 가능(PyMuPDF 로컬 휠, 런타임 네트워크 불필요).
"""
import sys, json, re

try:
    import pymupdf  # PyMuPDF >= 1.24
except Exception:
    import fitz as pymupdf  # 구버전 호환

_WS = re.compile(r"[ \t\r\n]+")
_DOTS = re.compile(r"[ ]*[.·․‧⋯…]{3,}[ ]*")
# 진짜 헤딩(짧은 표제): 제N조/장/절, 번호(1. / 1.1), 가.나., 원문자
_HEAD = re.compile(r"^(제\s*\d+\s*(조|장|절|관|편)|\d+(\.\d+){0,3}\s*[.)]?\s|[가-힣]\s*[.)]\s|[①-⑳]|[IVXivx]+\s*[.)])")


def clean(s):
    s = _WS.sub(" ", (s or "")).strip()
    s = _DOTS.sub(" … ", s)  # 점선 리더 → 단일 말줄임
    return s


def extract(path):
    doc = pymupdf.open(path)
    blocks = []
    md_parts = []
    title = ""

    for page in doc:
        try:
            tables = list(page.find_tables().tables)
        except Exception:
            tables = []
        tbboxes = [tuple(t.bbox) for t in tables]

        items = []  # (y0, x0, kind, payload)
        # get_text("blocks"): (x0,y0,x1,y1, text, block_no, block_type) — text모드 공백 보존
        for tb in page.get_text("blocks"):
            if len(tb) < 6 or tb[6 if len(tb) > 6 else 5] not in (0, None) and len(tb) > 6 and tb[6] != 0:
                # block_type(마지막 인덱스 6) 0=텍스트만
                pass
            x0, y0, x1, y1 = tb[0], tb[1], tb[2], tb[3]
            text = tb[4] if len(tb) > 4 else ""
            btype = tb[6] if len(tb) > 6 else 0
            if btype != 0:
                continue  # 이미지 블록 제외
            inside = any(x0 >= t[0] - 2 and y0 >= t[1] - 2 and x1 <= t[2] + 2 and y1 <= t[3] + 2 for t in tbboxes)
            if inside:
                continue
            t = clean(text)
            if not t:
                continue
            items.append((y0, x0, "text", t))

        for tbl in tables:
            try:
                rows = tbl.extract()
            except Exception:
                rows = None
            if rows:
                items.append((tbl.bbox[1], tbl.bbox[0], "table", rows))

        items.sort(key=lambda v: (round(v[0]), round(v[1])))

        for _, _, kind, payload in items:
            if kind == "table":
                rows = payload
                R = len(rows)
                C = max((len(r) for r in rows), default=0)
                if R == 0 or C == 0:
                    continue
                cells = [[{"text": clean(rows[r][c]) if c < len(rows[r]) else ""} for c in range(C)] for r in range(R)]
                blocks.append({"type": "table", "table": {"rows": R, "cols": C, "cells": cells, "hasHeader": True}})
                md_parts.append("\n".join(" | ".join(clean(rows[r][c]) if c < len(rows[r]) else "" for c in range(C)) for r in range(R)))
            else:
                text = payload
                is_head = bool(_HEAD.match(text)) and len(text) <= 40
                if is_head:
                    blocks.append({"type": "heading", "text": text, "level": 3})
                    md_parts.append("### " + text)
                    if not title and 4 <= len(text) <= 60:
                        title = text
                else:
                    blocks.append({"type": "paragraph", "text": text})
                    md_parts.append(text)

    return {"markdown": "\n\n".join(md_parts), "pages": doc.page_count, "title": title, "blocks": blocks}


if __name__ == "__main__":
    out = extract(sys.argv[1])
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False))
