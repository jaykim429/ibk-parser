/** @type {import('next').NextConfig} */

// kordoc(ESM 전용) + 네이티브 의존성은 번들링하지 않는다.
// 실제 로드는 parse-document.ts에서 런타임 네이티브 동적 import로 처리하므로
// webpack은 kordoc를 추적하지 않는다. (아래는 보조 안전장치)
// 클릭재킹/무단 임베드 방어 — 이 앱은 compliance.ihopper.co.kr admin이 iframe으로 내장하는 용도라
// frame-ancestors로 '허용 부모 출처'만 임베드를 허용한다. 기본 'self'(fail-safe — 단독배포 안전).
// 운영(iframe 내장) 시 env로 부모 출처 명시: FRAME_ANCESTORS="'self' https://compliance.ihopper.co.kr"
// (전체 CSP는 Next 인라인 스크립트/스타일과 충돌하므로 frame-ancestors 지시문만 둔다 — 최소·무충돌)
const frameAncestors = process.env.FRAME_ANCESTORS || "'self'";

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // 네이티브/ESM 전용 — webpack 번들 제외. kordoc formula(onnx/transformers/pdfium/sharp)·
    // print(puppeteer)는 미사용 dead path라 deps에서 제거(0단계). PDF 파싱·OCR 렌더 경로만 유지.
    serverComponentsExternalPackages: [
      "kordoc",
      "pdfjs-dist",
      "@napi-rs/canvas",
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Content-Security-Policy", value: `frame-ancestors ${frameAncestors}` }],
      },
    ];
  },
};

export default nextConfig;
