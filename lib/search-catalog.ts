/**
 * 카탈로그 목록 조회 — ODS(PostgreSQL) 검색 데이터마트 기반.
 *
 *   법률안   → dm_smba.bill_search
 *   입법예고 → ods_core.legislative_notice
 *   법령/판례 → dm.precedent_search
 *   금융규제 → dm.regulation_search (소관부처 '금융' 필터)
 *   내규     → dm_lawtrack.administrative_rule_search (행정규칙/고시)
 *
 * ⚠️ IBK 사내 내규 원본은 ODS에 없어, '내규' 탭은 가장 가까운 행정규칙 데이터로 연결한다.
 *    (로컬 JSON/샘플 파일을 더 이상 읽지 않는다.)
 */
import { getOdsPool } from "./db";

export type CatalogKind = "regulations" | "bills" | "notices" | "financial" | "lawcases";

export type CatalogRecord = {
  id: string;
  kind: CatalogKind;
  title: string;
  source: string;
  docType: string;
  category: string;
  status: string;
  date: string;
  snippet: string;
  tags: string[];
};

export type CatalogQuery = {
  kind: CatalogKind;
  q?: string;
  docType?: string;
  category?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
};

export type CatalogResult = {
  records: CatalogRecord[];
  total: number;
  filters: { docTypes: string[]; categories: string[]; statuses: string[] };
};

type KindConfig = {
  from: string; // "schema"."table"
  idExpr: string;
  titleExpr: string;
  sourceExpr: string;
  docTypeExpr: string;
  categoryExpr: string;
  statusExpr: string; // 빈 문자열을 반환할 수 있음(상태 없음)
  dateExpr: string;
  snippetExpr: string;
  tagsExpr: string; // text[] 또는 NULL
  searchExpr: string;
  baseWhere?: string;
  orderBy: string;
};

// 공백 정리 후 앞부분만 잘라 스니펫 생성
const snip = (col: string, len = 160) =>
  `left(regexp_replace(coalesce(${col}, ''), '\\s+', ' ', 'g'), ${len})`;

const CONFIGS: Record<CatalogKind, KindConfig> = {
  bills: {
    from: `dm_smba.bill_search`,
    idExpr: `bill_id`,
    titleExpr: `coalesce(bill_name, '(제목 없음)')`,
    sourceExpr: `coalesce(jurisdiction_committee, '국회 의안')`,
    docTypeExpr: `coalesce(bill_kind_name, '법률안')`,
    categoryExpr: `coalesce(proposer_kind_name, '')`,
    statusExpr: `coalesce(stage_category_name, current_stage_name, terminal_status, '')`,
    dateExpr: `propose_date`,
    snippetExpr: snip(`coalesce(nullif(summary, ''), search_text)`),
    tagsExpr: `keywords`,
    searchExpr: `search_text`,
    orderBy: `propose_date desc nulls last`,
  },
  notices: {
    from: `ods_core.legislative_notice`,
    idExpr: `notice_id`,
    titleExpr: `coalesce(notice_name, '(제목 없음)')`,
    sourceExpr: `coalesce(ministry_name, '입법예고')`,
    docTypeExpr: `coalesce(law_type, '입법예고')`,
    categoryExpr: `coalesce(ministry_name, '')`,
    statusExpr: `case when end_date is null then '예고' when end_date >= current_date then '진행중' else '마감' end`,
    dateExpr: `coalesce(start_date, announcement_date)`,
    snippetExpr: snip(`notice_content`),
    tagsExpr: `case when law_type is not null then array[law_type] else null end`,
    searchExpr: `(coalesce(notice_name,'') || ' ' || coalesce(notice_content,''))`,
    orderBy: `coalesce(start_date, announcement_date) desc nulls last`,
  },
  lawcases: {
    from: `dm.precedent_search`,
    idExpr: `precedent_id`,
    titleExpr: `coalesce(case_name, case_number, '(사건명 없음)')`,
    sourceExpr: `coalesce(court_name, case_type_name, '판례')`,
    docTypeExpr: `coalesce(case_type_name, '판례')`,
    categoryExpr: `coalesce(case_number, '')`,
    statusExpr: `coalesce(verdict, '')`,
    dateExpr: `verdict_date`,
    snippetExpr: snip(`coalesce(verdict_summary, holding, content)`),
    tagsExpr: `null::text[]`,
    searchExpr: `search_text`,
    orderBy: `verdict_date desc nulls last`,
  },
  financial: {
    from: `dm.regulation_search`,
    idExpr: `regulation_unified_id`,
    titleExpr: `coalesce(regulation_name, '(규제명 없음)')`,
    sourceExpr: `coalesce(ministry_name, '금융규제')`,
    docTypeExpr: `coalesce(law_type, '')`,
    categoryExpr: `coalesce(regulation_sector_category, ministry_name, '')`,
    statusExpr: `case when is_current then '현행' else '이력' end`,
    dateExpr: `coalesce(enforcement_date, promulgation_date, registration_date)`,
    snippetExpr: snip(`coalesce(regulation_summary, search_text)`),
    tagsExpr: `(select array_agg(x->>'law_name') from jsonb_array_elements(coalesce(related_laws,'[]'::jsonb)) x where x->>'law_name' is not null)`,
    searchExpr: `search_text`,
    baseWhere: `(ministry_name ilike '%금융%' or coalesce(regulation_sector_category,'') ilike '%금융%' or coalesce(industry_name,'') ilike '%금융%')`,
    orderBy: `coalesce(enforcement_date, promulgation_date, registration_date) desc nulls last`,
  },
  regulations: {
    from: `dm_lawtrack.administrative_rule_search`,
    idExpr: `administrative_rule_id`,
    titleExpr: `coalesce(name, '(규정명 없음)')`,
    sourceExpr: `coalesce(dept_name, '행정규칙')`,
    docTypeExpr: `coalesce(kind, '규정')`,
    categoryExpr: `coalesce(dept_name, '')`,
    statusExpr: `coalesce(history_type, case when is_current then '현행' else '' end)`,
    dateExpr: `coalesce(enforcement_date, appoint_date)`,
    snippetExpr: snip(`search_text`),
    tagsExpr: `null::text[]`,
    searchExpr: `search_text`,
    orderBy: `coalesce(enforcement_date, appoint_date) desc nulls last`,
  },
};

