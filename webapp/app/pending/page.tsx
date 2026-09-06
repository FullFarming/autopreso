"use client";

import { useEffect, useState } from "react";

import { AuthShell } from "@/components/auth/AuthShell";
import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { FormError } from "@/components/ui/FormControls";
import { getBrowserSupabase } from "@/lib/auth/supabase-browser";
import { loginMessages } from "@/lib/system-language/login-messages";

// Approval-pending landing: the exchange sent the user here because
// profiles.status is 'pending'. No host cookie exists yet, so the only action
// is signing out of the Supabase identity (and clearing any stale host cookie).
export default function PendingPage() {
  const t = useSystemText(loginMessages);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    try {
      void getBrowserSupabase().auth.getUser()
        .then(({ data }) => { if (!disposed) setEmail(data.user?.email ?? ""); })
        .catch(() => undefined);
    } catch {
      // Without public Supabase env there is no identity to show; the page still renders.
    }
    return () => { disposed = true; };
  }, []);

  async function logout() {
    setBusy(true);
    setError("");
    try {
      try { await getBrowserSupabase().auth.signOut(); } catch { /* identity sign-out is best-effort */ }
      await fetch("/api/logout", { method: "POST" });
      window.location.assign("/login");
    } catch {
      setError(t("network"));
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t("pendingTitle")} lede={t("pendingBody")}>
      <section className="live-join-card live-login-card auth-card" aria-label={t("pendingTitle")}>
        <p className="auth-notice" role="status">{email ? t("signedInAs", { email }) : t("pendingBody")}</p>
        {error ? <FormError>{error}</FormError> : null}
        <button type="button" className="auth-button auth-secondary" onClick={() => void logout()} disabled={busy} aria-busy={busy}>
          {t(busy ? "loggingOut" : "logout")}
        </button>
        <div className="auth-links">
          <a href="/login">{t("backToLogin")}</a>
          <a href="/watch">{t("participantEntry")}</a>
        </div>
      </section>
    </AuthShell>
  );
}
