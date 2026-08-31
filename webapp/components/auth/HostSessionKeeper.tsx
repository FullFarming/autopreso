"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { synchronizeHostSession, type HostSessionSyncResult } from "@/lib/auth/host-session-client";
import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { authMessages } from "@/lib/system-language/auth-messages";
import { isHostSessionPage } from "./host-session-pages";

const CHECK_INTERVAL_MS = 5 * 60_000;

export function HostSessionKeeper() {
  const pathname = usePathname();
  const t = useSystemText(authMessages);
  const [notice, setNotice] = useState<{ pathname: string; kind: HostSessionSyncResult["kind"] } | null>(null);
  const [checking, setChecking] = useState(false);
  const manualCheck = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!isHostSessionPage(pathname)) return;
    let disposed = false;
    let pending = false;
    let automaticChecksStopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => { clearTimeout(timer); timer = undefined; };
    function schedule() {
      clearTimer();
      if (!disposed && !automaticChecksStopped && document.visibilityState === "visible") {
        timer = setTimeout(() => { void check(); }, CHECK_INTERVAL_MS);
      }
    }
    async function check(manual = false) {
      if (disposed || pending || document.visibilityState !== "visible" || (!manual && automaticChecksStopped)) return;
      pending = true;
      clearTimer();
      setChecking(true);
      let result: HostSessionSyncResult;
      try { result = await synchronizeHostSession(); }
      catch { result = { kind: "unavailable" }; }
      if (disposed) return;
      pending = false;
      automaticChecksStopped = result.kind !== "authenticated";
      setChecking(false);
      setNotice({ pathname, kind: result.kind });
      schedule();
    }
    function visibilityChanged() {
      if (document.visibilityState !== "visible") { clearTimer(); return; }
      void check();
    }
    manualCheck.current = () => { void check(true); };
    setNotice(null);
    setChecking(false);
    document.addEventListener("visibilitychange", visibilityChanged);
    void check();
    return () => {
      disposed = true;
      clearTimer();
      manualCheck.current = () => undefined;
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [pathname]);

  if (!isHostSessionPage(pathname) || notice?.pathname !== pathname || notice.kind === "authenticated") return null;
  return <div className="live-error" role="status">
    <p>{t(notice.kind === "signed-out" ? "signedOut" : "unavailable")}</p>
    {notice.kind === "signed-out" ? <a href="/login">{t("login")}</a> : null}
    <button type="button" className="live-secondary-action" onClick={() => manualCheck.current()} disabled={checking} aria-busy={checking}>
      {t(checking ? "checking" : "retry")}
    </button>
  </div>;
}
