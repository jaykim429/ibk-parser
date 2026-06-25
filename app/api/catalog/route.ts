import { NextRequest, NextResponse } from "next/server";
import { searchCatalog, type CatalogKind } from "@/lib/search-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set<CatalogKind>(["regulations", "bills", "notices", "financial", "lawcases"]);

export async function GET(req: NextRequest): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  const kind = params.get("kind") as CatalogKind | null;
  if (!kind || !KINDS.has(kind)) {
    return NextResponse.json({ error: "지원하지 않는 목록입니다." }, { status: 400 });
  }

  try {
    const result = await searchCatalog({
      kind,
      q: params.get("q") || undefined,
      docType: params.get("docType") || undefined,
      category: params.get("category") || undefined,
      status: params.get("status") || undefined,
      dateFrom: params.get("dateFrom") || undefined,
      dateTo: params.get("dateTo") || undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "목록 조회 중 오류가 발생했습니다.";
    console.error("[catalog] error:", message);
    return NextResponse.json(
      { records: [], total: 0, filters: { docTypes: [], categories: [], statuses: [] }, error: message },
      { status: 500 }
    );
  }
}
