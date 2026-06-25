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
  detectItemType,
  detectDocNature,
  buildCanonicalQuery,
  buildSubQueries,
  type Analysis,
} from "./server";
import { HybridRetriever } from "./retrieval";
import { rerankCandidates } from "./rerank";
import { judgeMatches } from "./judge";
import { generateReport } from "./report";
import { formatRegulationItemName } from "./regulation-format";
import { hashBuffer, getCached, setCached } from "./cache";
import { config } from "./config";

export type Stat = { num: string | number; label: string };
export type PipelineResult = {
  success: boolean;
  error?: string;
  report?: { markdown: string; title?: string };
  stats?: Stat[];
  meta?: Record<string, unknown>;
};

export type PipelineInput = { buffer: Buffer; fileName: string };

export class CompliancePipeline {
  constructor(private readonly retriever: HybridRetriever = new HybridRetriever()) {}

  async run({ buffer, fileName }: PipelineInput): Promise<PipelineResult> {
    const t0 = Date.now();

    // 캐시 (같은 파일 재업로드 시 즉시 반환)
    const fileHash = hashBuffer(buffer);
    const key = `report-${config.cacheVersion}:${fileHash}`;
    const cached = getCached<PipelineResult>(key);
    if (cached) return { ...cached, meta: { ...(cached.meta ?? {}), cached: true } };

    // 1) 파싱 (kordoc, 로컬)
    const doc = await parseDocument(buffer, fileName);
    const initialName = doc.title || fileName.replace(/\.[^.]+$/, "");
    const itemType = detectItemType(fileName, doc.markdown);
    const infoOnly = detectDocNature(fileName, doc.markdown) === "정보성";

    // 2) analyze ∥ parse/bill (서버 읽기 전용, 병렬)
    const [analyzeRes, parseRes] = await Promise.allSettled([
      analyzeDocument({ lawName: initialName, documentText: doc.markdown, itemType }),
      parseBill({
        billId: `TEST-${fileHash}`,
        billName: initialName,
        billText: doc.markdown,
        isPolicy: itemType === "policy",
      }),
    ]);
    const analysis: Analysis | undefined =
      analyzeRes.status === "fulfilled" ? analyzeRes.value : undefined;
    const provisions = parseRes.status === "fulfilled" ? parseRes.value.provisions ?? [] : [];
    const lawName = analysis?.law_name || initialName;

    // 3) 입력 문서 청킹 → 멀티쿼리 하이브리드 검색(변경 단위별 쿼리 융합)
    const query = buildCanonicalQuery(analysis, provisions, doc.markdown);
    const subQueries = buildSubQueries(analysis, provisions);
    const queries = [query, ...subQueries];
    console.log(`\n[PIPELINE] file=${fileName}`);
    console.log(
      `[PIPELINE] itemType=${itemType}, infoOnly=${infoOnly}, lawName=${lawName}, provisions=${provisions.length}, analysisOk=${!!analysis?.success}, subQueries=${subQueries.length}`
    );
    console.log(`[PIPELINE] canonicalQuery= ${query.slice(0, 300)}`);

    const candidates = await this.retriever.retrieveMany(queries);
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
      stats,
      meta: {
        fileType: doc.fileType,
        usedOcr: doc.usedOcr,
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
