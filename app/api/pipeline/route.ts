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

const tooBusy = (): NextResponse<PipelineResult> =>
  NextResponse.json(
    { success: false, error: "현재 동시에 처리 중인 분석이 많습니다. 잠시 후 다시 시도해 주세요." },
    { status: 429 }
  );

// 동시 파이프라인 수(프로세스 전역) — 단일 인스턴스 전제의 자원 가드. 무거운 분석 동시폭주 → 백엔드 과부하·OOM 방지.
let inFlight = 0;

export async function POST(req: NextRequest): Promise<NextResponse<PipelineResult>> {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ success: false, error: "파일이 없습니다." }, { status: 400 });
    }
    const f = file as File;
    // 타입 가드: 무거운 파싱 진입 전 확장자 allowlist 조기 차단(내용검증은 kordoc)
    const ext = (f.name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
    if (!config.allowedUploadExts.includes(ext)) {
      return NextResponse.json(
        { success: false, error: `지원하지 않는 파일 형식입니다(.${ext || "?"}). 지원 형식: ${config.allowedUploadExts.join(", ")}` },
        { status: 415 }
      );
    }
    // 크기 가드: arrayBuffer() 전 신고 크기로 조기 컷(거대버퍼 RAM 적재 회피)
    if (f.size > config.maxUploadBytes) return tooLarge();
    const buffer = Buffer.from(await f.arrayBuffer());
    if (buffer.length === 0) {
      return NextResponse.json({ success: false, error: "빈 파일입니다." }, { status: 400 });
    }
    // 실측 강제선(Content-Length/신고 크기 위조 방어)
    if (buffer.length > config.maxUploadBytes) return tooLarge();

    // 동시성 가드: 상한 초과면 즉시 429(증가 전 검사). 무거운 작업이라 큐 대기 대신 재시도 안내.
    if (inFlight >= config.maxConcurrentPipelines) return tooBusy();
    inFlight++;
    try {
      const result = await runPipeline({ buffer, fileName: f.name });
      return NextResponse.json(result);
    } finally {
      inFlight--; // 정상·예외 모두 감소(누수 방지)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "파이프라인 처리 중 오류가 발생했습니다.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
