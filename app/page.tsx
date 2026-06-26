"use client";

import { isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const ACCEPT = ".pdf,.hwp,.hwpx,.doc,.docx,.xls,.xlsx,.txt";
const FORMATS = ["PDF", "HWP", "HWPX", "DOC", "DOCX", "XLS", "XLSX", "TXT"];
const STEP_LABELS = ["파일 변환", "조문 파싱", "내규 매칭", "보고서 생성"];
// 동시에 분석할 파일 수(백엔드 LLM 부하를 고려한 상한). 필요 시 조정.
const MAX_CONCURRENCY = 3;

type Stat = { num: string | number; label: string };
type PipelineResult = {
  success: boolean;
  error?: string;
  report?: { markdown: string; title?: string };
  restoredHtml?: string;
  stats?: Stat[];
};

type JobStatus = "queued" | "processing" | "done" | "error";
type Job = {
  id: string;
  file: File;
  fileName: string;
  fileSize: number;
  status: JobStatus;
  step: number;
  startedAt?: number;
  result?: PipelineResult;
};

let jobSeq = 0;
const newJobId = () => `job-${Date.now()}-${jobSeq++}`;

const STATUS_META: Record<JobStatus, { label: string; tone: string }> = {
  queued: { label: "대기", tone: "queued" },
  processing: { label: "분석 중", tone: "processing" },
  done: { label: "완료", tone: "done" },
  error: { label: "실패", tone: "error" },
};

const PAGE_TITLE = "AI 영향분석 테스트 Lab";

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState<"pdf" | "hwpx" | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const patchJob = useCallback((id: string, patch: Partial<Job>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  const addFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files);
    if (!list.length) return;
    setDownloadError("");
    setJobs((prev) => {
      const incoming = list.map<Job>((f) => ({
        id: newJobId(),
        file: f,
        fileName: f.name,
        fileSize: f.size,
        status: "queued",
        step: -1,
      }));
      const next = [...prev, ...incoming];
      // 선택된 항목이 없으면 첫 신규 항목을 보여준다.
      setSelectedId((cur) => cur ?? incoming[0]?.id ?? null);
      return next;
    });
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  // 한 건 분석 (병렬 워커에서 호출).
  const processOne = useCallback(
    async (job: Job) => {
      patchJob(job.id, { status: "processing", step: 0, startedAt: Date.now() });

      const timers: ReturnType<typeof setTimeout>[] = [];
      timers.push(setTimeout(() => patchJob(job.id, { step: 1 }), 5000));
      timers.push(setTimeout(() => patchJob(job.id, { step: 2 }), 85000));
      timers.push(setTimeout(() => patchJob(job.id, { step: 3 }), 230000));

      try {
        const fd = new FormData();
        fd.append("file", job.file);
        const res = await fetch("/api/pipeline", { method: "POST", body: fd });
        const data: PipelineResult = await res.json();
        timers.forEach(clearTimeout);
        patchJob(job.id, {
          status: data.success ? "done" : "error",
          step: STEP_LABELS.length,
          result: data,
        });
      } catch (err) {
        timers.forEach(clearTimeout);
        patchJob(job.id, {
          status: "error",
          step: STEP_LABELS.length,
          result: {
            success: false,
            error:
              err instanceof Error ? err.message : "요청 처리 중 오류가 발생했습니다.",
          },
        });
      }
    },
    [patchJob]
  );

  // 큐에 있는 파일을 병렬 분석한다(동시 실행 수는 MAX_CONCURRENCY로 제한).
  const run = useCallback(async () => {
    setBusy(true);
    setDownloadError("");
    try {
      // 최신 큐를 즉시 읽기 위해 함수형 업데이트로 스냅샷을 확보.
      let pending: Job[] = [];
      setJobs((prev) => {
        pending = prev.filter((j) => j.status === "queued");
        return prev;
      });
      await new Promise((r) => setTimeout(r, 0));
      if (pending.length === 0) return;

      // 진행 상황(ProcessingView)이 바로 보이도록 첫 처리 항목을 강제 선택.
      setSelectedId(pending[0].id);

      // 동시 실행 수 제한 워커 풀
      let cursor = 0;
      const worker = async () => {
        while (cursor < pending.length) {
          const job = pending[cursor++];
          await processOne(job);
        }
      };
      const workerCount = Math.min(MAX_CONCURRENCY, pending.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    } finally {
      setBusy(false);
    }
  }, [processOne]);

  const removeJob = useCallback((id: string) => {
    setJobs((prev) => {
      const next = prev.filter((j) => j.id !== id);
      setSelectedId((cur) => (cur === id ? next[next.length - 1]?.id ?? null : cur));
      return next;
    });
  }, []);

  const clearJobs = useCallback(() => {
    setJobs([]);
    setSelectedId(null);
    setDownloadError("");
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const selectedJob = jobs.find((j) => j.id === selectedId) ?? null;
  const queuedCount = jobs.filter((j) => j.status === "queued").length;

  const downloadReport = useCallback(
    async (format: "pdf" | "hwpx") => {
      const report = selectedJob?.result?.report;
      if (!report?.markdown) return;
      setDownloadBusy(format);
      setDownloadError("");
      try {
        const res = await fetch("/api/report-download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            markdown: report.markdown,
            title: report.title || "규제변동 영향분석 보고서",
            format,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error || "다운로드 파일을 만들지 못했습니다.");
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${report.title || "규제변동 영향분석 보고서"}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        setDownloadError(err instanceof Error ? err.message : "다운로드 중 오류가 발생했습니다.");
      } finally {
        setDownloadBusy(null);
      }
    },
    [selectedJob]
  );

  return (
    <>
      <header className="cg-header">
        <div className="cg-header-inner">
          <a className="cg-brand" href="/">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/CGinside.png" alt="CG INSIDE" className="cg-logo-img" />
            <span className="cg-sys-name">
              내규 기반 법령
              <br />
              리스크 모니터링 시스템
            </span>
          </a>
          <span className="cg-page-badge">AI 영향분석 테스트 Lab</span>
        </div>
      </header>

      <main className="app-main">
        <div className="app-layout">
          <section className="workspace">
            <div className="workspace-head">
              <div>
                <p className="eyebrow">규제변동 영향분석</p>
                <h1>{PAGE_TITLE}</h1>
                <p className="lede">규제변동 문서를 업로드하면 IBK 내규 영향 보고서를 생성합니다.</p>
              </div>
            </div>

            <AnalysisView
              jobs={jobs}
              selectedJob={selectedJob}
              queuedCount={queuedCount}
              drag={drag}
              busy={busy}
              inputRef={inputRef}
              downloadBusy={downloadBusy}
              downloadError={downloadError}
              onDrop={onDrop}
              onDragChange={setDrag}
              addFiles={addFiles}
              onSelect={setSelectedId}
              run={run}
              removeJob={removeJob}
              clearJobs={clearJobs}
              downloadReport={downloadReport}
            />
          </section>
        </div>
      </main>
      <footer className="app-footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <span className="cg-mark">CG</span>
            <span>(주)씨지인사이드</span>
          </div>
          <div className="footer-info">
            <div>서울특별시 마포구 백범로31길 21 서울창업허브·서울복지타운 7층</div>
            <div>사업자등록번호 : 162-81-01174 | 대표 : 박선춘 | 연락처 : 02-6326-2144 | 이메일 : support@ihopper.co.kr</div>
            <div>통신판매업 신고번호 : 제 2022-서울구로-0249 호</div>
            <div>© 2026 CGinside. All rights reserved.</div>
          </div>
        </div>
      </footer>
    </>
  );
}

function impactCount(job: Job): number | null {
  const stat = job.result?.stats?.find((s) => s.label === "영향 내규");
  if (!stat) return null;
  const n = Number(stat.num);
  return Number.isFinite(n) ? n : null;
}

// ── 보고서 목차(TOC) ─────────────────────────────────
function slugify(s: string): string {
  return s
    .toString()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w가-힣.-]/g, "")
    .toLowerCase()
    .slice(0, 80);
}

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return "";
}

// 보고서 헤딩에 id 부여(목차 스크롤 앵커)
const mdComponents: Components = {
  h1: ({ children }) => <h1 id={slugify(nodeText(children))}>{children}</h1>,
  h2: ({ children }) => <h2 id={slugify(nodeText(children))}>{children}</h2>,
  h3: ({ children }) => <h3 id={slugify(nodeText(children))}>{children}</h3>,
  h4: ({ children }) => <h4 id={slugify(nodeText(children))}>{children}</h4>,
};

// ── 분석 중 시각화 ───────────────────────────────────
const STAGE_EMOJI = ["📄", "🔎", "🧩", "📝"];
const PROC_TIPS = [
  "문서를 표준 형식으로 변환하는 중…",
  "조문·항·호 구조를 파싱하는 중…",
  "5,000여 IBK 내규 조문에서 후보를 찾는 중 (BM25 + 벡터 RRF)…",
  "관련도 리랭킹으로 노이즈를 거르는 중…",
  "조문별 적합성·영향도를 판정하는 중…",
  "근거 법령·업무영역을 대조하는 중…",
  "보고서를 작성하는 중…",
  "거의 다 왔어요 ☕ 조금만 기다려 주세요",
];

function ProcessingView({ job }: { job: Job }) {
  const [now, setNow] = useState(() => Date.now());
  const [tip, setTip] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    const m = setInterval(() => setTip((i) => (i + 1) % PROC_TIPS.length), 3500);
    return () => {
      clearInterval(t);
      clearInterval(m);
    };
  }, []);
  const elapsed = Math.max(0, Math.floor((now - (job.startedAt ?? now)) / 1000));
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");
  const step = Math.max(0, Math.min(STEP_LABELS.length - 1, job.step));
  const stageBase = (step / STEP_LABELS.length) * 100;
  const pct = Math.min(96, Math.round(Math.max(stageBase, (elapsed / 240) * 100)));

  return (
    <div className="panel proc">
      <div className="proc-hero">
        <div className="proc-orb">
          <span className="proc-orb-emoji">🏛️</span>
        </div>
        <h2>AI가 규제변동을 분석하고 있어요</h2>
        <p className="proc-file">{job.fileName}</p>
      </div>

      <div className="proc-pipeline">
        {STEP_LABELS.map((label, i) => {
          const state = i < step ? "done" : i === step ? "active" : "todo";
          return (
            <div className={`proc-stage ${state}`} key={label}>
              <div className="proc-node">{i < step ? "✓" : STAGE_EMOJI[i]}</div>
              <div className="proc-stage-label">{label}</div>
            </div>
          );
        })}
      </div>

      <div className="proc-bar">
        <div className="proc-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="proc-foot">
        <span className="proc-pct">{pct}%</span>
        <span className="proc-tip" key={tip}>
          {PROC_TIPS[tip]}
        </span>
        <span className="proc-time">⏱ {mm}:{ss}</span>
      </div>
      <p className="proc-note">분석 중에도 완료된 다른 보고서를 눌러 확인할 수 있어요.</p>
    </div>
  );
}

