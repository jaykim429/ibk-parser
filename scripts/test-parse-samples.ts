/**
 * 샘플 파싱 골든 하네스 — parseDocument로 전 포맷 파싱 + 다운스트림 파생값 베이스라인 캡처.
 *
 * 목적(Docling 사이드카 통합 0단계): 현 kordoc 출력의 '골든 베이스라인'을 스냅샷으로 남겨,
 *   이후 단계(사이드카)가 동일 입력에 대해 회귀 없이 같은 파생값을 내는지 diff로 검증한다.
 *
 * 캡처 메트릭(다운스트림 계약 직결):
 *   - markdown len / fileType / usedOcr / title
 *   - blocks 수 + 유형별 분포 + 표 정합(cells rows×cols ragged 여부)
 *   - amendPairs 수(신구조문대비표 — 개정 정밀매칭 핵심, 사이드카 회귀 1순위 감시)
 *   - dataURI 수(renderBlocksToHtml 이미지 복원)
 *   - markdown 파생값: effectiveDate/gracePeriod, itemType, docNature, bodyChars
 *   - 파싱 지연(ms) — Docling 도입 후 p50/p95 비교 기준
 *
 * 실행:  npx tsx scripts/test-parse-samples.ts
 * 산출:  scratchpad 경로의 golden-baseline.json (로컬 — 샘플이 gitignore라 스냅샷도 비커밋)
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "../lib/parse-document";
import { extractAmendmentPairs } from "../lib/amendment-table";
import { renderBlocksToHtml } from "../lib/render-blocks";
import { extractEffectiveDate, detectItemType, detectDocNature } from "../lib/server";

const DIR = "샘플 파일";
const OUT = process.env.GOLDEN_OUT || path.join("scratchpad", "golden-baseline.json");
const timeoutMs = Number(process.env.GOLDEN_TIMEOUT_MS ?? 90000);

type Metric = {
  file: string;
  ok: boolean;
  error?: string;
  ms?: number;
  fileType?: string;
  usedOcr?: boolean;
  title?: string;
  mdLen?: number;
  bodyChars?: number;
  blocks?: number;
  byType?: Record<string, number>;
  raggedTables?: number; // cells 행 길이가 cols와 불일치한 표 수(0이어야 정상 — 사이드카 정합 감시)
  amendPairs?: number;
  dataUris?: number;
  effectiveDate?: string;
  gracePeriod?: string;
  itemType?: string;
  docNature?: string;
};

function tableIntegrity(blocks: { type: string; table?: { rows?: number; cols?: number; cells?: unknown[][] } }[]): number {
  let ragged = 0;
  for (const b of blocks) {
    if (b.type !== "table" || !b.table?.cells) continue;
    const cols = b.table.cols ?? Math.max(0, ...b.table.cells.map((r) => (Array.isArray(r) ? r.length : 0)));
    if (b.table.cells.some((r) => Array.isArray(r) && r.length !== cols)) ragged++;
  }
  return ragged;
}

async function main() {
  const files = readdirSync(DIR).filter((f) => /\.(pdf|hwp|hwpx|docx|xlsx|txt)$/i.test(f)).sort();
  const metrics: Metric[] = [];
  let ok = 0;
  let err = 0;

  for (const f of files) {
    const buf = readFileSync(path.join(DIR, f));
    const t0 = Date.now();
    try {
      const doc = (await Promise.race([
        parseDocument(buf, f),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
      ])) as Awaited<ReturnType<typeof parseDocument>>;
      const ms = Date.now() - t0;
      const blocks = doc.blocks ?? [];
      const byType: Record<string, number> = {};
      for (const b of blocks) byType[b.type] = (byType[b.type] ?? 0) + 1;
      const html = blocks.length ? renderBlocksToHtml(blocks, { title: doc.title }) : "";
      const eff = extractEffectiveDate(doc.markdown);
      const m: Metric = {
        file: f,
        ok: true,
        ms,
        fileType: doc.fileType,
        usedOcr: doc.usedOcr,
        title: doc.title,
        mdLen: doc.markdown.length,
        bodyChars: doc.markdown.replace(/\s+/g, "").length,
        blocks: blocks.length,
        byType,
        raggedTables: tableIntegrity(blocks),
        amendPairs: extractAmendmentPairs(blocks).length,
        dataUris: (html.match(/data:/g) ?? []).length,
        effectiveDate: eff.effectiveDate,
        gracePeriod: eff.gracePeriod,
        itemType: detectItemType(f, doc.markdown),
        docNature: detectDocNature(f, doc.markdown),
      };
      metrics.push(m);
      console.log(
        `OK  ${(ms / 1000).toFixed(1)}s [${m.fileType}] blocks=${m.blocks} amendPairs=${m.amendPairs} dataUri=${m.dataUris} ragged=${m.raggedTables} ocr=${m.usedOcr}\n    ${f}`
      );
      ok++;
    } catch (e) {
      metrics.push({ file: f, ok: false, error: (e as Error).message, ms: Date.now() - t0 });
      console.log(`ERR ${f}\n    → ${(e as Error).message}`);
      err++;
    }
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ capturedFiles: files.length, metrics }, null, 2), "utf-8");
  console.log(`\n베이스라인: ${ok} OK / ${err} ERR (총 ${files.length}) → ${OUT}`);
  console.log(`(이후 사이드카 단계: 같은 입력으로 amendPairs·dataUri·raggedTables·파생값 diff → 회귀 0 확인)`);
}

main();
