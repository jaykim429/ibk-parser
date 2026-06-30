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
  // ⚠️ fail-closed: 디폴트 외부망(OpenRouter) 폴백 제거. env 미설정 시 임베딩 호출이
  //    즉시 실패하도록(embedding.ts 가드) → 폐쇄망에서 내규 파생 텍스트가 외부로 침묵 송출되는 것 방지.
  //    운영 시 EMBEDDING_API_URL에 내부(또는 명시적 외부) 엔드포인트를 반드시 지정.
  embeddingApiUrl: env.EMBEDDING_API_URL || "",
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

  // ── 결정성/재현성 (컴플라이언스·백테스팅: 같은 입력 → 같은 결과가 불변식) ──
  //   분석 경로 LLM 호출의 '1차(결과)' temperature. 0=그리디(결정적). 사이트별 리터럴 대신
  //   이 단일 노브로 전 호출을 통일 → 판정/추출/커버리지/보고서의 '클라이언트측 샘플링 변동'을 제거.
  //   ⚠️ 절반의 해결: 서버측 잔여 비결정(vLLM 배치 구성·부동소수 비결합)은 temperature로 못 잡는다.
  //   ⚠️ end-to-end 완전 재현엔 core-ai의 analyze/parseBill·임베딩·검색순위 서버측 결정화(+seed)가 동반돼야 함(백엔드 책임).
  //      특히 analyze가 흔들리면 쿼리→검색후보가 바뀌어 하류(결정화된 judge)도 다른 입력을 본다.
  llmTemperature: num(env.LLM_TEMPERATURE, 0),
  //   파싱 실패(드묾·응답 잘림 등) '재시도'에서만 쓰는 temperature. 1차가 0이면 재시도도 0일 때
  //   동일 출력이 재생산돼 복구가 무의미 → 재시도는 살짝 샘플링해 다른 출력으로 회복(공통 경로는 결정적 유지).
  llmRetryTemperature: num(env.LLM_RETRY_TEMPERATURE, 0.3),

  // ── 타임아웃(ms) ──
  pipelineTimeoutMs: num(env.PIPELINE_TIMEOUT_MS, 180000), // 개별 LLM/rerank/analyze 호출 1건 상한
  pipelineTotalTimeoutMs: num(env.PIPELINE_TOTAL_TIMEOUT_MS, 600000), // 파이프라인 전체 데드라인(좀비 요청·무한 대기 차단)
  embeddingTimeoutMs: num(env.EMBEDDING_TIMEOUT_MS, 60000),
  qdrantTimeoutMs: num(env.QDRANT_TIMEOUT_MS, 30000),

  // ── 업로드/리소스 가드 ──
  maxUploadBytes: num(env.MAX_UPLOAD_BYTES, 30 * 1024 * 1024), // 서버측 업로드 크기 상한(기본 30MB — 관측 최대 8.6MB+스캔 매뉴얼 여유, OOM 무위험, env 조정)
  // 동시 파이프라인 상한 — 무거운 분석(다수 LLM·OCR·600s)이 동시 다발로 들어오면 core-ai 과부하·인스턴스 OOM.
  //  초과 요청은 즉시 429(큐 대기 없음 — 클라 데드라인 충돌·복잡 회피). 전제: 단일 인스턴스(다중이면 분산제어 필요).
  //  백엔드(core-ai) 동시 처리 용량에 맞춰 조정.
  maxConcurrentPipelines: num(env.MAX_CONCURRENT_PIPELINES, 3),
  // 업로드 허용 확장자(소문자) — 무거운 파싱 진입 전 조기 차단(UX·자원). 내용 검증은 kordoc이 수행(매직바이트 불요).
  allowedUploadExts: (env.ALLOWED_UPLOAD_EXTS || "pdf,hwp,hwpx,docx")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // ── 입력 문서 분석/청킹 ──
  maxAnalyzeChars: num(env.MAX_ANALYZE_CHARS, 60000), // analyze/parseBill 본문 절단 한계
  clampHeadRatio: num(env.CLAMP_HEAD_RATIO, 0.7), // 절단 시 앞부분 비율(나머지는 뒤). 제안이유=앞·부칙=뒤 보존
  subQueryMax: num(env.SUBQUERY_MAX, 6), // 입력 문서 변경단위 서브쿼리 상한
  canonicalTermMax: num(env.CANONICAL_TERM_MAX, 30), // 대표 쿼리 키워드+개념 상한
  subQueryMinLen: num(env.SUBQUERY_MIN_LEN, 4), // 서브쿼리 본문 최소 길이
  queryMaxLen: num(env.QUERY_MAX_LEN, 800), // 대표/폴백/의무 대표쿼리 길이 캡(임베딩 희석 방지)
  subQueryLen: num(env.SUBQUERY_LEN, 280), // 개별 서브쿼리(변경단위·의무·신구조문) 길이 캡

  // ── 매뉴얼형(비정형) 내규 청킹 — 헤딩 섹션 단위 + overlap 서브분할 ──
  manualChunkSize: num(env.MANUAL_CHUNK_SIZE, 900), // 섹션·표 청크 최대 글자(표도 동일 분할 → 거대표 꼬리손실 방지)
  manualChunkOverlap: num(env.MANUAL_CHUNK_OVERLAP, 150), // 서브분할 겹침
  embeddingTextCap: num(env.EMBEDDING_TEXT_CAP, 2000), // 청크 임베딩/BM25 텍스트 길이 캡(매직넘버 제거)

  // ── 비정형 헤딩 인지 정규화(인덱싱 경로 전용 — manualToChunks) ──
  //    순수 정규식: 헤딩 형태정규화 + 인접 동일헤딩 dedup + 목차(TOC) 보존격리.
  //    라이브 분석(markdown)엔 무영향. false-negative 방지로 TOC는 삭제하지 않고 단일 메타유닛으로 흡수.
  headingNormalizeEnabled: (env.HEADING_NORMALIZE_ENABLED ?? "true") !== "false",
  tocRunsPerBlock: num(env.TOC_RUNS_PER_BLOCK, 2), // 블록당 점선리더 런이 이 수 이상이면 목차 라인 후보
  tocMinLines: num(env.TOC_MIN_LINES, 3), // 목차 라인 후보가 이 수 이상 연속이면 목차 구간으로 격리
  tocManyRuns: num(env.TOC_MANY_RUNS, 6), // 단일 블록에 점선리더 런이 이 수 이상이면(거대 목차블록) 단독 격리

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

  // ── 과잉 OCR 가드: kordoc이 본문은 깨끗 추출하면서도 빈 표지/도표(0자) 페이지를 OCR 후보로 flag해 VLM OCR을
  //    과트리거(낭비)하는 것을 차단. 실측(진단): 본문 garbled 0%, 빈 페이지만 후보. 진짜 스캔/손상 페이지는
  //    전량 유지(무회귀 OR 트립와이어). 디지털·깨끗 판정 시 per-page ocrReason 으로 빈 표지(low_text)만 제외하고
  //    손상사유(high_pua/control/replacement) 페이지는 유지(텍스트 복구 가치). 품질메트릭 기반 일반 판정 [[avoid-hardcoding-general-llm]].
  ocrGuardEnabled: (env.OCR_GUARD_ENABLED ?? "true") !== "false", // 마스터 스위치(롤백)
  ocrGuardScanLowTextFrac: num(env.OCR_GUARD_SCAN_LOWTEXT_FRAC, 0.7), // 저텍스트 페이지 비율 ≥ → 진짜 스캔(전량 유지)
  ocrGuardScanCandFrac: num(env.OCR_GUARD_SCAN_CAND_FRAC, 0.5), // 후보 페이지 비율 ≥ → 진짜 스캔(전량 유지)
  ocrGuardCleanPuaRatio: num(env.OCR_GUARD_CLEAN_PUA, 0.05), // 본문 PUA비율 ≥ → 글꼴손상(전량 유지)
  ocrGuardCleanReplRatio: num(env.OCR_GUARD_CLEAN_REPL, 0.01), // 본문 치환문자비율 ≥ → 손상(전량 유지)
  ocrGuardCleanCtrlRatio: num(env.OCR_GUARD_CLEAN_CTRL, 0.05), // 본문 제어문자비율 ≥ → 손상(전량 유지)

  // ── 캐시 (로직 변경 시 버전만 올리면 무효화) ──
  cacheVersion: env.REPORT_CACHE_VERSION || "v56",
  cacheMaxEntries: num(env.CACHE_MAX_ENTRIES, 50),

  // ── 데이터 ──
  regulationsDir: env.IBK_REG_DIR || "data/ibk-regulations",
} as const;

export type AppConfig = typeof config;
