import type { Candidate } from "./server";
import { normalizeWhitespace } from "./doc-text";

export function inferRegulationKind(c: Candidate): string {
  const raw = `${c.type ?? ""} ${c.regulation_name ?? ""} ${c.jo_title ?? ""}`.trim();
  if (/별지서식/.test(raw)) return "별지서식";
  if (/별표/.test(raw)) return "별표";
  if (/부칙/.test(raw)) return "부칙";
  if (c.hang) return "항";
  return "조";
}

export function formatRegulationItemName(c: Candidate): string {
  const kind = inferRegulationKind(c);

  if (kind === "별표" || kind === "별지서식") {
    const label = formatAttachmentLabel(c, kind);
    const title = extractAttachmentTitle(c.regulation_content);
    return title ? `${label}(${title})` : label;
  }

  if (kind === "부칙") {
    return /부칙/.test(c.regulation_name) ? c.regulation_name : "부칙";
  }

  // 조 라벨 정규화 — c.jo가 이미 '조'를 포함('5조의3')하면 중복('제5조의3조') 방지, '5의3'은 '제5조의3'으로.
  const joStr = String(c.jo ?? "").trim();
  const article = !joStr
    ? extractArticleLabel(c.regulation_name)
    : /조/.test(joStr)
      ? `제${joStr}`
      : /^\d+의\d+/.test(joStr)
        ? `제${joStr.replace("의", "조의")}`
        : `제${joStr}조`;
  const title = cleanJoTitle(c.jo_title);
  const hang = c.hang ? ` 제${c.hang}항` : "";
  const name = `${article ?? ""}${title ? `(${title})` : ""}${hang}`.trim();
  return name || c.regulation_name || "-";
}

export function makeContentExcerpt(content: string | undefined, max = 260): string {
  const s = normalizeWhitespace(content);
  if (!s) return "-";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatAttachmentLabel(c: Candidate, kind: string): string {
  const parts = [c.byeolpyo, c.jo_title, c.regulation_name]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);
  const raw =
    parts.find((v) => v.includes(kind)) ??
    parts.find((v) => /\d+/.test(v)) ??
    String(c.jo ?? "").trim();
  const num = raw?.match(/\d+/)?.[0];
  return num ? `${kind} ${num}` : raw || kind;
}

function extractAttachmentTitle(content: string | undefined): string {
  const s = normalizeWhitespace(content);
  if (!s) return "";
  let title = s
    .replace(/^별표\s*\d*\s*/i, "")
    .replace(/^별지서식\s*\d*\s*/i, "")
    // 제목 경계 토큰에서 절취 — 개정마커(<신설|<제정|<개정)·본문 시작 토큰(☞·■·상품명:)을 누락하면
    //  제목 뒤 본문이 줄줄이 붙어 비대화(별표/별지서식 셀 가독성 저하). 이 경계들을 모두 끊는다.
    .split(/<개정|<신설|<제정|구분\s+내용|<표>|첨부|주\)|☞|■|상품명\s*[:：]/)[0]
    .trim();
  // 추출 본문이 제목을 즉시 반복(예: '면책신청서 면책신청서')하면 1회만 — HWP 양식 추출 아티팩트.
  title = title.replace(/^(.{2,40}?)\s+\1(?=\s|$)/, "$1").trim();
  // 본문이 섞여 비정상적으로 길면(경계 절취 실패) 제목 부착을 포기 — 호출부가 깨끗한 라벨('별표 3')만 사용.
  if (!title || title.length > 40) return "";
  return title;
}

function extractArticleLabel(name: string | undefined): string | undefined {
  return name?.match(/제\s*\d+\s*조/)?.[0].replace(/\s+/g, "");
}

function cleanJoTitle(title: string | undefined): string {
  const s = (title ?? "").trim();
  if (!s || /^별표\s*\d*$/.test(s) || /^별지서식\s*\d*$/.test(s)) return "";
  return s.replace(/^\(|\)$/g, "");
}
