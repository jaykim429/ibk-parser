/**
 * 매뉴얼형 내규 인덱싱 — 비정형 내규(매뉴얼/지침/규정전문) 파일을 코퍼스에 추가.
 *
 *   매뉴얼 파일(hwp/pdf/...) → manualToChunks(섹션 청킹)
 *     → 코퍼스 JSON(data/ibk-regulations 스키마) 생성  ← BM25/enrich 즉시 반영
 *     → (옵션) 임베딩 후 Qdrant 격리 컬렉션에 '증분 업서트'(컬렉션 삭제 안 함) ← 벡터검색 반영
 *
 * 실행:
 *   npx tsx scripts/index-manuals.ts <파일|디렉터리> [...] [--dry] [--out=DIR]
 *     --dry   JSON만 생성(임베딩/Qdrant 생략)
 *     --out   JSON 출력 디렉터리(기본: data/ibk-regulations)
 *
 * 기존 조문형 내규/컬렉션은 건드리지 않는다(증분 추가만).
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const root = path.join(import.meta.dirname, "..");

// ── .env.local 로드(이미 set된 env 보존) ──
for (const line of readFileSync(path.join(root, ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const QDRANT = process.env.QDRANT_URL;
const COLL = process.env.IBK_REG_COLLECTION;
const EURL = process.env.EMBEDDING_API_URL;
const EKEY = process.env.EMBEDDING_API_KEY;
const EMODEL = process.env.EMBEDDING_MODEL;
const DIM = Number(process.env.EMBEDDING_DIMENSION || 4096);
const REGDIR = path.join(root, process.env.IBK_REG_DIR || "data/ibk-regulations");

const uuid = (s: string): string => {
  const h = crypto.createHash("md5").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const joTitle = (name: string): string => {
  const m = String(name || "").match(/\(([^)]+)\)/);
  return m ? m[1] : String(name || "");
};
const SUPPORTED = /\.(hwp|hwpx|hwp3|hwpml|pdf|docx|xls|xlsx)$/i;

/** 파일명 → regId. 숫자 접두(`80_...`)면 그대로, 없으면 충돌 회피용 대역(800000+)으로 해시. */
function deriveRegId(filename: string): number {
  const m = filename.match(/^(\d+)_/);
  if (m) return Number(m[1]);
  const h = parseInt(crypto.createHash("md5").update(filename).digest("hex").slice(0, 6), 16);
  return 800000 + (h % 90000);
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${EURL}/embeddings`, {
      method: "POST",
      headers: { Authorization: "Bearer " + EKEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMODEL, input: texts }),
    });
    if (r.ok) return (await r.json()).data.map((d: { embedding: number[] }) => d.embedding);
    if (r.status === 429 || r.status >= 500) {
      console.log(`  embed ${r.status}, 재시도 ${attempt + 1}...`);
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`embed HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error("embed 재시도 초과");
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const outArg = args.find((a) => a.startsWith("--out="));
  const outDir = outArg ? path.resolve(outArg.slice(6)) : REGDIR;
  const inputs = args.filter((a) => !a.startsWith("--"));
  if (!inputs.length) {
    console.error("usage: npx tsx scripts/index-manuals.ts <파일|디렉터리> [...] [--dry] [--out=DIR]");
    process.exit(1);
  }

  // 입력 → 파일 목록
  const files: string[] = [];
  for (const inp of inputs) {
    const p = path.resolve(inp);
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p)) if (SUPPORTED.test(f)) files.push(path.join(p, f));
    } else if (SUPPORTED.test(p)) {
      files.push(p);
    }
  }
  if (!files.length) {
    console.error("지원 파일 없음(hwp/hwpx/pdf/docx/xls).");
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const { manualToChunks } = await import(pathToFileURL(path.join(root, "lib/manual-chunk.ts")).href);
  console.log(`매뉴얼 인덱싱: ${files.length}개 파일, dry=${dry}, out=${outDir}\n`);

  let totalChunks = 0;
  for (const file of files) {
    const filename = path.basename(file);
    const regId = deriveRegId(filename);
    const buf = readFileSync(file);
    let chunks: Array<Record<string, unknown>>;
    try {
      chunks = await manualToChunks(buf, filename, regId);
    } catch (e) {
      console.log(`✗ ${filename}: 파싱 실패 — ${(e as Error).message}`);
      continue;
    }
    if (!chunks.length) {
      console.log(`✗ ${filename}: 청크 0`);
      continue;
    }
    const regName = String(chunks[0].regName);

    // ── 코퍼스 JSON(BM25/enrich용) ──
    const articles = chunks.map((c, i) => {
      const hp = c.headingPath as string[];
      return {
        regulation_name: (hp[hp.length - 1] as string) || regName,
        regulation_content: c.body as string,
        type: c.type === "table" ? "별표" : "조",
        jo: String(i + 1),
        section_path: hp.join(" > "),
        sub_articles: [],
      };
    });
    const jsonPath = path.join(outDir, `${regId}_${sanitize(regName)}.json`);
    writeFileSync(jsonPath, JSON.stringify({ regulationName: regName, mappings: {}, source: "manual", articles }, null, 1), "utf-8");

    // ── Qdrant 증분 업서트(벡터검색용) ──
    if (!dry) {
      const items = chunks.map((c, i) => ({
        id: uuid(`${regId}|${articles[i].type}|${i + 1}|0`),
        text: String(c.text).slice(0, 2000),
        payload: {
          regulation_id: regId,
          regulation_name: regName,
          jo: String(i + 1),
          jo_title: joTitle(articles[i].regulation_name),
          type: articles[i].type,
          byeolpyo: null,
          department: "",
          regulation_content: String(c.body).slice(0, 1200),
          chunk_index: 0,
          chunk_total: 1,
          section_path: articles[i].section_path,
          page: c.pageNumber ?? null,
          source: "manual",
        },
      }));
      const B = 64;
      for (let i = 0; i < items.length; i += B) {
        const batch = items.slice(i, i + B);
        const vecs = await embedBatch(batch.map((x) => x.text));
        const points = batch.map((x, k) => ({ id: x.id, vector: vecs[k], payload: x.payload }));
        const up = await fetch(`${QDRANT}/collections/${COLL}/points?wait=true`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ points }),
        });
        if (!up.ok) throw new Error(`upsert HTTP ${up.status}: ${(await up.text()).slice(0, 200)}`);
      }
    }

    totalChunks += chunks.length;
    console.log(`✓ ${filename} → ${path.basename(jsonPath)} (${chunks.length}청크${dry ? ", JSON만" : ", Qdrant 업서트"})`);
  }
  console.log(`\n완료: ${totalChunks}청크${dry ? " (JSON만 — 벡터검색 반영하려면 --dry 없이 재실행)" : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
