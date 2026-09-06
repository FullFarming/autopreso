"use client";

import { useEffect, useState } from "react";

import { AuthShell } from "@/components/auth/AuthShell";
import { exchangeFailureKey, readCallbackParams, safeSupabaseErrorMessage } from "@/components/auth/login-card-model";
import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { FormError } from "@/components/ui/FormControls";
import { getBrowserSupabase } from "@/lib/auth/supabase-browser";
import { loginMessages } from "@/lib/system-language/login-messages";

type Phase = { kind: "working" } | { kind: "error"; message: string } | { kind: "desktop"; next: string };
type ExchangeBody = { code?: string; data?: { next?: unknown } } | null;
const SESSION_WAIT_MILLISECONDS = 10_000;

// Supabase returns here after Google / the email confirmation link. The PKCE code in
// the URL is exchanged by the browser client, then the access token is traded for the
// host cookie (web) or a nova:// deep link (desktop) through POST /api/auth/exchange.
export default function AuthCallbackPage() {
  const t = useSystemText(loginMessages);
  const [phase, setPhase] = useState<Phase>({ kind: "working" });

  useEffect(() => {
    let disposed = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => undefined as void;
    const fail = (message: string) => { if (!disposed) setPhase({ kind: "error", message }); };

    const search = window.location.search;
    const providerError = safeSupabaseErrorMessage(search);
    if (providerError) { fail(providerError); return; }
    const params = readCallbackParams(search);
    const desktop = params.client === "desktop" ? { state: params.state } : null;

    async function exchange(accessToken: string) {
      try {
        const response = await fetch("/api/auth/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken, client: desktop ? "desktop" : "web", state: desktop?.state }),
        });
        const body = (await response.json().catch(() => null)) as ExchangeBody;
        if (disposed) return;
        if (!response.ok || typeof body?.data?.next !== "string") { fail(t(exchangeFailureKey(response.status, body?.code))); return; }
        const next = body.data.next;
        if (next.startsWith("nova://")) setPhase({ kind: "desktop", next });
        window.location.assign(next);
      } catch {
        fail(t("network"));
      }
    }

    function settle(accessToken: string) {
      if (settled || disposed) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      void exchange(accessToken);
    }

    async function run() {
      let supabase: ReturnType<typeof getBrowserSupabase>;
      try { supabase = getBrowserSupabase(); } catch { fail(t("network")); return; }
      // Subscribe before reading so a SIGNED_IN emitted by the code exchange is never missed.
      const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.access_token) settle(session.access_token);
      });
      unsubscribe = () => listener.subscription.unsubscribe();
      timer = setTimeout(() => { if (!settled) { unsubscribe(); fail(t("callbackTimeout")); } }, SESSION_WAIT_MILLISECONDS);
      try {
        const { data } = await supabase.auth.getSession();
        if (data.session?.access_token) settle(data.session.access_token);
      } catch {
        clearTimeout(timer);
        unsubscribe();
        fail(t("network"));
      }
    }

    void run();
    return () => { disposed = true; clearTimeout(timer); unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; t is a stable callback.
  }, []);

  return (
    <AuthShell title={t("title")} lede={t("lede")}>
      <section className="live-join-card live-login-card auth-card" aria-label={t("completing")}>
        {phase.kind === "error" ? (
          <>
            <FormError>{phase.message}</FormError>
            <a className="auth-button auth-secondary" href="/login">{t("backToLogin")}</a>
          </>
        ) : (
          <>
            <p className="auth-notice" role="status">{t("completing")}</p>
            {phase.kind === "desktop" ? <a className="auth-button auth-secondary" href={phase.next}>{t("returnToApp")}</a> : null}
          </>
        )}
      </section>
    </AuthShell>
  );
}