const LIMIT = 80;

export async function searchCatalog(query: CatalogQuery): Promise<CatalogResult> {
  const cfg = CONFIGS[query.kind];
  if (!cfg) {
    return { records: [], total: 0, filters: { docTypes: [], categories: [], statuses: [] } };
  }
  const pool = getOdsPool();

  const where: string[] = [];
  const params: unknown[] = [];
  if (cfg.baseWhere) where.push(cfg.baseWhere);
  if (query.q?.trim()) {
    params.push(query.q.trim());
    where.push(`(${cfg.searchExpr}) ilike '%' || $${params.length} || '%'`);
  }
  if (query.docType) {
    params.push(query.docType);
    where.push(`(${cfg.docTypeExpr}) = $${params.length}`);
  }
  if (query.category) {
    params.push(query.category);
    where.push(`(${cfg.categoryExpr}) = $${params.length}`);
  }
  if (query.status) {
    params.push(query.status);
    where.push(`(${cfg.statusExpr}) = $${params.length}`);
  }
  if (query.dateFrom) {
    params.push(query.dateFrom);
    where.push(`(${cfg.dateExpr}) >= $${params.length}`);
  }
  if (query.dateTo) {
    params.push(query.dateTo);
    where.push(`(${cfg.dateExpr}) <= $${params.length}`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";

  const sql = `
    select
      (${cfg.idExpr})::text       as id,
      (${cfg.titleExpr})          as title,
      (${cfg.sourceExpr})         as source,
      (${cfg.docTypeExpr})        as "docType",
      (${cfg.categoryExpr})       as category,
      (${cfg.statusExpr})         as status,
      to_char(${cfg.dateExpr}, 'YYYY-MM-DD') as date,
      (${cfg.snippetExpr})        as snippet,
      (${cfg.tagsExpr})           as tags
    from ${cfg.from}
    ${whereSql}
    order by ${cfg.orderBy}
    limit ${LIMIT}`;

  const [{ rows }, filters] = await Promise.all([
    pool.query(sql, params),
    getFilterOptions(query.kind),
  ]);

  const records: CatalogRecord[] = rows.map((r) => ({
    id: String(r.id),
    kind: query.kind,
    title: r.title ?? "",
    source: r.source ?? "",
    docType: r.docType ?? "",
    category: r.category ?? "",
    status: r.status ?? "",
    date: r.date ?? "",
    snippet: r.snippet ?? "",
    tags: Array.isArray(r.tags) ? r.tags.filter(Boolean) : [],
  }));

  return { records, total: records.length, filters };
}

// ── 필터 드롭다운 옵션(부담 큰 GROUP BY는 5분 캐시) ──────────────
type Options = CatalogResult["filters"];
const optCache = new Map<CatalogKind, { at: number; data: Options }>();
const OPT_TTL = 5 * 60 * 1000;

async function getFilterOptions(kind: CatalogKind): Promise<Options> {
  const cached = optCache.get(kind);
  if (cached && Date.now() - cached.at < OPT_TTL) return cached.data;

  const cfg = CONFIGS[kind];
  const pool = getOdsPool();
  const [docTypes, categories, statuses] = await Promise.all([
    distinctValues(pool, cfg, cfg.docTypeExpr),
    distinctValues(pool, cfg, cfg.categoryExpr),
    distinctValues(pool, cfg, cfg.statusExpr),
  ]);
  const data: Options = { docTypes, categories, statuses };
  optCache.set(kind, { at: Date.now(), data });
  return data;
}

async function distinctValues(
  pool: ReturnType<typeof getOdsPool>,
  cfg: KindConfig,
  expr: string
): Promise<string[]> {
  const conds = [cfg.baseWhere, `(${expr}) is not null`, `(${expr}) <> ''`].filter(Boolean);
  const sql = `
    select (${expr}) as v, count(*) as c
    from ${cfg.from}
    where ${conds.join(" and ")}
    group by v
    order by c desc
    limit 40`;
  try {
    const { rows } = await pool.query(sql);
    return rows.map((r) => String(r.v));
  } catch {
    return [];
  }
}
