/**
 * 규제변동 영향분석 파이프라인 (OOP 오케스트레이션, Node 런타임)
 *
 *  업로드 버퍼 → kordoc 파싱(로컬) → analyze ∥ parse/bill (서버 RO)
 *   → 정규화 쿼리 → 하이브리드 검색(BM25∥벡터→RRF) → 리랭크(LLM) → 적합성·영향도 판정(LLM)
 *   → 보고서 생성(stateless LLM) → 로컬 캐시
 *
 *  서버에는 어떤 쓰기도 하지 않는다(읽기 전용 + stateless 생성).
 *  HTTP 계층(route)과 분리 + 컴포넌트 주입 가능 → compliance.ihopper.co.kr 등에서 재사용.
 */
import { parseDocument } from "./parse-document";
import { normalizeWhitespace } from "./doc-text";
import {
  analyzeDocument,
  parseBill,
  assessRelevance,
  detectItemType,
  detectDocNature,
  buildCanonicalQuery,
  buildSubQueries,
  extractObligations,
  buildObligationQueries,
  cleanLawName,
  extractEffectiveDate,
  type Analysis,
  type ObligationExtract,
  type Candidate,
} from "./server";
import { HybridRetriever } from "./retrieval";
import { rerankCandidates } from "./rerank";
import { judgeMatches, assessCoverage, type CoverageItem } from "./judge";
import { generateReport, buildOffDomainReport } from "./report";
import { renderBlocksToHtml } from "./render-blocks";
import { extractAmendmentPairs } from "./amendment-table";
import { formatRegulationItemName } from "./regulation-format";
import { hashBuffer, getCached, setCached } from "./cache";
import { config } from "./config";

export type Stat = { num: string | number; label: string };
export type PipelineResult = {
  success: boolean;
  error?: string;
  report?: { markdown: string; title?: string };
  /** 입력 문서 충실 복원 HTML(blocks→HTML) — UI 본문 옆 원문 대조용 */
  restoredHtml?: string;
  stats?: Stat[];
  meta?: Record<string, unknown>;
};

export type PipelineInput = { buffer: Buffer; fileName: string };

export class CompliancePipeline {
  constructor(private readonly retriever: HybridRetriever = new HybridRetriever()) {}

