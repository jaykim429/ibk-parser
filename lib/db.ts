/**
 * ODS(PostgreSQL) 커넥션 풀 — 읽기 전용 목록 조회용.
 * ods.ihopper.co.kr 의 검색 데이터마트(dm_*, ods_core)를 조회한다.
 * 연결정보는 ODS_DB_URL 환경변수(.env.local)에서 읽는다.
 */
import { Pool } from "pg";
import { config } from "./config";

let pool: Pool | null = null;

export function getOdsPool(): Pool {
  if (pool) return pool;
  const url = config.odsDbUrl;
  if (!url) {
    throw new Error("ODS_DB_URL 환경변수가 설정되지 않았습니다. (.env.local 확인)");
  }
  // ?ssl=disable 같은 쿼리스트링은 떼어내고 ssl은 명시적으로 끈다.
  const connectionString = url.split("?")[0];
  pool = new Pool({
    connectionString,
    ssl: false,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 15_000,
  });
  return pool;
}
