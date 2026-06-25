/**
 * 파서 순수 유틸 단위 테스트 — 실제 lib/doc-text.ts 함수를 import해 다케이스 검증.
 * 실행:  npx tsx scripts/test-doc-text.ts
 */
import {
  normalizeMarkdown,
  cleanFilename,
  titleFromContent,
  pickTitle,
} from "../lib/doc-text";
import { detectDocNature, detectItemType, buildSubQueries } from "../lib/server";
import { baseLawName } from "../lib/retrieval";

let pass = 0;
let fail = 0;
function eq(name: string, got: string, want: string) {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      got : ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
}
function truthy(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? pass++ : fail++;
}

console.log("── titleFromContent ──");
eq("법률안", titleFromContent("공중 등 협박목적 자금조달행위의 금지에 관한 법률 일부개정법률안\n발의"),
  "공중 등 협박목적 자금조달행위의 금지에 관한 법률 일부개정법률안");
eq("개정령(안)", titleFromContent("◇ 부정청탁 및 금품등 수수의 금지에 관한 법률 시행령 일부개정령(안)\n제안이유"),
  "부정청탁 및 금품등 수수의 금지에 관한 법률 시행령 일부개정령(안)");
eq("고시안+후행주석", titleFromContent("□ 금융감독원의 경영공시에 관한 기준 일부개정고시안 <개정 2026.1.1.>"),
  "금융감독원의 경영공시에 관한 기준 일부개정고시안");
eq("시행령", titleFromContent("신용정보의 이용 및 보호에 관한 법률 시행령\n제1조"),
  "신용정보의 이용 및 보호에 관한 법률 시행령");
eq("규정(내규)", titleFromContent("# 혁신금융업무 등 적극업무 면책제도 운영기준\n제1조(목적)"),
  "혁신금융업무 등 적극업무 면책제도 운영기준");
eq("표/머리말은 제목 아님", titleFromContent("| 의안번호 | 2218335 |\n1. 의결사항\n주문"), "");
eq("본문 둘째 줄 제목", titleFromContent("법제처 심사 전\n전자금융거래법 시행령 일부개정령안\n제안이유"),
  "전자금융거래법 시행령 일부개정령안");

console.log("\n── cleanFilename ──");
eq("번호접두 2-1.", cleanFilename("2-1. 전자금융거래법 시행령 일부개정령안.pdf"),
  "전자금융거래법 시행령 일부개정령안");
eq("번호접두 1)", cleanFilename("1) 예금자보호법 시행령.hwpx"), "예금자보호법 시행령");
eq("선행 [..]", cleanFilename("[금융위] 경영공시 기준.hwpx"), "경영공시 기준");
eq("밑줄→공백+날짜코드 제거", cleanFilename("2218335_의사국 의안과_의안원문.pdf"), "의사국 의안과 의안원문");
eq("날짜코드 접두 제거", cleanFilename("231208_적격기관투자자대상증권 규정 시행세칙.pdf"), "적격기관투자자대상증권 규정 시행세칙");
eq("본문 호항목은 제목 아님", titleFromContent("4. 재무제표(「외부감사법」 제2조에 따른 외부감사대상 법\n적격…규정"), "");

console.log("\n── normalizeMarkdown ──");
truthy("의안 머리말 제거", !normalizeMarkdown("| 의안번호 | 2218335 |\n제출자 : 국무총리\n제안이유 본문").includes("의안번호"));
truthy("페이지번호 제거", !normalizeMarkdown("본문 시작\n- 1 -\n본문 끝").includes("- 1 -"));
truthy("본문 보존", normalizeMarkdown("| 의안번호 | 1 |\n제안이유 주요내용").includes("제안이유 주요내용"));
truthy("빈 표행 제거", !normalizeMarkdown("|  |  |\n내용").includes("|  |"));
truthy("과다개행 축소", !/\n{3,}/.test(normalizeMarkdown("a\n\n\n\n\nb")));

console.log("\n── pickTitle 우선순위 ──");
eq("본문 우선", pickTitle("메타제목", "전자금융거래법 시행령 일부개정령안\n본문", "2-1. 파일.pdf"),
  "전자금융거래법 시행령 일부개정령안");
eq("본문없으면 메타", pickTitle("메타 제목 규정", "제목없는 본문 일반", "9. 무의미.pdf"), "메타 제목 규정");
eq("둘다없으면 파일명정리", pickTitle("", "제목없는 본문 일반", "3-2. 어떤 문서.pdf"), "어떤 문서");

console.log("\n── detectDocNature: 정보성(보도/의견/해석) 다양하게 ──");
const INFO: Array<[string, string]> = [
  ["보도자료(간담회)", "260623_(보도자료) 전산사고 예방 CIO 간담회 개최.pdf"],
  ["보도설명(망분리)", "260614(보도설명) 보안목적 망분리 규제 완화 테스트.pdf"],
  ["비조치의견서", "제1차 보안 목적 AI,SaaS 활용 테스트 참여기관 대상 비조치의견서 발급_vF.hwp"],
  ["비조치 의견(공백)", "○○에 대한 비조치 의견 회신.hwp"],
  ["유권해석", "전자금융거래법 관련 유권해석 회신서.pdf"],
  ["법령해석 질의회신", "신용정보법 관련 법령해석 질의회신.pdf"],
  ["참고자료", "금융권 AI 활용 참고자료.pdf"],
  ["카드뉴스", "예금자보호 한도상향 카드뉴스.pdf"],
];
for (const [name, fn] of INFO) eq(`정보성: ${name}`, detectDocNature(fn, ""), "정보성");

