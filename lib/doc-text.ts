/**
 * 문서 텍스트 순수 유틸 (I/O·외부의존 없음 → 단위 테스트 용이).
 * 파싱된 마크다운 정규화 + 제목/파일명 처리. 한국 공문서 공통 양식 기준(보편 동작).
 */

// 의안/공고 정형 머리말 라벨(표/콜론 양식 모두) — 한국 의안 공통
export const BOILERPLATE_LABEL =
  /^\s*[|>]?\s*(의안\s*번호|제출\s*연월일|발의\s*연월일|제[출안]자|발의자|접수\s*번호|의결\s*연월일|의결\s*주문|공포\s*번호|공포\s*연월일|시행\s*연월일|법제처\s*심사\s*전|관보\s*게재|소관\s*위원회|소관\s*부처)\s*[:|│].*$/gm;

// 한국 공문서 제목 종결 패턴(보편) — 법령·안 + 정보성(의견서/회신/해석/자료) 포함
export const TITLE_END =
  /(법률안|법안|개정안|제정안|폐지안|일부개정령안|개정령안|고시안|공고안|시행령|시행규칙|시행세칙|세칙|규정|규칙|훈령|예규|조례|기준|지침|법률|법|령|의견서|회신|회신서|해석|해석례|보도자료|설명자료|참고자료|안내|\(\s*안\s*\)|（\s*안\s*）)\s*$/;

/**
 * 파싱 마크다운 정규화 — 본문은 보존하고 정형 노이즈만 제거.
 *  CRLF→LF, 행 끝 공백, 빈 표 행, 페이지 번호("- 1 -"), 의안/공고 머리말, 과다 개행.
 */
export function normalizeMarkdown(md: string): string {
  return (md || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
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

/** 본문 상단에서 실제 문서 제목 추출 — 선행 기호/번호 정리, 본문 항목 제외, 후행 주석 제거 후 종결 패턴 검사 */
export function titleFromContent(markdown: string): string {
  const lines = (markdown || "")
    .split("\n")
    .map((l) =>
      l
        .replace(/^#+\s*/, "")
        .replace(/^[\s>*·▪▶◇○□■△❍-]+/, "")
        .replace(/[|`]/g, "")
        .trim()
    )
    .filter(Boolean)
    .slice(0, 30);

  for (const raw of lines) {
    const l = raw.replace(/\s*[<〈][^>〉]*[>〉]\s*$/, "").trim();
    if (l.length < 6 || l.length > 70) continue;
    if (BODY_START.test(l)) continue; // 제N조/호/번호 항목은 제목 아님
    if (TITLE_END.test(l)) return l;
  }
  return "";
}

/** 제목 우선순위: 본문 제목 패턴 > 메타데이터 제목 > 정리된 파일명 */
export function pickTitle(metaTitle: string | undefined, markdown: string, filename: string): string {
  return titleFromContent(markdown) || (metaTitle && metaTitle.trim()) || cleanFilename(filename);
}
