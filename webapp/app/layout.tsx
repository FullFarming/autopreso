import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { SystemLanguageProvider } from "@/components/system-language/SystemLanguageProvider";
import { SystemLanguageShell } from "@/components/system-language/SystemLanguageShell";
import { HostSessionKeeper } from "@/components/auth/HostSessionKeeper";
import { normalizeSystemLanguage, SYSTEM_LANGUAGE_STORAGE_KEY } from "@/lib/system-language";

import "./globals.css";

// 2026-08-22 security: Next attaches middleware CSP nonces only during request-time rendering.
// Static prerendering would emit untrusted script tags and the browser would block the application.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "NOVA",
  description: "실시간 양방향 음성 번역 자막 (사내용)",
};

// Safe-area coverage remains enabled without restricting browser zoom.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f5f5f5",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const language = normalizeSystemLanguage((await cookies()).get(SYSTEM_LANGUAGE_STORAGE_KEY)?.value);
  return (
    <html lang={language}>
      <body className="min-h-screen antialiased">
        <div className="lg-bg" aria-hidden="true" />
        <SystemLanguageProvider initialLanguage={language}>
          <HostSessionKeeper />
          <SystemLanguageShell>{children}</SystemLanguageShell>
        </SystemLanguageProvider>
      </body>
    </html>
  );
}
