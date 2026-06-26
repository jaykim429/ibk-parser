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
import {
  analyzeDocument,
  parseBill,
  assessRelevance,
  detectItemType,
  detectDocNature,
  buildCanonicalQuery,
  buildSubQueries,
  type Analysis,
} from "./server";
import { HybridRetriever } from "./retrieval";
import { rerankCandidates } from "./rerank";
import { judgeMatches } from "./judge";
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
    ].join("-");
    const key = `report-${config.cacheVersion}-${cfgSig}:${fileHash}`;
    const cached = getCached<PipelineResult>(key);
    if (cached) return { ...cached, meta: { ...(cached.meta ?? {}), cached: true } };

    const warnings: string[] = [];

    // 1) 파싱 (kordoc, 로컬)
    const doc = await parseDocument(buffer, fileName);
    warnings.push(...doc.warnings);
    if (doc.markdown.length > config.maxAnalyzeChars) {
      const msg = `본문 ${doc.markdown.length}자 중 ${config.maxAnalyzeChars}자까지만 분석(이후 ${doc.markdown.length - config.maxAnalyzeChars}자 절단)`;
      warnings.push(msg);
      console.warn(`[PIPELINE] 절단 경고: ${fileName} — ${msg}`);
    }
    const initialName = doc.title || fileName.replace(/\.[^.]+$/, "");
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

    // 2) 관련성 게이트 ∥ analyze ∥ parse/bill (서버 읽기 전용, 병렬 — 게이트가 추가 지연 안 줌)
    const [relRes, analyzeRes, parseRes] = await Promise.allSettled([
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
    const lawName = analysis?.law_name || initialName;

    // 3) 입력 문서 청킹 → 멀티쿼리 하이브리드 검색(변경 단위별 쿼리 융합)
    const query = buildCanonicalQuery(analysis, provisions, doc.markdown);
    const subQueries = buildSubQueries(analysis, provisions);
    // P1: 신구조문대비표(현행|개정안)에서 '개정안' 조문을 정밀 매칭 쿼리로 추가
    const amendPairs = extractAmendmentPairs(doc.blocks);
    const amendQueries = amendPairs
      .filter((p) => p.after.length >= 8)
      .slice(0, config.subQueryMax)
      .map((p) => `${lawName} ${p.after}`.replace(/\s+/g, " ").slice(0, 280));
    const queries = [query, ...subQueries, ...amendQueries];
    console.log(`\n[PIPELINE] file=${fileName}`);
    console.log(
      `[PIPELINE] itemType=${itemType}, infoOnly=${infoOnly}, lawName=${lawName}, provisions=${provisions.length}, analysisOk=${!!analysis?.success}, subQueries=${subQueries.length}, amendPairs=${amendPairs.length}`
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

    // 4) LLM 적합성·영향도 판정
    const judged = await judgeMatches({ lawName, itemType, analysis, candidates: reranked, infoOnly });
    const relevant = judged.filter((j) => j.verdict.relevance === "적합");

    // 5) 보고서 생성 (stateless LLM)
    const markdown = await generateReport({
      lawName,
      itemType,
      analysis,
      judged,
      fileName,
      candidateCount: judged.length,
      infoOnly,
    });

    const seconds = Math.round((Date.now() - t0) / 1000);
    const countBy = (lv: string) => relevant.filter((j) => j.verdict.impact === lv).length;
    const stats: Stat[] = [
      { num: relevant.length, label: "영향 내규" },
      { num: countBy("높음"), label: "영향도 높음" },
      { num: countBy("중간"), label: "영향도 중간" },
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
  return new CompliancePipeline().run(input);
}
