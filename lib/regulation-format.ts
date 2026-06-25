import type { Candidate } from "./server";

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

  const article = c.jo ? `제${c.jo}조` : extractArticleLabel(c.regulation_name);
  const title = cleanJoTitle(c.jo_title);
  const hang = c.hang ? ` 제${c.hang}항` : "";
  const name = `${article ?? ""}${title ? `(${title})` : ""}${hang}`.trim();
  return name || c.regulation_name || "-";
}

export function makeContentExcerpt(content: string | undefined, max = 260): string {
  const s = (content ?? "").replace(/\s+/g, " ").trim();
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
  const s = (content ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const title = s
    .replace(/^별표\s*\d*\s*/i, "")
    .replace(/^별지서식\s*\d*\s*/i, "")
    .split(/<개정|구분\s+내용|<표>|첨부|주\)/)[0]
    .trim();
  return title.length > 70 ? `${title.slice(0, 69)}…` : title;
}

function extractArticleLabel(name: string | undefined): string | undefined {
  return name?.match(/제\s*\d+\s*조/)?.[0].replace(/\s+/g, "");
}

function cleanJoTitle(title: string | undefined): string {
  const s = (title ?? "").trim();
  if (!s || /^별표\s*\d*$/.test(s) || /^별지서식\s*\d*$/.test(s)) return "";
  return s.replace(/^\(|\)$/g, "");
}
