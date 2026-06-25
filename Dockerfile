# syntax=docker/dockerfile:1
#
# IBK 규제변동 영향분석 PoC — 폐쇄망(air-gap) 배포용 멀티스테이지 이미지
#
#  - 연결된 환경에서 1회 빌드 → docker save → tar 반입 → docker load (폐쇄망엔 npm/레지스트리 불필요)
#  - kordoc(file: 의존)은 저장소에 내재화돼 있어 오프라인으로 설치됨(사전빌드 dist 포함, 재빌드 불필요)
#  - 네이티브 의존성(pdfjs-dist/pdfium/sharp/pg)은 이미지 OS(linux)에 맞게 npm ci로 설치 → 플랫폼 안전
#
# ── 1) builder: 의존성 설치 + Next 빌드 ─────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# 일부 네이티브 모듈 빌드 대비(빌더에만 설치 — 런너 이미지에는 미포함)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 의존성 레이어 캐시: lock + kordoc(file: 의존)을 먼저 복사 후 설치
COPY package.json package-lock.json ./
COPY kordoc ./kordoc
RUN npm ci --no-audit --no-fund

# 소스 복사 후 프로덕션 빌드
COPY . .
RUN npm run build

# ── 2) runner: 실행 전용(슬림) ─────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

# 비루트 실행
RUN useradd -m -u 1001 appuser

# 런타임에 필요한 산출물만 복사
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/kordoc ./kordoc
COPY --from=builder /app/data ./data
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs

USER appuser
EXPOSE 4000
# next start -p 4000 (DB 적재 없음, 서버 RO + stateless 생성)
CMD ["npm", "run", "start"]
