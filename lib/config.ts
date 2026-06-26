/**
 * 중앙 설정 — 모든 외부 연결정보·튜닝값을 한 곳에서 관리한다.
 *
 * 원칙:
 *  - env(.env.local) 우선, 없으면 안전한 기본값(fallback) 사용.
 *  - 코드 어디에도 IP/모델/매직넘버를 흩어두지 않는다 → 이 파일만 보면 전체 설정 파악.
 *  - 다른 앱(compliance.ihopper.co.kr 등)으로 이식 시 env만 바꾸면 동작.
 */
const env = process.env;
const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  // ── 외부 백엔드 (WireGuard 내부 IP — env로 오버라이드) ──
  coreAiBaseUrl: env.CORE_AI_BASE_URL || "http://172.24.0.104:5000",
  gatewayBaseUrl: env.GATEWAY_BASE_URL || "http://172.24.0.104:3000",
  qdrantUrl: env.QDRANT_URL || "http://172.24.0.104:6333",
  ibkRegCollection: env.IBK_REG_COLLECTION || "regulations_ibk_test",
  rerankUrl: env.RERANK_URL || "http://172.24.0.104:5000",
  odsDbUrl: env.ODS_DB_URL || "",

  // ── 파서/OCR (DGX Spark VLM) ──
  dgxSparkUrl: env.DGX_SPARK_URL || "http://172.23.80.102:8000",
  dgxSparkModel: env.DGX_SPARK_MODEL || "google/gemma-4-26B-A4B-it",

  // ── 임베딩 ──
  embeddingApiUrl: env.EMBEDDING_API_URL || "https://openrouter.ai/api/v1",
  embeddingApiKey: env.EMBEDDING_API_KEY || "",
  embeddingModel: env.EMBEDDING_MODEL || "qwen/qwen3-embedding-8b",
  embeddingDimension: num(env.EMBEDDING_DIMENSION, 4096),

  // ── 타임아웃(ms) ──
  pipelineTimeoutMs: num(env.PIPELINE_TIMEOUT_MS, 180000),
  embeddingTimeoutMs: num(env.EMBEDDING_TIMEOUT_MS, 60000),
  qdrantTimeoutMs: num(env.QDRANT_TIMEOUT_MS, 30000),

  // ── 입력 문서 분석/청킹 ──
  maxAnalyzeChars: num(env.MAX_ANALYZE_CHARS, 60000), // analyze/parseBill 본문 절단 한계
  subQueryMax: num(env.SUBQUERY_MAX, 6), // 입력 문서 변경단위 서브쿼리 상한
  canonicalTermMax: num(env.CANONICAL_TERM_MAX, 30), // 대표 쿼리 키워드+개념 상한
  subQueryMinLen: num(env.SUBQUERY_MIN_LEN, 4), // 서브쿼리 본문 최소 길이

  // ── 매뉴얼형(비정형) 내규 청킹 — 헤딩 섹션 단위 + overlap 서브분할 ──
  manualChunkSize: num(env.MANUAL_CHUNK_SIZE, 900), // 섹션 청크 최대 글자
  manualChunkOverlap: num(env.MANUAL_CHUNK_OVERLAP, 150), // 서브분할 겹침

  // ── 검색/리랭크/판정 튜닝 ──
  matchTopK: num(env.MATCH_TOPK, 30), // RRF 융합 후 후보 수
  vectorTopK: num(env.VECTOR_TOPK, 40), // 벡터 1차 후보
  bm25TopK: num(env.BM25_TOPK, 40), // BM25 1차 후보
  rerankKeep: num(env.RERANK_KEEP, 18), // 리랭크 후 판정 대상
  judgeMax: num(env.JUDGE_MAX, 18),
  rrfK: num(env.RRF_K, 60),
  bm25K1: num(env.BM25_K1, 1.5),
  bm25B: num(env.BM25_B, 0.75),
  vectorHighThreshold: num(env.VECTOR_HIGH_THRESHOLD, 0.55), // 코사인→importance high
  vectorMediumThreshold: num(env.VECTOR_MEDIUM_THRESHOLD, 0.42), // 코사인→importance medium

  // ── 도메인 관련성 게이트: 은행·금융 규제와 무관한 문서는 매칭 전 차단 ──
  relevanceGateEnabled: (env.RELEVANCE_GATE_ENABLED ?? "true") !== "false",

  // ── 근거법령 앵커(M1): 입력 법령 ↔ 내규 근거법령 직접 매칭 → 후보 가점/주입 ──
  anchorEnabled: (env.ANCHOR_ENABLED ?? "true") !== "false", // 근거법령 앵커 사용
  anchorBonus: num(env.ANCHOR_BONUS, 0.02), // 융합점수 가점(소프트 — 하드필터 아님)
  anchorMax: num(env.ANCHOR_MAX, 10), // 의미검색이 놓친 앵커 후보 주입 상한

  // ── 파서 품질 게이트 (의심 추출 감지) ──
  ocrMinCharsPerPage: num(env.OCR_MIN_CHARS_PER_PAGE, 80), // 페이지당 최소 글자수(미만이면 의심)

  // ── 캐시 (로직 변경 시 버전만 올리면 무효화) ──
  cacheVersion: env.REPORT_CACHE_VERSION || "v18",
  cacheMaxEntries: num(env.CACHE_MAX_ENTRIES, 50),

  // ── 데이터 ──
  regulationsDir: env.IBK_REG_DIR || "data/ibk-regulations",
} as const;

export type AppConfig = typeof config;
