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
  // M7: 전용 크로스인코더 리랭커(/rerank) 1차 사용. 실패 시 LLM 리랭커로 폴백.
  rerankUseServer: (env.RERANK_USE_SERVER ?? "true") !== "false",
  odsDbUrl: env.ODS_DB_URL || "",

  // ── 파서/OCR (DGX Spark VLM) ──
  dgxSparkUrl: env.DGX_SPARK_URL || "http://172.23.80.102:8000",
  dgxSparkModel: env.DGX_SPARK_MODEL || "google/gemma-4-26B-A4B-it",

  // ── PDF 파서 라우팅: kordoc(기본) | rookie(CG Rookie Parser 사이드카) ──
  //    PDF만 rookie로 위임 가능(HWP/HWPX는 항상 kordoc). 실패 시 kordoc 폴백.
  pdfParser: (env.PDF_PARSER || "kordoc").toLowerCase(), // "kordoc" | "rookie"
  rookieParserUrl: env.ROOKIE_PARSER_URL || "http://rookie-parser:8900",
  rookieTimeoutMs: num(env.ROOKIE_TIMEOUT_MS, 120000),

  // ── 임베딩 ──
  embeddingApiUrl: env.EMBEDDING_API_URL || "https://openrouter.ai/api/v1",
  embeddingApiKey: env.EMBEDDING_API_KEY || "",
  embeddingModel: env.EMBEDDING_MODEL || "qwen/qwen3-embedding-8b",
  embeddingDimension: num(env.EMBEDDING_DIMENSION, 4096),
  // M2: Qwen3-Embedding 비대칭 검색용 쿼리 지시문(쿼리 측에만 부착, passage는 raw).
  //     빈 문자열이면 미적용. (인덱스는 instruction 없이 적재됨)
  embeddingQueryInstruction:
    env.EMBEDDING_QUERY_INSTRUCTION ??
    "Instruct: 주어진 규제변동·법령 내용과 직접 관련된 은행 내규 조문을 검색한다.\nQuery: ",
  // M3: 대표 쿼리에 analyze 핵심요약(자연어 문장)을 포함(키워드 나열 + 자연어 혼합)
  canonicalUseSummary: (env.CANONICAL_USE_SUMMARY ?? "true") !== "false",

  // ── 타임아웃(ms) ──
  pipelineTimeoutMs: num(env.PIPELINE_TIMEOUT_MS, 180000),
  embeddingTimeoutMs: num(env.EMBEDDING_TIMEOUT_MS, 60000),
  qdrantTimeoutMs: num(env.QDRANT_TIMEOUT_MS, 30000),

  // ── 입력 문서 분석/청킹 ──
  maxAnalyzeChars: num(env.MAX_ANALYZE_CHARS, 60000), // analyze/parseBill 본문 절단 한계
  clampHeadRatio: num(env.CLAMP_HEAD_RATIO, 0.7), // 절단 시 앞부분 비율(나머지는 뒤). 제안이유=앞·부칙=뒤 보존
  subQueryMax: num(env.SUBQUERY_MAX, 6), // 입력 문서 변경단위 서브쿼리 상한
  canonicalTermMax: num(env.CANONICAL_TERM_MAX, 30), // 대표 쿼리 키워드+개념 상한
  subQueryMinLen: num(env.SUBQUERY_MIN_LEN, 4), // 서브쿼리 본문 최소 길이
  queryMaxLen: num(env.QUERY_MAX_LEN, 800), // 대표/폴백/의무 대표쿼리 길이 캡(임베딩 희석 방지)
  subQueryLen: num(env.SUBQUERY_LEN, 280), // 개별 서브쿼리(변경단위·의무·신구조문) 길이 캡

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

  // ── 본문 추출 게이트: 추출 본문이 이 글자수 미만이면 '추출 실패'로 보고 분석 중단 ──
  minBodyChars: num(env.MIN_BODY_CHARS, 300),

  // ── 도메인 관련성 게이트: 은행·금융 규제와 무관한 문서는 매칭 전 차단 ──
  relevanceGateEnabled: (env.RELEVANCE_GATE_ENABLED ?? "true") !== "false",

  // ── 근거법령 앵커(M1): 입력 법령 ↔ 내규 근거법령 직접 매칭 → 후보 가점/주입 ──
  anchorEnabled: (env.ANCHOR_ENABLED ?? "true") !== "false", // 근거법령 앵커 사용
  anchorBonus: num(env.ANCHOR_BONUS, 0.02), // 융합점수 가점(소프트 — 하드필터 아님)
  anchorMax: num(env.ANCHOR_MAX, 10), // 의미검색이 놓친 앵커 후보 주입 상한

  // ── 파서 품질 게이트 (의심 추출 감지) ──
  ocrMinCharsPerPage: num(env.OCR_MIN_CHARS_PER_PAGE, 80), // 페이지당 최소 글자수(미만이면 의심)

  // ── PDF 손상 페이지 VLM 재OCR 복구 (에이전틱) ──
  //    글꼴(ToUnicode) 손상으로 텍스트층은 있으나 추출이 깨진 페이지를 렌더→VLM으로 복구.
  vlmRecoverEnabled: (env.VLM_RECOVER_ENABLED ?? "true") !== "false",
  vlmRecoverMaxPages: num(env.VLM_RECOVER_MAX_PAGES, 20), // 복구 페이지 상한(비용 제한)

  // ── 캐시 (로직 변경 시 버전만 올리면 무효화) ──
  cacheVersion: env.REPORT_CACHE_VERSION || "v52",
  cacheMaxEntries: num(env.CACHE_MAX_ENTRIES, 50),

  // ── 데이터 ──
  regulationsDir: env.IBK_REG_DIR || "data/ibk-regulations",
} as const;

export type AppConfig = typeof config;
