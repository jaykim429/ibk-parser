/**
 * 파이프라인 HTTP 엔드포인트 (얇은 래퍼)
 * 실제 오케스트레이션은 lib/pipeline.ts(runPipeline)에 있다.
 */
import { NextRequest, NextResponse } from "next/server";
import { runPipeline, type PipelineResult } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse<PipelineResult>> {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ success: false, error: "파일이 없습니다." }, { status: 400 });
    }
    const f = file as File;
    const buffer = Buffer.from(await f.arrayBuffer());
    if (buffer.length === 0) {
      return NextResponse.json({ success: false, error: "빈 파일입니다." }, { status: 400 });
    }

    const result = await runPipeline({ buffer, fileName: f.name });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "파이프라인 처리 중 오류가 발생했습니다.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
