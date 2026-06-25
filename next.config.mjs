/** @type {import('next').NextConfig} */

// kordoc(ESM 전용) + 네이티브 의존성은 번들링하지 않는다.
// 실제 로드는 parse-document.ts에서 런타임 네이티브 동적 import로 처리하므로
// webpack은 kordoc를 추적하지 않는다. (아래는 보조 안전장치)
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: [
      "kordoc",
      "sharp",
      "pdfjs-dist",
      "puppeteer-core",
      "@hyzyla/pdfium",
      "onnxruntime-node",
      "@huggingface/transformers",
    ],
  },
};

export default nextConfig;
