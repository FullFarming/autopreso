"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { consoleMessages } from "@/lib/system-language/console-messages";

interface ConsolePendingContextValue { pendingCount: number | null; setPendingCount: (count: number | null) => void }

const ConsolePendingContext = createContext<ConsolePendingContextValue>({ pendingCount: null, setPendingCount: () => undefined });

/** The rail badge follows whatever the users panel last heard from the server. */
export function useConsolePending() {
  return useContext(ConsolePendingContext);
}

const NAV_ITEMS = [
  { href: "/console/users", key: "사용자" },
  { href: "/console/sessions", key: "세션" },
  { href: "/console/engine", key: "엔진" },
] as const;

/**
 * Admin console frame: the NOVA host shell (`live-host-shell` + `live-host-rail`) with the three
 * console sections in the rail. Under 1024 px the rail becomes a top tab bar (`.console-shell`
 * rules in globals.css). The server layout has already established that the viewer is an admin.
 */
export function ConsoleShell({ email, initialPendingCount, children }: { email: string; initialPendingCount: number | null; children: ReactNode }) {
  const t = useSystemText(consoleMessages);
  const pathname = usePathname();
  const [pendingCount, setPendingCount] = useState<number | null>(initialPendingCount);
  const pending = useMemo(() => ({ pendingCount, setPendingCount }), [pendingCount]);

  return (
    <ConsolePendingContext.Provider value={pending}>
      <main className="live-host-shell console-shell">
        <aside className="live-host-rail">
          <strong className="live-join-wordmark">NOVA · {t("콘솔")}</strong>
          <nav aria-label={t("콘솔 메뉴")}>
            {NAV_ITEMS.map((item) => {
              const isCurrent = pathname === item.href || pathname?.startsWith(`${item.href}/`) === true;
              const badge = item.key === "사용자" && pendingCount !== null && pendingCount > 0 ? pendingCount : null;
              return (
                <Link key={item.href} href={item.href} aria-current={isCurrent ? "page" : undefined} className={isCurrent ? "is-current" : undefined}>
                  <span>{t(item.key)}</span>
                  {badge !== null && <span className="console-badge" aria-label={t("대기 중인 가입 {count}건", { count: badge })}>{badge}</span>}
                </Link>
              );
            })}
          </nav>
          <p className="live-join-admin live-host-participant-link"><a href="/admin">{t("라이브로")}</a></p>
          <footer className="live-join-credit console-rail-account">{t("관리자 {email}", { email })}</footer>
        </aside>
        <div className="live-host-workspace console-workspace">{children}</div>
      </main>
    </ConsolePendingContext.Provider>
  );
}
