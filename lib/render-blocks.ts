/**
 * 충실 복원 렌더러 — kordoc IRBlock[] → HTML.
 *
 * markdown 경유(표 병합 손실)가 아니라 blocks 를 직접 HTML 로 복원한다:
 *  - 헤딩 레벨, 인라인 스타일(굵기/기울임/폰트크기)
 *  - 표: 실제 <table> + colSpan/rowSpan + 컬럼 너비(colWidths) + 셀 테두리(border)
 *  - 이미지: data URI 임베드(폐쇄망 안전, 외부 요청 0)
 *  - 리스트(중첩), 구분선, 하이퍼링크
 *  - PDF bbox(좌표) 는 payload 로 보존(좌표 절대배치 모드는 옵션 — 기본 flow)
 *
 * 매뉴얼형 내규를 화면/다운로드로 원형에 가깝게 복원하는 용도.
 */
import type { IRBlock, IRTable, InlineStyle } from "kordoc";
import { mergeContinuationRows } from "./amendment-table";

export type RenderOptions = {
  /** 문서 제목(헤더) */
  title?: string;
  /** 본문만 반환(전체 HTML 문서 래핑 생략) */
  fragment?: boolean;
};

function esc(s: string | undefined): string {
  return (s ?? "")
    // 목차 점선 리더(··········, ……) → 단일 말줄임(복원 가독성)
    .replace(/[ \t]*[.·․‧⋯…]{3,}[ \t]*/g, " … ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 인라인 스타일 → style 속성 문자열 */
function inlineStyle(s?: InlineStyle): string {
  if (!s) return "";
  const css: string[] = [];
  if (s.bold) css.push("font-weight:700");
  if (s.italic) css.push("font-style:italic");
  // fontSize 는 포맷별 단위가 달라(예: HWPUNIT/pt) 상대 보정 — 과대/과소 방지
  if (typeof s.fontSize === "number" && s.fontSize > 0) {
    const pt = s.fontSize > 50 ? s.fontSize / 100 : s.fontSize; // HWPUNIT(×100) 추정 보정
    if (pt >= 6 && pt <= 48) css.push(`font-size:${pt.toFixed(1)}pt`);
  }
  return css.length ? ` style="${css.join(";")}"` : "";
}

/** HWPUNIT colWidths → 백분율 너비 */
function colWidthPercents(table: IRTable): number[] | null {
  const w = table.colWidths;
  if (!w || !w.length) return null;
  const total = w.reduce((a, b) => a + (b || 0), 0);
  if (total <= 0) return null;
  return w.map((x) => Math.max(1, Math.round(((x || 0) / total) * 1000) / 10));
}

function borderStyle(b?: { top: number; right: number; bottom: number; left: number }): string {
  if (!b) return "";
  const px = (n: number) => (n > 0 ? `${Math.min(3, n)}px solid #444` : "none");
  return ` style="border-top:${px(b.top)};border-right:${px(b.right)};border-bottom:${px(b.bottom)};border-left:${px(b.left)}"`;
}

/** IRTable → <table> (colSpan/rowSpan/너비/테두리 보존, 커버 셀 스킵). 연속행 병합은 amendment-table 공용 유틸. */
function renderTable(input: IRTable): string {
  const table = mergeContinuationRows(input);
  const { rows, cols, cells } = table;
  if (!rows || !cols) return "";
  const pct = colWidthPercents(table);
  const colgroup = pct ? `<colgroup>${pct.map((p) => `<col style="width:${p}%">`).join("")}</colgroup>` : "";

  // 스팬 커버리지 맵 — 병합으로 덮인 위치는 건너뜀
  const occupied = new Set<string>();
  const out: string[] = ["<table>", colgroup];
  for (let r = 0; r < rows; r++) {
    out.push("<tr>");
    for (let c = 0; c < cols; c++) {
      if (occupied.has(`${r},${c}`)) continue;
      const cell = cells[r]?.[c];
      if (!cell) {
        out.push("<td></td>");
        continue;
      }
      const cs = Math.max(1, cell.colSpan || 1);
      const rs = Math.max(1, cell.rowSpan || 1);
      for (let dr = 0; dr < rs; dr++)
        for (let dc = 0; dc < cs; dc++) if (dr || dc) occupied.add(`${r + dr},${c + dc}`);
      const span = `${cs > 1 ? ` colspan="${cs}"` : ""}${rs > 1 ? ` rowspan="${rs}"` : ""}`;
      const tag = r === 0 && table.hasHeader ? "th" : "td";
      const text = esc(cell.text).replace(/\n/g, "<br>");
      out.push(`<${tag}${span}${borderStyle(cell.border)}>${text}</${tag}>`);
    }
    out.push("</tr>");
  }
  out.push("</table>");
  return out.join("");
}

function renderImage(b: IRBlock): string {
  const img = b.imageData;
  if (!img?.data?.length) return "";
  const base64 = Buffer.from(img.data).toString("base64");
  return `<figure><img alt="${esc(img.filename || "image")}" src="data:${img.mimeType};base64,${base64}"></figure>`;
}

function renderList(b: IRBlock): string {
  const tag = b.listType === "ordered" ? "ol" : "ul";
  const items = (b.children ?? []).map((ch) => `<li>${esc(ch.text)}${ch.children?.length ? renderList(ch) : ""}</li>`).join("");
  // children 없이 단일 list 블록인 경우 텍스트를 한 항목으로
  const body = items || (b.text ? `<li>${esc(b.text)}</li>` : "");
  return `<${tag}>${body}</${tag}>`;
}

function renderBlock(b: IRBlock): string {
  switch (b.type) {
    case "heading": {
      const lv = Math.min(6, Math.max(1, b.level ?? 2));
      return `<h${lv}${inlineStyle(b.style)}>${esc(b.text)}</h${lv}>`;
    }
    case "table":
      return b.table ? renderTable(b.table) : "";
    case "image":
      return renderImage(b);
    case "list":
      return renderList(b);
    case "separator":
      return "<hr>";
    case "paragraph":
    default: {
      if (!b.text) return "";
      const inner = b.href ? `<a href="${esc(b.href)}">${esc(b.text)}</a>` : esc(b.text);
      const fn = b.footnoteText ? ` <sup class="fn">${esc(b.footnoteText)}</sup>` : "";
      return `<p${inlineStyle(b.style)}>${inner}${fn}</p>`;
    }
  }
}

const DOC_CSS = `
  body{font-family:'Pretendard','Malgun Gothic',sans-serif;color:#1a1a1a;line-height:1.6;max-width:900px;margin:0 auto;padding:24px}
  h1,h2,h3,h4,h5,h6{margin:1em 0 .4em;line-height:1.3}
  h1{font-size:22px}h2{font-size:18px}h3{font-size:16px}h4{font-size:14px}
  p{margin:.35em 0}
  table{border-collapse:collapse;margin:.8em 0;width:100%;font-size:13px}
  th,td{border:1px solid #888;padding:5px 8px;vertical-align:top;text-align:left}
  th{background:#f1f5f9;font-weight:600}
  figure{margin:.8em 0}img{max-width:100%}
  hr{border:none;border-top:1px solid #ccc;margin:1em 0}
  sup.fn{color:#64748b;font-size:11px}
`;

/** IRBlock[] → HTML(문서 전체 또는 fragment) */
export function renderBlocksToHtml(blocks: IRBlock[], opts: RenderOptions = {}): string {
  const body = (blocks ?? []).map(renderBlock).filter(Boolean).join("\n");
  if (opts.fragment) return body;
  const title = esc(opts.title || "문서 복원");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title><style>${DOC_CSS}</style></head><body>${body}</body></html>`;
}
