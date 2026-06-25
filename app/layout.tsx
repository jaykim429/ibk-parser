import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IBK AI 법규 모니터링 시스템 (테스트)",
  description: "규제변동 파일을 업로드하면 내규 조문과 매칭하여 컴플라이언스 보고서를 생성합니다.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
