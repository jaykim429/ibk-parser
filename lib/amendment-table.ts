/**
 * 신구조문대비표(현행 | 개정안) 처리 유틸.
 *  - mergeContinuationRows: PDF가 셀 줄바꿈을 별도 '행'으로 쪼개는 현상 보정(복원·추출 공용)
 *  - extractAmendmentPairs: 입력 문서 blocks에서 (현행, 개정안) 쌍 추출 → 정밀 매칭 쿼리에 사용
 */
import type { IRBlock, IRTable, IRCell } from "kordoc";

const RE_HYUN = /현\s*행/;
const RE_GAE = /개\s*정/;

/**
 * 셀 안의 한 줄이 별도 '행'으로 쪼개지는 현상에서 '첫 칸이 비고 다른 칸에 내용이 있는'
 * 연속 행을 직전 행에 병합(헤더 0행 보존). 표를 원형(논리 행)에 가깝게 복구.
 */
export function mergeContinuationRows(table: IRTable): IRTable {
  const { rows, cols, cells } = table;
  if (cols < 2 || rows < 3) return table;
  const out: IRCell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row = cells[r] ?? [];
    const first = (row[0]?.text ?? "").trim();
    const hasOther = row.some((c, i) => i > 0 && (c?.text ?? "").trim());
    if (r > 0 && out.length && !first && hasOther) {
      const prev = out[out.length - 1];
      for (let c = 0; c < cols; c++) {
        const t = (row[c]?.text ?? "").trim();
        if (!t) continue;
        const base = prev[c] ?? { text: "", colSpan: 1, rowSpan: 1 };
        prev[c] = { ...base, text: (base.text ? base.text + "\n" : "") + t };
      }
    } else {
      out.push(row.map((c) => ({ ...(c ?? { text: "", colSpan: 1, rowSpan: 1 }) })));
    }
  }
  return { ...table, rows: out.length, cells: out };
}

export type AmendmentPair = { before: string; after: string };

/**
 * 입력 문서 blocks에서 신구조문대비표(현행|개정안)의 (현행, 개정안) 쌍을 추출.
 * 헤더에 '현행'/'개정' 이 있는 표만 대상. 연속행 병합 후 데이터행마다 한 쌍.
 * 'after'(개정안)는 실제 신·구 변경 조문이라 정밀 매칭 쿼리로 가치가 높다.
 */
export function extractAmendmentPairs(blocks: IRBlock[]): AmendmentPair[] {
  const pairs: AmendmentPair[] = [];
  for (const b of blocks) {
    if (b.type !== "table" || !b.table || b.table.cols < 2) continue;
    const header = (b.table.cells?.[0] ?? []).map((c) => (c?.text ?? "").trim());
    const hyunIdx = header.findIndex((h) => RE_HYUN.test(h));
    const gaeIdx = header.findIndex((h) => RE_GAE.test(h));
    if (hyunIdx < 0 || gaeIdx < 0) continue;
    const t = mergeContinuationRows(b.table);
    for (let r = 1; r < t.rows; r++) {
      const row = t.cells[r] ?? [];
      const before = (row[hyunIdx]?.text ?? "").replace(/\s+/g, " ").trim();
      const after = (row[gaeIdx]?.text ?? "").replace(/\s+/g, " ").trim();
      if (after && after.length >= 8) pairs.push({ before, after });
    }
  }
  return pairs;
}
