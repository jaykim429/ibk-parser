# Rookie/ODL PDF 파싱 사이드카 — Python + JRE(ODL Java CLI용)
FROM python:3.12-slim

# ODL 은 Java CLI 를 호출 → JRE 필요. (rookie-parser 사용 시에도 ODL 백엔드가 Java 필요)
RUN apt-get update \
    && apt-get install -y --no-install-recommends default-jre-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

EXPOSE 8900
# 폐쇄망: 빌드 시 의존성/모델을 미리 받아 이미지에 포함(런타임 외부망 0).
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8900"]