  async run({ buffer, fileName }: PipelineInput): Promise<PipelineResult> {
    const t0 = Date.now();

    // 캐시 (같은 파일 재업로드 시 즉시 반환)
    // 키에 주요 튜닝값 시그니처를 포함 → config 변경 시 자동 무효화(버전 깜빡 방지).
    const fileHash = hashBuffer(buffer);
    const cfgSig = [
      config.subQueryMax,
      config.canonicalTermMax,
      config.matchTopK,
      config.vectorTopK,
      config.bm25TopK,
      config.rrfK,
      config.maxAnalyzeChars,
      config.llmTemperature,
      config.llmRetryTemperature,
      config.pdfParser, // 파서별 캐시키 분리 — kordoc↔docling 토글/롤백 시 A/B 교차오염 차단(설계 §8-1)
    ].join("-");
    const key = `report-${config.cacheVersion}-${cfgSig}:${fileHash}`;
    const cached = getCached<PipelineResult>(key);
    if (cached) return { ...cached, meta: { ...(cached.meta ?? {}), cached: true } };

    const warnings: string[] = [];

    // 1) 파싱 (kordoc, 로컬)
    const doc = await parseDocument(buffer, fileName);
    warnings.push(...doc.warnings);
    if (doc.markdown.length > config.maxAnalyzeChars) {
      // analyze 단계는 head+tail 표본화(앞 70%+뒤 30%)로 분석한다. 단 변경점 추출(P1 신구조문대비표)은
      // 전체 blocks에서 별도 수행되므로 후반 변경 조문도 매칭에는 반영됨.
      const msg = `본문 ${doc.markdown.length}자 → 분석은 ${config.maxAnalyzeChars}자 표본(앞 70%+뒤 30%, 중간 ${doc.markdown.length - config.maxAnalyzeChars}자 요약 생략). 변경점·복원은 전체 본문 사용`;
      warnings.push(msg);
      console.warn(`[PIPELINE] 절단 경고: ${fileName} — ${msg}`);
    }
    // 표시·검색용 문서명 정제(앞 일련번호/[공고·별첨] 표기/사본(n)/확장자 제거) — 파싱 아티팩트 차단
    const initialName = cleanLawName(doc.title || fileName.replace(/\.[^.]+$/, ""));
    const itemType = detectItemType(fileName, doc.markdown);
    const infoOnly = detectDocNature(fileName, doc.markdown) === "정보성";

    // 입력 문서 충실 복원(blocks→HTML) — UI에서 보고서와 원문 대조용
    const restoredHtml = doc.blocks?.length
      ? renderBlocksToHtml(doc.blocks, { title: initialName })
      : undefined;

    // 본문 추출 실패/불충분 가드 — 빈 본문으로 분석을 진행하면 프로필 보일러플레이트로 채워진
    // 가짜 매칭이 나온다. 추출 본문이 임계 미만이면 분석 중단(스캔/형식 문제 안내).
    const bodyChars = doc.markdown.replace(/\s+/g, "").length;
    if (bodyChars < config.minBodyChars) {
      console.warn(`[PIPELINE] 본문 추출 불충분: ${fileName} — ${bodyChars}자 < ${config.minBodyChars}`);
      const seconds = Math.round((Date.now() - t0) / 1000);
      const lowResult: PipelineResult = {
        success: true,
        report: {
          markdown: `# 규제변동 영향분석 보고서\n\n**분석 정보**\n\n- **문서명**: ${initialName}\n- **판정**: 본문 추출 불가\n\n> ⚠️ 문서에서 분석 가능한 본문을 충분히 추출하지 못했습니다(추출 ${bodyChars}자). 스캔/이미지 PDF이거나 형식 문제일 수 있습니다. 텍스트 추출 가능한 문서로 재시도하거나 OCR 설정을 확인해 주세요.`,
          title: initialName,
        },
        restoredHtml,
        stats: [
          { num: 0, label: "영향 내규" },
          { num: "추출 불가", label: "판정" },
          { num: `${seconds}초`, label: "처리 시간" },
        ],
        meta: { fileType: doc.fileType, lowContent: true, bodyChars, warnings },
      };
      setCached(key, lowResult);
      return lowResult;
    }

    // 2) 관련성 게이트 ∥ analyze ∥ parse/bill ∥ 의무추출 (서버 읽기 전용, 병렬 — 추가 지연 최소)
    const [relRes, analyzeRes, parseRes, oblRes] = await Promise.allSettled([
      config.relevanceGateEnabled
        ? assessRelevance({ title: initialName, documentText: doc.markdown })
        : Promise.resolve({ relevant: true, domain: "", reason: "게이트 비활성" }),
      analyzeDocument({ lawName: initialName, documentText: doc.markdown, itemType }),
      parseBill({
        billId: `TEST-${fileHash}`,
        billName: initialName,
        billText: doc.markdown,
        isPolicy: itemType === "policy",
      }),
      // 의무·권고 추출(린치핀): 의무별 멀티쿼리 + 커버리지 갭 산출의 입력
      extractObligations({ lawName: initialName, documentText: doc.markdown, itemType }),
    ]);

    // 무관 문서면 매칭을 생략하고 '분석 대상 아님' 보고서로 단락(오탐 방지)
    const rel = relRes.status === "fulfilled" ? relRes.value : { relevant: true, domain: "", reason: "" };
    if (config.relevanceGateEnabled && !rel.relevant) {
      console.log(`[PIPELINE] 도메인 게이트 차단: ${fileName} — ${rel.reason}`);
      const offReport = buildOffDomainReport(initialName, rel.reason);
      const seconds = Math.round((Date.now() - t0) / 1000);
      const offResult: PipelineResult = {
        success: true,
        report: { markdown: offReport, title: initialName },
        restoredHtml,
        stats: [
          { num: 0, label: "영향 내규" },
          { num: "대상 아님", label: "판정" },
          { num: `${seconds}초`, label: "처리 시간" },
        ],
        meta: {
          fileType: doc.fileType,
          offDomain: true,
          relevanceReason: rel.reason,
          relevanceDomain: rel.domain,
          warnings,
        },
      };
      setCached(key, offResult);
      return offResult;
    }

    const analysis: Analysis | undefined =
      analyzeRes.status === "fulfilled" ? analyzeRes.value : undefined;
    const provisions = parseRes.status === "fulfilled" ? parseRes.value.provisions ?? [] : [];
    const obl: ObligationExtract =
      oblRes.status === "fulfilled" ? oblRes.value : { documentTitle: "", requiresFramework: false, obligations: [] };
    // 소관 법령/제목: LLM이 본문 의미로 뽑은 정식 제목 우선(편집스펙·불릿·공고번호 오인 방지) →
    //  analyze 법령명 → 휴리스틱 제목 순. (보편적·에이전틱 — 정규식 휴리스틱 의존 최소화)
    const lawName = cleanLawName(obl.documentTitle || analysis?.law_name || initialName);

    // 3) 입력 문서 청킹 → 멀티쿼리 하이브리드 검색(변경 단위별 + 의무별 쿼리 융합)
    const query = buildCanonicalQuery(analysis, provisions, doc.markdown, {
      obligations: obl.obligations,
      title: lawName,
    });
    const subQueries = buildSubQueries(analysis, provisions);
    // 의무 기반 멀티쿼리 — 가이드라인처럼 '개정 조문'이 없는 문서도 요건별로 내규를 정밀 검색
    const oblQueries = buildObligationQueries(obl.obligations, lawName);
    // P1: 신구조문대비표(현행|개정안)에서 '개정안' 조문을 정밀 매칭 쿼리로 추가
    const amendPairs = extractAmendmentPairs(doc.blocks);
    const amendQueries = amendPairs
      .filter((p) => p.after.length >= 8)
      .slice(0, config.subQueryMax)
      .map((p) => `${lawName} ${p.after}`.replace(/\s+/g, " ").slice(0, config.subQueryLen));
    const queries = [query, ...subQueries, ...oblQueries, ...amendQueries];
    console.log(`\n[PIPELINE] file=${fileName}`);
    console.log(
      `[PIPELINE] itemType=${itemType}, infoOnly=${infoOnly}, lawName=${lawName}, provisions=${provisions.length}, analysisOk=${!!analysis?.success}, subQueries=${subQueries.length}, obligations=${obl.obligations.length}(framework=${obl.requiresFramework}), oblQueries=${oblQueries.length}, amendPairs=${amendPairs.length}`
    );
    console.log(`[PIPELINE] canonicalQuery= ${query.slice(0, 300)}`);

    // 근거법령 앵커(M1): 입력 법령명을 넘겨 '근거법령이 일치하는 내규'를 직접 가점/주입
    const candidates = await this.retriever.retrieveMany(queries, lawName);
    const srcMix = candidates.reduce(
      (acc, c) => ((acc[String(c.match_source)] = (acc[String(c.match_source)] ?? 0) + 1), acc),
      {} as Record<string, number>
    );
    console.log(`[PIPELINE] hybrid candidates=${candidates.length} (RRF; sources=${JSON.stringify(srcMix)})`);

    // 3.5) 리랭킹 (LLM 크로스인코더)
    const reranked = await rerankCandidates({ lawName, itemType, analysis, candidates });
    reranked.slice(0, 8).forEach((c) =>
      console.log(
        `   - [${c.match_source}] ${c.regulation_name} ${formatRegulationItemName(c)} rerank=${c.rerank_score ?? "-"} rrf=${c.final_score?.toFixed?.(4)}`
      )
    );

    // 4) LLM 적합성·영향도 판정 (의무·권고도 함께 전달 — analyze 요약이 일부 단락에 고착해도 보정)
    const judged = await judgeMatches({ lawName, itemType, analysis, candidates: reranked, infoOnly, obligations: obl.obligations });
    const relevant = judged.filter((j) => j.verdict.relevance === "적합");
    // 진단(재현성 국소화): 같은 문서 재분석 시 매칭 수가 흔들리면, 변동이 '판정된 후보집합'(상류 쿼리·검색·rerank
    //  변동)에서 오는지 'judge 판정 flip'에서 오는지 구분해야 한다. 정렬 키셋 로그로 run 간 diff가 가능 → 추측 대신 국소화.
    const keyOf = (c: Candidate) => `${c.regulation_name} ${formatRegulationItemName(c)}`;
    console.log(`[PIPELINE] 판정후보(${judged.length})= ${judged.map(keyOf).sort().join(" | ")}`);
    console.log(`[PIPELINE] 적합(${relevant.length})= ${relevant.map(keyOf).sort().join(" | ") || "(없음)"}`);

    // 4.5) 요건 커버리지(권고2) — 의무별 충족/부분/부재 + 대응 내규 산출(요건 체크리스트)
    //   ★ 과대신호 방지: 커버리지 갭(부재=높음)은 '새 규범영역을 신설'하는 문서에서만 의미.
    //     일부개정(개정안/개정령/개정고시)은 기존 내규가 이미 매핑돼 1:1 판정으로 충분하므로 제외.
    //     가이드라인(자율규제) 또는 제정(신규)일 때만 대상. (특정 파일 하드코딩 아님 — 개정 vs 제정/가이드라인)
    const isAmendment = /(일부개정|개정안|개정법률안|개정령안?|개정고시|일부개정규정|타법개정)/.test(`${initialName} ${lawName}`);
    const frameworkEligible = obl.requiresFramework && (itemType === "guideline" || !isAmendment);
    let coverage: CoverageItem[] = [];
    if (frameworkEligible && obl.obligations.length > 0 && !infoOnly) {
      // 의무별 타깃 검색(병렬): 각 의무 텍스트로 직접 retrieve → 그 의무 전용 후보로 충족도 판정.
      //  (전역 융합 풀만 보면 보유 내규가 풀 밖일 때 'false 부재'가 남 → 의무별 검색으로 제거)
      const perObligation = await Promise.all(
        obl.obligations.map(async (o) => {
          const q = normalizeWhitespace(`${lawName} ${o.title} ${o.summary}`).slice(0, config.subQueryLen);
          let cands: Candidate[] = [];
          try {
            cands = await this.retriever.retrieve(q, lawName);
          } catch {
            /* 의무별 검색 실패 → 빈 후보(보수적으로 부재 처리) */
          }
          return { obligation: o, candidates: cands };
        })
      );
      coverage = await assessCoverage({ lawName, perObligation, globalRelevant: relevant, infoOnly });
    }
    const absentGaps = coverage.filter((g) => g.coverage === "부재");
    const partialGaps = coverage.filter((g) => g.coverage === "부분");
    if (coverage.length) {
      console.log(
        `[PIPELINE] 커버리지=${coverage.length} (충족 ${coverage.filter((g) => g.coverage === "충족").length}·부분 ${partialGaps.length}·부재 ${absentGaps.length}·해당없음 ${coverage.filter((g) => g.coverage === "해당없음").length})`
      );
    }

    // 5) 보고서 생성 (stateless LLM)
    const markdown = await generateReport({
      lawName,
      itemType,
      analysis,
      judged,
      fileName,
      candidateCount: judged.length,
      infoOnly,
      coverage,
      obligations: obl.obligations,
      amendmentPairs: amendPairs.map((p) => ({ before: p.before, after: p.after })),
      truncated: doc.markdown.length > config.maxAnalyzeChars,
      // 시행일/유예기간 — 명시된 경우만(로컬 결정적 추출). 백테스팅이라 시급성 점수화 없이 사실만 표기.
      ...extractEffectiveDate(doc.markdown),
      // 사전예고/예고(확정 전) → 미확정 프레이밍. (cleanLawName이 '(사전예고)'를 떼므로 파일명도 함께 검사)
      //  ⚠️ '예고\b'는 한글 뒤 단어경계가 성립 안 해 무용 → '사전예고/예고문/예고안' 명시 매칭으로 교체.
      //     입법예고·규정변경예고는 isPendingDoc(미발효 입법)에서 조건부로 처리하므로 여기 미포함.
      preAnnouncement: /사전\s*예고|예고\s*문|예고\s*안/.test(`${fileName} ${initialName} ${lawName}`),
    });

    const seconds = Math.round((Date.now() - t0) / 1000);
    const countBy = (lv: string) => relevant.filter((j) => j.verdict.impact === lv).length;
    // 헤드라인 영향도: 조문 매칭 + 커버리지 갭(부재=높음, 부분=중간) 합산 — 과소커버리지 방지.
    //  '영향 내규'(기존 조문 매칭)와 '신규 필요'(부재 갭)는 별도 박스로 구분(혼동 방지).
    const highTotal = countBy("높음") + absentGaps.length;
    const midTotal = countBy("중간") + partialGaps.length;
    const stats: Stat[] = [
      { num: relevant.length, label: "영향 내규" },
      ...(absentGaps.length ? [{ num: absentGaps.length, label: "신규 필요" } as Stat] : []),
      { num: highTotal, label: "영향도 높음" },
      { num: midTotal, label: "영향도 중간" },
      { num: countBy("낮음"), label: "영향도 낮음" },
      { num: judged.length, label: "검토 후보" },
      { num: `${seconds}초`, label: "처리 시간" },
    ];

    const result: PipelineResult = {
      success: true,
      report: { markdown, title: lawName },
      restoredHtml,
      stats,
      meta: {
        fileType: doc.fileType,
        usedOcr: doc.usedOcr,
        lowQuality: doc.lowQuality,
        warnings,
        itemType,
        infoOnly,
        lawDomain: analysis?.law_domain ?? null,
        candidateCount: candidates.length,
        relevantCount: relevant.length,
        requiresFramework: obl.requiresFramework,
        obligationCount: obl.obligations.length,
        coverage,
        judged: judged.map((j) => ({
          regulation_name: j.regulation_name,
          jo: j.jo,
          jo_title: j.jo_title,
          ...j.verdict,
        })),
      },
    };

    setCached(key, result);
    return result;
  }
}

/** 함수형 진입점(호환) — route에서 사용 */
export function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  // 전체 데드라인: 개별 호출 상한(pipelineTimeoutMs)과 별개로 파이프라인 총시간을 제한해
  //  HTTP 무한 대기·좀비 요청을 차단(초과 시 명확한 실패 응답). 내부 작업은 각 단계 자체 타임아웃으로 종료됨.
  const deadline = new Promise<PipelineResult>((resolve) =>
    setTimeout(
      () => resolve({ success: false, error: "처리 시간 초과 — 문서가 너무 크거나 복잡합니다. 분할 후 다시 시도해 주세요." }),
      config.pipelineTotalTimeoutMs
    )
  );
  return Promise.race([new CompliancePipeline().run(input), deadline]);
}
