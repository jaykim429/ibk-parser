"""
G3 엔진 대조 — 사이드카 pypdfium2 사전스캔 vs kordoc(pdfjs) needsOcr 일치 검증.

finding B: needsOcr 비대칭의 원인이 추출 엔진(pdfjs vs pypdfium2)일 수 있음 → 사이드카(pypdfium2)가
kordoc이 OCR 필요로 본 문서를 동일하게 식별하는지 실측. 불일치 크면 DOCLING_FALLBACK_ON_NEEDSOCR 기본 ON 필요.

baseline(golden-baseline.json)에서 usedOcr=true(또는 timeout) 문서를 골라, app.py 와 동일 로직으로
pypdfium2 per-page 스캔 → needsOcr 후보 산출 → kordoc 판정(usedOcr)과 대조.

실행:  python scripts/g3-engine-scan.py
"""
import json
import os

import pypdfium2 as pdfium

DIR = "샘플 파일"
BASE = "scratchpad/golden-baseline.json"
SCAN_MAX_CHARS = 10      # app.py settings.scan_max_chars_per_page
OCR_MIN_CHARS = 80       # ocr_min_chars_per_page
PUA_RATIO = 0.01         # pua_ratio_threshold


def is_garbled(ch: str) -> bool:
    cc = ord(ch)
    return cc == 0xFFFD or (0xE000 <= cc <= 0xF8FF) or (0 < cc < 9) or (0x0E <= cc <= 0x1F)


def scan(path: str) -> dict:
    pdf = pdfium.PdfDocument(path)
    try:
        n = len(pdf)
        per_page, garb = [], []
        for i in range(n):
            txt = (pdf[i].get_textpage().get_text_range() or "")
            per_page.append(len(txt.strip()))
            g = sum(1 for ch in txt if is_garbled(ch))
            garb.append(g / max(1, len(txt)))
        cand = sorted(set(
            [i + 1 for i, c in enumerate(per_page) if c < SCAN_MAX_CHARS]
            + [i + 1 for i, r in enumerate(garb) if r > PUA_RATIO]
        ))
        avg = sum(per_page) / n if n else 0
        return {"pages": n, "avgChars": round(avg, 1), "ocrCandidates": cand,
                "needsOcr": bool(cand), "lowQuality": avg < OCR_MIN_CHARS}
    finally:
        pdf.close()


def main():
    base = json.load(open(BASE, encoding="utf-8"))["metrics"]
    # kordoc 기준 OCR 문서(usedOcr) + timeout(대형 OCR 추정)
    kordoc_ocr = {m["file"] for m in base if m.get("usedOcr")}
    kordoc_timeout = {m["file"] for m in base if not m.get("ok")}
    targets = sorted(kordoc_ocr | kordoc_timeout)

    agree = miss = 0
    print(f"=== G3: pypdfium2(사이드카) vs kordoc needsOcr 대조 ({len(targets)}건) ===")
    for f in targets:
        p = os.path.join(DIR, f)
        if not os.path.exists(p):
            continue
        try:
            s = scan(p)
        except Exception as e:
            print(f"  ERR  {f[:45]} → {type(e).__name__}")
            continue
        kordoc_says = "OCR" if f in kordoc_ocr else "timeout(OCR추정)"
        sidecar = "needsOcr" if s["needsOcr"] else "정상(미감지!)"
        ok = s["needsOcr"]
        agree += ok
        miss += (not ok)
        flag = "✅" if ok else "⚠️ 불일치"
        print(f"  {flag} kordoc={kordoc_says} | pypdfium2: {sidecar} "
              f"(pages={s['pages']} avg={s['avgChars']}자 후보={len(s['ocrCandidates'])}p) | {f[:42]}")
    print(f"\n일치(pypdfium2도 needsOcr): {agree} / 불일치(미감지): {miss} / 대상 {len(targets)}")
    print("→ 불일치 0이면 사이드카 사전스캔이 kordoc OCR 문서를 모두 포착(엔진 비대칭 무해). "
          "불일치 多면 DOCLING_FALLBACK_ON_NEEDSOCR=true 권장.")


if __name__ == "__main__":
    main()
