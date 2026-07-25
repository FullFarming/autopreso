"use client";

// Floating compact glass pill: app name, session status dot, settings gear,
// logout icon. Replaces the old full-width branded header.

import { useRouter } from "next/navigation";

const STATUS_LABELS: Record<string, string> = {
  idle: "대기",
  connecting: "연결 중",
  listening: "듣는 중",
  hearing: "음성 감지",
  translating: "번역 중",
  api_ready: "듣는 중",
  reconnecting: "재연결 중",
  paused: "일시정지",
};

export default function GlassTopBar({
  status,
  onOpenSettings,
}: {
  status: string;
  onOpenSettings: () => void;
}) {
  const router = useRouter();
  const active = status !== "idle";
  const label = STATUS_LABELS[status] ?? status;

  async function handleLogout() {
    try {
      await fetch("/api/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <div className="pt-safe px-safe sticky top-0 z-40 flex justify-center px-3 pt-3">
      <div className="glass-pill flex w-full max-w-[640px] items-center gap-2 px-4 py-2">
        <span className="nowrap text-xs font-semibold tracking-wide text-cw-ink">NOVA</span>
        <span className="nowrap ml-1 inline-flex items-center gap-1.5 text-[11px] text-cw-grey75">
          <span
            className={`h-2 w-2 rounded-full ${
              active ? "cw-pulse bg-cw-green shadow-[0_0_8px_rgba(22,163,74,0.7)]" : "bg-cw-hairlineStrong"
            }`}
          />
          {label}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="설정"
            className="rounded-full p-2 text-cw-grey75 transition-colors hover:bg-black/5 hover:text-cw-ink"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={handleLogout}
            aria-label="로그아웃"
            className="rounded-full p-2 text-cw-grey75 transition-colors hover:bg-black/5 hover:text-cw-ink"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