console.log("\n── detectDocNature: 규범(법안/시행령/고시) ──");
const NORM: Array<[string, string]> = [
  ["법률안", "공중협박자금조달금지법 일부개정법률안.pdf"],
  ["시행령 입법예고", "신용정보법 시행령 일부개정령안 입법예고 공고문.pdf"],
  ["고시안", "금융투자업규정 일부개정고시안.hwpx"],
  ["대통령령", "예금자보호법 시행령 일부개정령안.hwpx"],
  ["의견서지만 시행령 동시(규범 우선)", "전자금융 시행령 개정안 비조치의견 첨부.pdf"],
];
for (const [name, fn] of NORM) eq(`규범: ${name}`, detectDocNature(fn, ""), "규범");

// #5 회귀방지: 법안을 '다루는' 보도자료는 그 문서 자체가 비구속(정보성) — 전달형식 우선
eq("보도자료(법안 언급)→정보성", detectDocNature("OO법 개정안 국무회의 통과 보도자료.hwp", ""), "정보성");

console.log("\n── 정보성 문서 제목 추출 ──");
eq("비조치의견서 제목", titleFromContent("제1차 AI 활용 테스트 참여기관 대상 비조치의견서\n발급 배경"),
  "제1차 AI 활용 테스트 참여기관 대상 비조치의견서");
eq("유권해석 회신서 제목", titleFromContent("전자금융거래법 관련 유권해석 회신서\n질의요지"),
  "전자금융거래법 관련 유권해석 회신서");

console.log("\n── detectItemType ──");
eq("법률안→bill", detectItemType("개정법률안.pdf", ""), "bill");
eq("시행령→policy", detectItemType("시행령 일부개정령안.pdf", ""), "policy");
eq("입법예고→policy", detectItemType("공고문.pdf", "입법예고 한다"), "policy");
// #6 회귀방지: 규정/고시/지침류는 파일명만으로 policy 라우팅
eq("규정→policy", detectItemType("금융투자업규정.hwpx", ""), "policy");
eq("고시→policy", detectItemType("전자금융감독규정 개정고시.pdf", ""), "policy");
eq("규정+법률안→bill(법안 우선)", detectItemType("규정 정비 개정법률안.pdf", ""), "bill");

console.log("\n── buildSubQueries: 입력문서 청킹(#1 dedup, #2 중첩 objText) ──");
// 긴 head(법령명+분야 60자↑) + 중첩 before/after 변경 3건 → 구버전은 head prefix로 1개 붕괴.
const longAnalysis = {
  success: true,
  law_name: "금융회사부실자산 등의 효율적 처리 및 한국자산관리공사의 설립에 관한 법률",
  law_domain: "금융 구조조정 자산관리 건전성 감독 정책 금융위원회 소관 업무",
  core_summary: "",
  summary: "",
  change_overview: [],
  search_keywords: [],
  semantic_concepts: [],
  provision_changes: [
    { article: "제5조", before: { text: "자본금 요건 100억" }, after: { text: "자본금 요건 200억으로 상향" } },
    { article: "제6조", before: { text: "이사회 보고 분기 1회" }, after: { text: "이사회 보고 월 1회로 강화" } },
    { article: "제7조", before: { text: "외부감사 임의" }, after: { text: "외부감사 의무화" } },
  ],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;
const head = `${longAnalysis.law_name} ${longAnalysis.law_domain}`;
truthy(`#1 head 길이>60 전제(${head.length}자)`, head.length > 60);
const subs = buildSubQueries(longAnalysis, []);
truthy(`#1 긴 head에도 서브쿼리 붕괴X — 3건 유지(got ${subs.length})`, subs.length === 3);
truthy("#2 중첩 before/after 텍스트 포함", subs.some((q) => q.includes("200억") && q.includes("자본금 요건")));
truthy("#2 각 변경의 조문번호 보존", subs.some((q) => q.includes("제5조")) && subs.some((q) => q.includes("제7조")));

console.log("\n── normalizeMarkdown: 머리말 처리(#10 시행일 보존) ──");
const norm = normalizeMarkdown("의안 번호 : 12345\n시행 연월일 : 2026-01-01\n제1조(목적) 본문");
truthy("#10 시행일 보존", norm.includes("시행 연월일"));
truthy("#10 의안번호(노이즈) 제거", !norm.includes("의안 번호"));

console.log("\n── baseLawName: 근거법령 앵커 정규화(M1) ──");
eq("시행령+개정령안 제거", baseLawName("전자금융거래법 시행령 일부개정령안"), "전자금융거래법");
eq("법률안 제거", baseLawName("공중협박자금조달금지법 일부개정법률안"), "공중협박자금조달금지법");
eq("개정령(안) 제거", baseLawName("부정청탁 및 금품등 수수의 금지에 관한 법률 시행령 일부개정령(안)"),
  "부정청탁및금품등수수의금지에관한법률");
eq("순수 법명 보존", baseLawName("자본시장과 금융투자업에 관한 법률"), "자본시장과금융투자업에관한법률");
// 완전일치 비교라 부분일치 오앵커가 안 생기는지(중소기업은행법 ≠ 은행법) 확인
truthy("#M1 은행법≠중소기업은행법(오앵커 방지)", baseLawName("은행법") !== baseLawName("중소기업은행법"));
truthy("#M1 동일 법령 정규화 일치", baseLawName("은행법 일부개정법률안") === baseLawName("은행법"));

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
