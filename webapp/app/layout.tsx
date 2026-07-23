import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Realtime Noel",
  description: "실시간 양방향 음성 번역 자막 (사내용)",
};

// maximumScale/userScalable pinned to prevent iOS Safari auto-zoom on inputs;
// viewportFit=cover enables env(safe-area-inset-*) on notched devices.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#f5f5f5",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"
        />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&family=Inter:wght@400;500;600&family=EB+Garamond:wght@400;500&display=swap"
        />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <div className="lg-bg" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
