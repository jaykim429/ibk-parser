"use client";

/**
 * 원본 이미지 복원 — 업로드된 PDF File을 브라우저에서 PDF.js로 직접 렌더(픽셀 완벽).
 *  - 서버 왕복/데이터 폭증 없음(File은 프론트가 이미 보유). 폐쇄망 OK(PDF.js 로컬 번들).
 *
 * 성능 최적화:
 *  - 가상화: 화면 근처(±버퍼) 페이지만 렌더, 멀어지면 캔버스 해제 → 수백 페이지도 메모리·끊김 방지.
 *  - 종횡비 플레이스홀더: 1페이지 비율로 모든 페이지 높이를 미리 확보 → 스크롤 점프 제거 + 정확한 가시성.
 *  - 렌더 스케일: devicePixelRatio를 1.5로 캡 → 선명도 유지하며 픽셀 수(=렌더 비용) 절감.
 *  - 동시 렌더 제한: 한 번에 1개씩(큐) → 스크롤 중 메인스레드 점유 최소화.
 */
import { useCallback, useEffect, useRef, useState } from "react";

let _pdfjsP: Promise<Record<string, unknown>> | null = null;
function loadPdfjs(): Promise<Record<string, unknown>> {
  if (!_pdfjsP) {
    _pdfjsP = import("pdfjs-dist").then((pdfjs) => {
      try {
        (pdfjs as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).toString();
      } catch {
        /* fake worker 폴백 */
      }
      return pdfjs as Record<string, unknown>;
    });
  }
  return _pdfjsP;
}

type PdfPageProxy = {
  getViewport(p: { scale: number }): { width: number; height: number };
  render(p: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void>; cancel?: () => void };
  cleanup?: () => void;
};
type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPageProxy>; destroy?: () => void };

const RENDER_SCALE = 1.4 * Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 1.5);

export default function RestoreImageView({ file }: { file: File }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [aspect, setAspect] = useState(1.414); // h/w (A4 세로 기본)
  const [zoom, setZoom] = useState(100); // 표시 배율(%) — 모아찍기/대형 페이지 가독성
  const [err, setErr] = useState("");

  // 동시 렌더 1개로 직렬화하는 간단한 큐(스크롤 중 버벅임 완화)
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const next = chainRef.current.then(task, task);
    chainRef.current = next.catch(() => {});
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let localDoc: PdfDoc | null = null;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const buf = await file.arrayBuffer();
        const getDocument = pdfjs.getDocument as (o: Record<string, unknown>) => { promise: Promise<PdfDoc> };
        localDoc = await getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
        if (cancelled) {
          localDoc.destroy?.();
          return;
        }
        try {
          const p1 = await localDoc.getPage(1);
          const vp = p1.getViewport({ scale: 1 });
          if (vp.width > 0) {
            const a = vp.height / vp.width;
            setAspect(a);
            // 모아찍기/가로형 대형 페이지(가로가 넓음)는 너비맞춤 시 글씨가 작음 → 기본 확대
            if (a < 0.85) setZoom(220); // 2-up 가로 등
            else if (a < 1.1) setZoom(150); // 정사각·약한 가로
          }
        } catch {
          /* 비율 기본값 유지 */
        }
        setDoc(localDoc);
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

  const clampZoom = (z: number) => Math.max(60, Math.min(400, z));
  const btn: React.CSSProperties = {
    border: "1px solid #cbd5e1", background: "#fff", color: "#334155",
    width: 26, height: 26, borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 700, lineHeight: 1,
  };

  return (
    <div style={{ background: "#f1f5f9" }}>
      {/* 확대/축소 툴바(스크롤 고정) — 모아찍기·대형 페이지 가독성 */}
      <div
        style={{
          position: "sticky", top: 0, zIndex: 5, display: "flex", alignItems: "center", gap: 6,
          padding: "6px 8px", background: "rgba(248,250,252,0.96)", borderBottom: "1px solid #e2e8f0",
          backdropFilter: "blur(4px)",
        }}
      >
        <button style={btn} onClick={() => setZoom((z) => clampZoom(z - 25))} title="축소">−</button>
        <span style={{ minWidth: 44, textAlign: "center", fontSize: 12, color: "#475569", fontWeight: 600 }}>{zoom}%</span>
        <button style={btn} onClick={() => setZoom((z) => clampZoom(z + 25))} title="확대">+</button>
        <button
          style={{ ...btn, width: "auto", padding: "0 10px", fontSize: 11.5 }}
          onClick={() => setZoom(100)}
          title="너비 맞춤"
        >
          너비맞춤
        </button>
      </div>
      <div style={{ padding: 8 }}>
        {Array.from({ length: doc.numPages }, (_, i) => (
          <PdfPage key={i} doc={doc} pageNum={i + 1} aspect={aspect} zoom={zoom} enqueue={enqueue} />
        ))}
      </div>
    </div>
  );
}

function PdfPage({
  doc,
  pageNum,
  aspect,
  zoom,
  enqueue,
}: {
  doc: PdfDoc;
  pageNum: number;
  aspect: number;
  zoom: number;
  enqueue: <T>(t: () => Promise<T>) => Promise<T>;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(false);
  const renderingRef = useRef(false);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let cancelled = false;

    const renderPage = () =>
      enqueue(async () => {
        if (cancelled || renderingRef.current) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        renderingRef.current = true;
        try {
          const page = await doc.getPage(pageNum);
          const viewport = page.getViewport({ scale: RENDER_SCALE });
          if (cancelled) return;
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext("2d", { alpha: false });
          if (!ctx) return;
          await page.render({ canvasContext: ctx, viewport }).promise;
          page.cleanup?.();
          if (!cancelled) setDone(true);
        } catch {
          /* 렌더 실패 → 플레이스홀더 유지 */
        } finally {
          renderingRef.current = false;
        }
      });

    const clearPage = () => {
      const canvas = canvasRef.current;
      if (canvas && canvas.width) {
        canvas.width = 0;
        canvas.height = 0;
      }
      setDone(false);
    };

    // 가시 영역 ±800px 안이면 렌더, 벗어나면(대형 문서 메모리 보호) 해제
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (!e) return;
        if (e.isIntersecting) renderPage();
        else if (doc.numPages > 40) clearPage();
      },
      { rootMargin: "800px 0px" }
    );
    io.observe(wrap);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [doc, pageNum, enqueue]);

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        margin: "0 auto 10px",
        width: `${zoom}%`,
        maxWidth: zoom <= 100 ? 820 : "none",
        // 종횡비 기반 높이 확보(렌더 전에도 정확한 자리 → 스크롤 점프 제거)
        aspectRatio: done ? undefined : `1 / ${aspect.toFixed(3)}`,
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
