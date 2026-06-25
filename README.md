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

## 폐쇄망(air-gap) 배포

- **kordoc 내재화됨**: `kordoc/`(소스+`dist/`)가 저장소에 포함되어 `file:kordoc`이
  외부 레지스트리 없이 설치됩니다. (kordoc 빌드 불필요 — 사전 빌드된 `dist/` 포함)
- **나머지 npm 의존성**: 폐쇄망에서는 둘 중 하나가 필요합니다.
  1. 사내 npm 미러(verdaccio 등)로 `npm install`, 또는
  2. 인터넷 환경에서 `npm ci` 후 **`node_modules` 전체를 함께 반입**(동일 OS/CPU),
     또는 `next build` 산출물 + `node_modules`를 묶어 반입.
- 런타임 백엔드(core-ai·Qdrant·OpenSearch·Neo4j·ODS·DGX)는 내부망에서 접속.
- 내규 인덱싱(최초 1회): `node scripts/index-regulations.mjs`
  (`data/ibk-regulations/*.json` → Qdrant. 장문 조문 서브청킹 적용.)
