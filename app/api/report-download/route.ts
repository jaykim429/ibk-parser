import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type DownloadBody = {
  markdown?: string;
  title?: string;
  format?: "pdf" | "hwpx";
};

type KordocDownloadModule = {
  markdownToHwpx: (
    markdown: string,
    options?: {
      theme?: {
        headingColors?: Partial<Record<1 | 2 | 3 | 4, string>>;
        tableHeaderColor?: string;
        tableHeaderBold?: boolean;
        bodyColor?: string;
      };
    }
  ) => Promise<ArrayBuffer>;
  markdownToPdf: (
    markdown: string,
    options?: {
      preset?: "default" | "gov-formal" | "compact";
      pageSize?: "A4" | "Letter";
      margin?: { top: string; right: string; bottom: string; left: string };
      header?: string;
    }
  ) => Promise<Buffer>;
};

let kordoc: KordocDownloadModule | undefined;
const dynamicImport = new Function("s", "return import(s)") as (
  s: string
) => Promise<KordocDownloadModule>;

async function loadKordoc(): Promise<KordocDownloadModule> {
  if (!kordoc) kordoc = await dynamicImport("kordoc");
  return kordoc;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const { markdownToHwpx, markdownToPdf } = await loadKordoc();
    const body = (await req.json()) as DownloadBody;
    const markdown = body.markdown?.trim();
    const format = body.format;

    if (!markdown) {
      return NextResponse.json({ error: "보고서 내용이 없습니다." }, { status: 400 });
    }
    if (format !== "pdf" && format !== "hwpx") {
      return NextResponse.json({ error: "지원하지 않는 다운로드 형식입니다." }, { status: 400 });
    }

    const title = safeFilename(body.title || "규제변동 영향분석 보고서");
    if (format === "hwpx") {
      const arrayBuffer = await markdownToHwpx(markdown, {
        // 검정·그레이 톤 (셀 배경 fill이 고정이라 tableHeaderColor는 '글자색' → 진한 회색으로)
        theme: {
          headingColors: { 1: "1a1a1a", 2: "333333", 3: "4a4a4a", 4: "5a5a5a" },
          tableHeaderColor: "1a1a1a",
          tableHeaderBold: true,
          bodyColor: "262626",
        },
      });
      return binaryResponse(Buffer.from(arrayBuffer), `${title}.hwpx`, "application/x-hwpml-package");
    }

    const pdf = await markdownToPdf(markdown, {
      preset: "gov-formal",
      pageSize: "A4",
      margin: { top: "18mm", right: "16mm", bottom: "18mm", left: "16mm" },
      header: "<div style='font-size:9px;color:#4b5563;width:100%;text-align:right'>IBK 규제변동 영향분석</div>",
    });
    return binaryResponse(pdf, `${title}.pdf`, "application/pdf");
  } catch (err) {
    const message = err instanceof Error ? err.message : "보고서 다운로드 파일 생성 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function binaryResponse(body: Buffer, filename: string, contentType: string): NextResponse {
  return new NextResponse(body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}

function safeFilename(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "report";
}
