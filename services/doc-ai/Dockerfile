# doc-ai 사이드카 — python:3.11-slim + uv (compliance-ibk/law-core-ai 정합). JRE 없음(Java/ODL 제거).
# 멀티스테이지: 빌드툴 분리로 런타임 이미지 슬림화. 폐쇄망: 모델 가중치 굽기 + HF_HUB_OFFLINE.
FROM python:3.11-slim AS builder
ENV UV_SYSTEM_PYTHON=1 PIP_NO_CACHE_DIR=1
RUN pip install --no-cache-dir uv
WORKDIR /app
COPY requirements.txt .
# GPU 미할당 환경이면 CPU-only torch 로(이미지·메모리 절감):
#   RUN uv pip install --system torch --index-url https://download.pytorch.org/whl/cpu
RUN uv pip install --system -r requirements.txt

# ── 모델 프리페치(온라인 빌드 단계에서 1회) → 런타임 외부망 0 ──
# Docling Layout/TableFormer 가중치를 이미지에 굽는다. do_ocr=False 라 EasyOCR/CRAFT 가중치는 받지 않는다.
#  (docling 버전별 다운로드 메커니즘 상이 — 배포 전 1회 확인. 예: `docling-tools models download` 또는 최초 convert 시 자동)
ENV HF_HOME=/models/hf
RUN python - <<'PY'
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
opts = PdfPipelineOptions(); opts.do_ocr = False; opts.do_table_structure = True
DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})
print("docling converter init OK (models cached)")
PY
# 스모크: CRAFT(비상업) 가중치가 받아지지 않았는지 검증(라이선스 가드).
RUN ! find /models /root/.cache /models/hf -iname "*craft*" 2>/dev/null | grep -q . || (echo "ERROR: EasyOCR/CRAFT 가중치 포함됨 — do_ocr=False 위반" && exit 1)

FROM python:3.11-slim AS runtime
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HOME=/models/hf \
    PYTHONUNBUFFERED=1
# builder 의 설치 패키지 + 모델 복사
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /models /models
WORKDIR /app
COPY app.py .
EXPOSE 8900
# 단일 워커(GPU/모델 상주 — 동시성은 app.py 세마포어로 제어). compose healthcheck 가 /health 게이트.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8900", "--workers", "1"]
