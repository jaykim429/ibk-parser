/**
 * 파이프라인 HTTP 엔드포인트 (얇은 래퍼)
 * 실제 오케스트레이션은 lib/pipeline.ts(runPipeline)에 있다.
 */
import { NextRequest, NextResponse } from "next/server";
import { runPipeline, type PipelineResult } from "@/lib/pipeline";
import { config } from "@/lib/config";

export const runtime = "nodejs";
// 자체호스트에선 비강제 선언이나 이식·일관성 위해 외부화. 장문 분석(실측 500s대)은
// 리버스프록시 proxy_read_timeout/Node requestTimeout ≥ 이 값으로 함께 맞춰야 504가 안 난다.
export const maxDuration = Number(process.env.PIPELINE_MAX_DURATION ?? 600);
export const dynamic = "force-dynamic";

const tooLarge = (): NextResponse<PipelineResult> =>
  NextResponse.json(
    { success: false, error: `파일이 너무 큽니다(최대 ${Math.floor(config.maxUploadBytes / 1024 / 1024)}MB).` },
    { status: 413 }
  );

export async function POST(req: NextRequest): Promise<NextResponse<PipelineResult>> {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ success: false, error: "파일이 없습니다." }, { status: 400 });
    }
    const f = file as File;
    // 크기 가드: arrayBuffer() 전 신고 크기로 조기 컷(거대버퍼 RAM 적재 회피)
    if (f.size > config.maxUploadBytes) return tooLarge();
    const buffer = Buffer.from(await f.arrayBuffer());
    if (buffer.length === 0) {
      return NextResponse.json({ success: false, error: "빈 파일입니다." }, { status: 400 });
    }
    // 실측 강제선(Content-Length/신고 크기 위조 방어)
    if (buffer.length > config.maxUploadBytes) return tooLarge();

    const result = await runPipeline({ buffer, fileName: f.name });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "파이프라인 처리 중 오류가 발생했습니다.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
