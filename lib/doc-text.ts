/**
 * 문서 텍스트 순수 유틸 (I/O·외부의존 없음 → 단위 테스트 용이).
 * 파싱된 마크다운 정규화 + 제목/파일명 처리. 한국 공문서 공통 양식 기준(보편 동작).
 */

// 의안/공고 정형 머리말 라벨(표/콜론 양식 모두) — 한국 의안 공통.
// ⚠️ '시행 연월일'은 의도적으로 제외 — 시행일은 영향분석의 핵심 정보(언제부터 적용)라 보존한다.
export const BOILERPLATE_LABEL =
  /^\s*[|>]?\s*(의안\s*번호|제출\s*연월일|발의\s*연월일|제[출안]자|발의자|접수\s*번호|의결\s*연월일|의결\s*주문|공포\s*번호|공포\s*연월일|법제처\s*심사\s*전|관보\s*게재|소관\s*위원회|소관\s*부처)\s*[:|│].*$/gm;

// 한국 공문서 제목 종결 패턴(보편) — 법령·안 + 정보성(의견서/회신/해석/자료) 포함
export const TITLE_END =
  /(법률안|법안|개정안|제정안|폐지안|일부개정령안|개정령안|고시안|공고안|시행령|시행규칙|시행세칙|세칙|규정|규칙|훈령|예규|조례|기준|기준안|지침|법률|법|령|가이드라인|가이드|모범규준|모범기준|매뉴얼|요령|방안|계획|로드맵|표준약관|약관|동의서|의견서|회신|회신서|해석|해석례|보도자료|설명자료|참고자료|안내|\(\s*안\s*\)|（\s*안\s*）)\s*$/;

/** 공백 정규화 — 연속 공백·개행을 단일 공백으로 접고 양끝 trim. (코드 전반의 반복 idiom 단일화) */
export function normalizeWhitespace(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 파싱 마크다운 정규화 — 본문은 보존하고 정형 노이즈만 제거.
 *  CRLF→LF, 행 끝 공백, 빈 표 행, 페이지 번호("- 1 -"), 의안/공고 머리말, 과다 개행.
 */
export function normalizeMarkdown(md: string): string {
  return (md || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    // 목차 점선 리더(··········, ……, ......) → 단일 말줄임. 매뉴얼 TOC 노이즈 제거.
    .replace(/[ \t]*[.·․‧⋯…]{3,}[ \t]*/g, " … ")
    // 점선 정리 후 빈 표 셀만 남은 TOC 표 행 정돈(예: "| … | | 13 |" → 한 줄로)
    .replace(/^\|(?:\s*(?:…|)\s*\|)+\s*$/gm, "")
    .replace(/^\|(\s*\|)+\s*$/gm, "")
    .replace(/^\s*-?\s*\d{1,3}\s*-\s*$/gm, "")
    .replace(BOILERPLATE_LABEL, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 파일명 정리 — 확장자/날짜코드·번호 접두/선행 [..]/밑줄 */
export function cleanFilename(name: string): string {
  return (name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/^\s*\d{5,}[_\s]+/, "") // 날짜코드 접두("231208_", "180821 ")
    .replace(/^\s*\d+(?:[-.]\d+)*\s*[.)]\s*/, "") // "2-1." "1)"
    .replace(/^\s*[[(][^\])]*[\])]\s*/, "") // 선행 [..] (..)
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 조문/호/번호 항목 시작(본문) — 제목이 아님
const BODY_START = /^(제\s*\d+\s*[조항호목]|\d+\s*[.)]|\(\s*\d+\s*\)|[가-힣]\s*[.)]|[①-⑳])/;

// 편집·형식 스펙(폰트 크기/줄간격/여백 등)은 제목이 아니라 가독성 지침의 본문 항목.
//   예: "◦ 제목 13p, 본문 10p 및 줄간격 130% 이상 : 가독성을 높이기 위한 최소 기준"
const FORMAT_SPEC = /(\d+\s*(p|pt|px|포인트)\b)|줄\s*간격|자\s*간|글자\s*크기|글꼴|폰트|굵기|여백|들여쓰기|정렬\s*기준/i;

/** 본문 상단에서 실제 문서 제목 추출 — 선행 기호/번호 정리, 본문 항목 제외, 후행 주석 제거 후 종결 패턴 검사 */
export function titleFromContent(markdown: string): string {
  const lines = (markdown || "")
    .split("\n")
    .map((l) =>
      l
        .replace(/^#+\s*/, "")
        // 선행 불릿/기호 폭넓게 제거(◦ ● ◌ ‣ ⁃ ◆ ▷ ☐ ✓ → 등 + 대시류 포함)
        .replace(/^[\s>*·▪▫▸▶▷◇◆○◦●◌□■△▲❍‣⁃☐✓→\-–—]+/, "")
        .replace(/[|`]/g, "")
        .trim()
    )
    .filter(Boolean)
    .slice(0, 30);

  for (const raw of lines) {
    const l = raw.replace(/\s*[<〈][^>〉]*[>〉]\s*$/, "").trim();
    if (l.length < 6 || l.length > 70) continue;
    if (BODY_START.test(l)) continue; // 제N조/호/번호 항목은 제목 아님
    if (FORMAT_SPEC.test(l)) continue; // 폰트/줄간격 등 편집 스펙은 제목 아님
    // "라벨 : 설명" 형태(콜론 뒤 부연)는 제목이 아니라 항목 설명 — 콜론 앞만 제목 후보로 축약 시도
    const colon = l.match(/^(.{6,60}?)\s*[:：]\s*\S/);
    const cand = colon ? colon[1].trim() : l;
    if (cand.length < 6 || cand.length > 70) continue;
    if (BODY_START.test(cand) || FORMAT_SPEC.test(cand)) continue;
    if (TITLE_END.test(cand)) return cand;
  }
  return "";
}

/** 제목 우선순위: 본문 제목 패턴 > 메타데이터 제목 > 정리된 파일명 */
export function pickTitle(metaTitle: string | undefined, markdown: string, filename: string): string {
  return titleFromContent(markdown) || (metaTitle && metaTitle.trim()) || cleanFilename(filename);
}