function AnalysisView(props: {
  jobs: Job[];
  selectedJob: Job | null;
  queuedCount: number;
  drag: boolean;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  downloadBusy: "pdf" | "hwpx" | null;
  downloadError: string;
  onDrop: (e: React.DragEvent) => void;
  onDragChange: (value: boolean) => void;
  addFiles: (files: FileList | File[] | null) => void;
  onSelect: (id: string) => void;
  run: () => void;
  removeJob: (id: string) => void;
  clearJobs: () => void;
  downloadReport: (format: "pdf" | "hwpx") => void;
}) {
  const {
    jobs,
    selectedJob,
    queuedCount,
    drag,
    busy,
    inputRef,
    downloadBusy,
    downloadError,
    onDrop,
    onDragChange,
    addFiles,
    onSelect,
    run,
    removeJob,
    clearJobs,
    downloadReport,
  } = props;

  const hasJobs = jobs.length > 0;
  const doneCount = jobs.filter((j) => j.status === "done").length;

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT}
      multiple
      className="hidden-input"
      onChange={(e) => {
        addFiles(e.target.files);
        e.target.value = "";
      }}
    />
  );

  // 업로드 전: 큰 드롭존 안내
  if (!hasJobs) {
    return (
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>규제변동 파일 업로드</h2>
            <p>법률안·입법예고·공포 문서를 여러 개 올리면 IBK 내규 영향 보고서를 한 건씩 생성합니다.</p>
          </div>
        </div>
        <div
          className={`dropzone${drag ? " drag" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            onDragChange(true);
          }}
          onDragLeave={() => onDragChange(false)}
          onDrop={onDrop}
        >
          <div className="drop-icon">문서</div>
          <strong>파일을 끌어다 놓거나 클릭하여 선택</strong>
          <span>여러 파일 동시 선택 가능 · 파일당 최대 10MB</span>
          <div className="formats">
            {FORMATS.map((format) => (
              <span className="fmt" key={format}>
                {format}
              </span>
            ))}
          </div>
        </div>
        {fileInput}
      </div>
    );
  }

  // 업로드 후: 좌측 분석 목록 + 우측 상세 보고서
  return (
    <div className="analysis-grid">
      <aside className="job-panel">
        <div className="job-panel-head">
          <div className="job-panel-title">
            <strong>분석 목록</strong>
            <span>
              완료 {doneCount} / 전체 {jobs.length}
            </span>
          </div>
          <button className="btn ghost xs" onClick={clearJobs} disabled={busy}>
            전체 지우기
          </button>
        </div>

        <div className="job-actions">
          <button
            className="btn xs"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            파일 추가
          </button>
          <button className="btn xs" onClick={run} disabled={busy || queuedCount === 0}>
            {busy ? <span className="spinner mini" /> : null}
            {busy ? "분석 중" : queuedCount > 0 ? `분석 시작 (${queuedCount})` : "대기 없음"}
          </button>
        </div>

        <div
          className={`job-drop${drag ? " drag" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            onDragChange(true);
          }}
          onDragLeave={() => onDragChange(false)}
          onDrop={onDrop}
        >
          파일을 끌어다 놓거나 클릭해 추가
        </div>

        <ul className="job-list">
          {jobs.map((job, i) => {
            const meta = STATUS_META[job.status];
            const impact = impactCount(job);
            return (
              <li key={job.id}>
                <button
                  className={`job-card${selectedJob?.id === job.id ? " active" : ""}`}
                  onClick={() => onSelect(job.id)}
                >
                  <span className="job-index">{i + 1}</span>
                  <span className="job-body">
                    <span className="job-name" title={job.fileName}>
                      {job.fileName}
                    </span>
                    <span className="job-sub">
                      <span className={`jstatus ${meta.tone}`}>
                        {job.status === "processing" ? <span className="spinner mini" /> : null}
                        {meta.label}
                      </span>
                      {job.status === "done" && impact !== null ? (
                        <span className="job-impact">영향 내규 {impact}건</span>
                      ) : (
                        <span className="job-size">{humanSize(job.fileSize)}</span>
                      )}
                    </span>
                  </span>
                  {!busy && (
                    <span
                      className="job-remove"
                      role="button"
                      aria-label="삭제"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeJob(job.id);
                      }}
                    >
                      ×
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="report-detail">
        <ReportDetail
          job={selectedJob}
          downloadBusy={downloadBusy}
          downloadError={downloadError}
          downloadReport={downloadReport}
        />
      </section>
      {fileInput}
    </div>
  );
}

function ReportDetail(props: {
  job: Job | null;
  downloadBusy: "pdf" | "hwpx" | null;
  downloadError: string;
  downloadReport: (format: "pdf" | "hwpx") => void;
}) {
  const { job, downloadBusy, downloadError, downloadReport } = props;
  const [showRestore, setShowRestore] = useState(false);

  if (!job) {
    return (
      <div className="panel detail-empty">
        <div className="empty-state">왼쪽 목록에서 분석할 항목을 선택하세요.</div>
      </div>
    );
  }

  if (job.status === "queued") {
    return (
      <div className="panel detail-empty">
        <div className="detail-head">
          <h2>{job.fileName}</h2>
          <p>분석 대기 중입니다. “분석 시작”을 누르면 순서대로 처리됩니다.</p>
        </div>
      </div>
    );
  }

  if (job.status === "processing") {
    return <ProcessingView job={job} />;
  }

  const result = job.result;
  if (job.status === "error" || !result?.success || !result.report) {
    return (
      <div className="panel">
        <div className="alert err">
          <strong>처리 실패 — {job.fileName}</strong>
          <div>{result?.error || "분석 중 오류가 발생했습니다."}</div>
        </div>
      </div>
    );
  }

  const hasRestore = !!result.restoredHtml;

  return (
    <div className="panel result-panel">
      <div className="result-toolbar">
        <div>
          <h2>{result.report.title || job.fileName}</h2>
          <p>보고서를 검토한 뒤 PDF 또는 HWPX로 저장할 수 있습니다.</p>
        </div>
        <div className="download-actions">
          <button className="btn ghost compact" onClick={() => downloadReport("pdf")} disabled={!!downloadBusy}>
            {downloadBusy === "pdf" ? "PDF 생성 중" : "PDF 다운로드"}
          </button>
          <button className="btn compact" onClick={() => downloadReport("hwpx")} disabled={!!downloadBusy}>
            {downloadBusy === "hwpx" ? "HWPX 생성 중" : "HWPX 다운로드"}
          </button>
        </div>
      </div>
      {downloadError && <div className="alert err">{downloadError}</div>}
      {result.stats && result.stats.length > 0 && (
        <div className="stats">
          {result.stats
            .filter((s) => s.label !== "처리 시간")
            .map((s, i) => (
              <div className="stat" key={i}>
                <div className="num">{s.num}</div>
                <div className="label">{s.label}</div>
              </div>
            ))}
        </div>
      )}
      <div className={`report-split${showRestore ? " open" : ""}`}>
        {hasRestore && (
          <button
            className="restore-tab"
            onClick={() => setShowRestore((v) => !v)}
            aria-pressed={showRestore}
            title={showRestore ? "원문 닫기" : "원문 복원 보기"}
          >
            {showRestore ? "◀ 원문 닫기" : "원문 복원 ▶"}
          </button>
        )}
        {showRestore && hasRestore && (
          <div className="restore-pane">
            <div className="restore-pane-head">원문 복원 (파싱 재구성)</div>
            <iframe
              className="restore-frame"
              title="원문 복원"
              sandbox=""
              srcDoc={result.restoredHtml}
            />
          </div>
        )}
        <div className="report-pane report-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {result.report.markdown}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
