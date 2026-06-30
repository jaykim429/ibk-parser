/**
 * 문서 변환 엔드포인트 — kordoc 파싱 결과(markdown)를 law-core-ai 변환기 계약으로 노출.
 *
 * law-core-ai `_convert_remote` 가 POST {converter_url}/convert (multipart "file") → {data:{text}}
 * 으로 호출한다(conversion.py). 파이프라인(/api/pipeline)과 달리 파싱(kordoc)만 수행 —
 * 검색·판단·보고 없음. kordoc 은 한글 신구조문대비표를 표로 보존하고 HWP/HWPX·스캔 OCR 도 처리하므로
 * law-core-ai 의 신구표/조문 추출(텍스트 패턴·LLM) 입력 품질이 PyPDF2·Docling 대비 높다.
 *
 * 폴백 계약: 415/500 → law-core-ai 가 raise_for_status 로 받아 local(_convert_local) 폴백(무중단).
 * 비OCR 파싱은 빠르나(<10s), 스캔본 OCR 은 law-core-ai 측 timeout=60s 를 넘으면 폴백될 수 있다(무회귀).
 */
import { NextRequest, NextResponse } from "next/server";
import { parseDocument } from "@/lib/parse-document";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const maxDuration = Number(process.env.CONVERT_MAX_DURATION ?? 300);
export const dynamic = "force-dynamic";

type ConvertResponse = { data: { text: string } } | { error: string };

export async function POST(req: NextRequest): Promise<NextResponse<ConvertResponse>> {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "파일이 없습니다." }, { status: 400 });
    }
    const f = file as File;
    const ext = (f.name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
    // 지원 포맷만 파싱(kordoc). 그 외는 415 → law-core-ai 가 local(_convert_local) 폴백.
    if (!config.allowedUploadExts.includes(ext)) {
      return NextResponse.json(
        { error: `지원하지 않는 형식(.${ext || "?"}) — law-core-ai local 폴백 대상.` },
        { status: 415 }
      );
    }
    if (f.size > config.maxUploadBytes) {
      return NextResponse.json({ error: "파일이 너무 큽니다." }, { status: 413 });
    }
    const buffer = Buffer.from(await f.arrayBuffer());
    if (buffer.length === 0) {
      return NextResponse.json({ error: "빈 파일입니다." }, { status: 400 });
    }

    const doc = await parseDocument(buffer, f.name);
    // law-core-ai 계약: {data:{text}}. kordoc markdown(신구표=표·헤딩 보존) 그대로 전달.
    return NextResponse.json({ data: { text: doc.markdown } });
  } catch (e) {
    // 파싱 실패 → 5xx → law-core-ai local 폴백(무음 통과 금지).
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `변환 실패: ${msg}` }, { status: 500 });
  }
}
