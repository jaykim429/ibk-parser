/**
 * 샘플 파일 파싱 일괄 검증 — 실제 parseDocument로 전 포맷(pdf/hwp/hwpx) 파싱 확인.
 * 실행:  npx tsx scripts/test-parse-samples.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "../lib/parse-document";

const DIR = "샘플 파일";
const timeoutMs = 60000;

async function main() {
  const files = readdirSync(DIR).filter((f) => /\.(pdf|hwp|hwpx|docx|xlsx|txt)$/i.test(f)).sort();
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
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      const snip = doc.markdown.replace(/\s+/g, " ").slice(0, 90);
      console.log(
        `OK  ${sec}s [${doc.fileType}] len=${doc.markdown.length} ocr=${doc.usedOcr}\n    file : ${f}\n    title: ${doc.title}\n    text : ${snip}…`
      );
      ok++;
    } catch (e) {
      console.log(`ERR ${f}\n    → ${(e as Error).message}`);
      err++;
    }
  }
  console.log(`\n파싱 결과: ${ok} OK / ${err} ERR  (총 ${files.length}개)`);
}

main();
