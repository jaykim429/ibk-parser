# IBK 규제변동 영향분석 PoC

규제변동 문서(법률안·시행령·고시·보도자료·비조치의견서 등)를 업로드하면,
IBK 사내 내규와 매칭하여 컴플라이언스 영향분석 보고서를 생성합니다.

## 파이프라인

```
업로드 → kordoc 파싱 → analyze ∥ parse(서버 RO)
   → 입력문서 멀티쿼리 청킹 → 하이브리드 검색(BM25 로컬 ∥ Qdrant 벡터 → RRF)
   → LLM 리랭커 → LLM 적합성·영향도 판정 → 보고서 생성(HWPX/PDF)
```

- 핵심 모듈: `lib/pipeline.ts`(CompliancePipeline), `lib/retrieval.ts`(HybridRetriever),
  `lib/judge.ts`, `lib/report.ts`, `lib/doc-text.ts`(파서 유틸), `lib/config.ts`(중앙 설정).
- 설정은 전부 `lib/config.ts`(env 우선) — IP·모델·튜닝값 하드코딩 없음.

## 실행

```bash
npm install        # 의존성 (kordoc은 file:kordoc 로 저장소에 내재화됨)
npm run dev        # http://localhost:4000
npm run test:parser  # 파서 유틸 단위 테스트
```

`.env.local` 필요(저장소에 미포함 — 비밀값):
`CORE_AI_BASE_URL`, `QDRANT_URL`, `IBK_REG_COLLECTION`, `EMBEDDING_API_*`,
`RERANK_URL`, `ODS_DB_URL`, `DGX_SPARK_*` 등. (기본값은 `lib/config.ts` 참조)

## 폐쇄망(air-gap) 배포 — Docker 권장

사내 인프라가 docker-compose 기반이므로 **Docker 이미지**로 배포한다.
이미지 안에 모든 의존성(네이티브 포함)이 OS에 맞게 빌드되어 들어가므로
폐쇄망에는 **npm/레지스트리가 전혀 필요 없다.**

### 1) 연결된 환경에서 이미지 빌드·내보내기
```bash
docker build -t ibk-compliance-poc:latest .
docker save ibk-compliance-poc:latest | gzip > ibk-compliance-poc.tar.gz
```
- `kordoc`는 저장소에 내재화돼 있어(소스+사전빌드 `dist/`) 빌드 중 오프라인 설치된다.
- `pdfjs-dist`/`@hyzyla/pdfium`/`sharp` 등 네이티브 의존성도 `npm ci`로 linux 바이너리 설치 → 플랫폼 안전.

### 2) 폐쇄망으로 반입·적재·실행
```bash
gunzip -c ibk-compliance-poc.tar.gz | docker load
cp .env.docker.example .env.docker   # 내부 엔드포인트/키로 수정
docker compose -f docker-compose.poc.yml up -d
```
- `.env.docker`는 도커 네트워크의 서비스명/내부 IP로 백엔드를 가리킨다(`.env.docker.example` 참고).
- 앱을 core-ai·qdrant 등이 있는 **사내 네트워크**에 연결한다(compose의 `networks` 수정).

### ⚠️ 폐쇄망 필수 체크 — 임베딩 엔드포인트
- analyze/LLM(core-ai), 보고서/OCR(DGX), 벡터(Qdrant), 카탈로그(ODS)는 **모두 내부망**이라 OK.
- **임베딩만 기본값이 OpenRouter(외부망)** 이다. 폐쇄망에서는 외부로 못 나가므로
  `EMBEDDING_API_URL`을 **사내 임베딩 서비스(동일 모델·4096차원)** 로 반드시 교체해야 한다.

### 3) 내규 인덱싱(최초 1회)
`node scripts/index-regulations.mjs` — `data/ibk-regulations/*.json` → Qdrant
(장문 조문 겹침-윈도우 서브청킹 적용). 사내 임베딩 엔드포인트로 `.env.local` 설정 후 실행.
