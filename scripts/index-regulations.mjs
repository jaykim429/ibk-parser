/**
 * IBK 내규 인덱싱 (일회성 셋업)
 *
 * data/ibk-regulations/*.json (137개, 5천여 조문) → 임베딩(OpenRouter Qwen3-8B 4096d)
 *   → Qdrant 격리 컬렉션(IBK_REG_COLLECTION)에 적재.
 *
 * 기존 regulations 컬렉션(라이브 프론트 사용)은 절대 건드리지 않는다.
 * 실행: node scripts/index-regulations.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ── .env.local 로드 ──
const env = {};
for (const line of readFileSync(path.join(import.meta.dirname, "..", ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const QDRANT = env.QDRANT_URL;
const COLL = env.IBK_REG_COLLECTION;
const EURL = env.EMBEDDING_API_URL;
const EKEY = env.EMBEDDING_API_KEY;
const EMODEL = env.EMBEDDING_MODEL;
const DIM = Number(env.EMBEDDING_DIMENSION || 4096);
const DIR = path.join(import.meta.dirname, "..", "data", "ibk-regulations");

const uuid = (s) => {
  const h = crypto.createHash("md5").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const joTitle = (name) => {
  const m = String(name || "").match(/\(([^)]+)\)/);
  return m ? m[1] : String(name || "").replace(/^제?\s*[\d의]+\s*조\s*/, "");
};
function subText(subs) {
  const p = [];
  for (const s of subs || []) {
    if (s && typeof s === "object") {
      const t = String(s.regulation_content || s.content || "").trim();
      if (t) p.push(t);
      const d = subText(s.sub_articles);
      if (d) p.push(d);
    }
  }
  return p.join("\n");
}

// 장문 조문을 겹침 윈도우로 분할 → 각 청크를 개별 임베딩(재현율↑).
// 짧은 조문은 1청크. 검색 결과는 (내규|구분|조)로 dedup되어 중복 노출 없음.
const CHUNK_SIZE = Number(env.CHUNK_SIZE || 1000);
const CHUNK_OVERLAP = Number(env.CHUNK_OVERLAP || 150);
function chunkText(s, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (s.length <= size) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += size - overlap) out.push(s.slice(i, i + size));
  return out;
}

async function embedBatch(texts) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${EURL}/embeddings`, {
      method: "POST",
      headers: { Authorization: "Bearer " + EKEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMODEL, input: texts }),
    });
    if (r.ok) return (await r.json()).data.map((d) => d.embedding);
    if (r.status === 429 || r.status >= 500) {
      console.log(`  embed ${r.status}, 재시도 ${attempt + 1}...`);
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`embed HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error("embed 재시도 초과");
}

async function main() {
  console.log(`Qdrant=${QDRANT} collection=${COLL} dim=${DIM}`);

  // 컬렉션 재생성 (격리 컬렉션만)
  await fetch(`${QDRANT}/collections/${COLL}`, { method: "DELETE" }).catch(() => {});
  const cr = await fetch(`${QDRANT}/collections/${COLL}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vectors: { size: DIM, distance: "Cosine" } }),
  });
  console.log("컬렉션 생성:", cr.status);

  // 포인트 구성
  const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
  const items = [];
  for (const f of files) {
    const j = JSON.parse(readFileSync(path.join(DIR, f), "utf-8"));
    const regName = j.regulationName || j.regulation_name || f.replace(/\.json$/, "").replace(/^\d+_/, "");
    const regId = parseInt(f.match(/^(\d+)_/)?.[1] || "0", 10);
    for (const a of j.articles || []) {
      const body = String(a.regulation_content || "").trim();
      const sub = subText(a.sub_articles);
      const content = [body, sub].filter(Boolean).join("\n").trim();
      if (!content) continue;
      const chunks = chunkText(content);
      chunks.forEach((chunk, ci) => {
        const text = `${regName} ${a.regulation_name || ""}\n${chunk}`.slice(0, 2000);
        items.push({
          id: uuid(`${regId}|${a.type}|${a.jo}|${a.regulation_name}|${ci}`),
          text,
          payload: {
            regulation_id: regId,
            regulation_name: regName,
            jo: String(a.jo || ""),
            jo_title: joTitle(a.regulation_name),
            type: a.type || "조",
            byeolpyo: a.byeolpyo || null,
            department: "",
            regulation_content: chunk.slice(0, 1200),
            chunk_index: ci,
            chunk_total: chunks.length,
          },
        });
      });
    }
  }
  console.log("총 조문(포인트):", items.length);

  // 임베딩 + 업서트 (배치)
  const B = 48;
  let done = 0;
  for (let i = 0; i < items.length; i += B) {
    const chunk = items.slice(i, i + B);
    const vecs = await embedBatch(chunk.map((c) => c.text));
    const points = chunk.map((c, k) => ({ id: c.id, vector: vecs[k], payload: c.payload }));
    const up = await fetch(`${QDRANT}/collections/${COLL}/points?wait=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points }),
    });
    if (!up.ok) throw new Error(`upsert HTTP ${up.status}: ${(await up.text()).slice(0, 200)}`);
    done += points.length;
    if (i % (B * 10) === 0 || done === items.length) console.log(`  적재 ${done}/${items.length}`);
  }

  const info = await (await fetch(`${QDRANT}/collections/${COLL}`)).json();
  console.log(`완료: ${COLL} points_count=${info.result?.points_count}`);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
