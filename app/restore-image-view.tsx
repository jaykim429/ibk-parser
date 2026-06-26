"use client";

/**
 * 원본 이미지 복원 — 업로드된 PDF File을 브라우저에서 PDF.js로 직접 렌더(픽셀 완벽).
 *  - 서버 왕복/데이터 폭증 없음(File은 프론트가 이미 보유).
 *  - 페이지는 IntersectionObserver로 '보일 때만' 렌더 → 수백 페이지 매뉴얼도 가볍게.
 *  - 폐쇄망 OK(PDF.js 로컬 번들). PDF가 아니면 호출하지 않음(상위에서 가드).
 */
import { useEffect, useRef, useState } from "react";

// pdfjs는 클라이언트에서만 동적 로드(SSR 회피) + 워커 1회 설정
let _pdfjsP: Promise<unknown> | null = null;
function loadPdfjs(): Promise<Record<string, unknown>> {
  if (!_pdfjsP) {
    _pdfjsP = import("pdfjs-dist").then((pdfjs) => {
      try {
        (pdfjs as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).toString();
      } catch {
        /* 워커 설정 실패 시 fake worker로 동작(느리지만 렌더 가능) */
      }
      return pdfjs;
    });
  }
  return _pdfjsP as Promise<Record<string, unknown>>;
}

type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPageProxy>; destroy?: () => void };
type PdfPageProxy = {
  getViewport(p: { scale: number }): { width: number; height: number };
  render(p: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
};

export default function RestoreImageView({ file }: { file: File }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    let localDoc: PdfDoc | null = null;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const buf = await file.arrayBuffer();
        const getDocument = pdfjs.getDocument as (o: Record<string, unknown>) => { promise: Promise<PdfDoc> };
        localDoc = await getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
        if (!cancelled) setDoc(localDoc);
        else localDoc.destroy?.();
      } catch (e) {
        if (!cancelled) setErr((e as Error).message || "PDF 렌더 실패");
      }
    })();
    return () => {
      cancelled = true;
      try {
        localDoc?.destroy?.();
      } catch {
        /* noop */
      }
    };
  }, [file]);

  if (err) return <div style={{ padding: 16, color: "#b91c1c", fontSize: 13 }}>원본 이미지 렌더 실패: {err}</div>;
  if (!doc) return <div style={{ padding: 16, color: "#64748b", fontSize: 13 }}>원본 페이지 렌더링 준비 중…</div>;

  return (
    <div style={{ padding: 8, background: "#f1f5f9" }}>
      {Array.from({ length: doc.numPages }, (_, i) => (
        <PdfPage key={i} doc={doc} pageNum={i + 1} />
      ))}
    </div>
  );
}

function PdfPage({ doc, pageNum }: { doc: PdfDoc; pageNum: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || done) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || cancelled) return;
        io.disconnect();
        (async () => {
          try {
            const page = await doc.getPage(pageNum);
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const viewport = page.getViewport({ scale: 1.5 * dpr });
            const canvas = canvasRef.current;
            if (!canvas || cancelled) return;
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            canvas.style.width = "100%";
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            await page.render({ canvasContext: ctx, viewport }).promise;
            if (!cancelled) setDone(true);
          } catch {
            /* 페이지 렌더 실패 → 빈 칸 유지 */
          }
        })();
      },
      { rootMargin: "300px 0px" }
    );
    io.observe(wrap);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [doc, pageNum, done]);

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        margin: "0 auto 10px",
        maxWidth: 820,
        minHeight: done ? undefined : 360,
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 4,
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        overflow: "hidden",
      }}
    >
      {!done && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#94a3b8" }}>
          {pageNum}p
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: "block", width: "100%" }} />
    </div>
  );
}
