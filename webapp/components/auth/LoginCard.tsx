"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { getLoginRetryDeadline, getLoginRetrySeconds } from "@/app/(login)/login/login-retry";
import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { FormButton, FormError, FormField } from "@/components/ui/FormControls";
import { getBrowserSupabase } from "@/lib/auth/supabase-browser";
import { loginMessages } from "@/lib/system-language/login-messages";

import { AuthShell } from "./AuthShell";
import { GoogleIcon } from "./GoogleIcon";
import {
  buildCallbackRedirect,
  buildDesktopGoogleStartUrl,
  classifyIdentifier,
  exchangeFailureKey,
  readDesktopLoginParams,
  validateSignup,
  type DesktopLoginParams,
  type LoginMode,
} from "./login-card-model";

declare global {
  interface Window {
    // Exposed by electron/desktop-login-preload.js inside the desktop login window only.
    novaDesktopLogin?: { openExternal(url: string): Promise<boolean> };
  }
}

type FieldErrors = { name?: string; email?: string; password?: string; identifier?: string };
type Notice = { title: string; body?: string } | null;
type ExchangeBody = { code?: string; data?: { next?: unknown } } | null;

// Lucide `eye` / `eye-off` outlines; no emoji anywhere on the card.
function EyeIcon({ hidden }: { hidden: boolean }) {
  const shared = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, focusable: "false" as const };
  if (hidden) {
    return (
      <svg {...shared}>
        <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
        <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
        <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
        <path d="m2 2 20 20" />
      </svg>
    );
  }
  return (
    <svg {...shared}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function LoginCard() {
  const t = useSystemText(loginMessages);
  const [mode, setMode] = useState<LoginMode>("signin");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [submitting, setSubmitting] = useState(false);
  const [desktopNext, setDesktopNext] = useState("");
  const [retryUntil, setRetryUntil] = useState(0);
  const [clock, setClock] = useState(Date.now);
  // Read once on the client: the desktop login window opens /login?client=desktop&state=…
  // and the system browser is sent to /login?client=desktop&state=…&auto=google.
  const desktopRef = useRef<DesktopLoginParams | null>(null);
  const retryUntilRef = useRef(0);
  const submissionRef = useRef<AbortController | null>(null);
  const retrySeconds = getLoginRetrySeconds(retryUntil, clock);

  useEffect(() => () => { submissionRef.current?.abort(); }, []);
  useEffect(() => {
    if (retryUntil <= Date.now()) return;
    const interval = setInterval(() => {
      const now = Date.now();
      setClock(now);
      if (now >= retryUntil) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [retryUntil]);
  useEffect(() => {
    const search = window.location.search;
    desktopRef.current = readDesktopLoginParams(search);
    if (new URLSearchParams(search).get("auto") === "google") void startGoogle();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: URL parameters do not change in place.
  }, []);

  function applyRetryAfter(header: string | null) {
    const now = Date.now();
    const deadline = getLoginRetryDeadline(header, now) ?? 0;
    retryUntilRef.current = deadline;
    setRetryUntil(deadline);
    setClock(now);
  }

  function clearFeedback() {
    setError("");
    setNotice(null);
  }

  async function exchange(accessToken: string, signal: AbortSignal) {
    const desktop = desktopRef.current;
    const response = await fetch("/api/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken, client: desktop ? "desktop" : "web", state: desktop?.state }),
      signal,
    });
    if (signal.aborted) return;
    const body = (await response.json().catch(() => null)) as ExchangeBody;
    if (signal.aborted) return;
    if (response.status === 429) applyRetryAfter(response.headers.get("Retry-After"));
    if (!response.ok || typeof body?.data?.next !== "string") {
      setError(t(exchangeFailureKey(response.status, body?.code)));
      return;
    }
    const next = body.data.next;
    // Desktop: the deep link hands the one-shot code to the app; keep a visible
    // fallback link because some browsers swallow custom-scheme navigations.
    if (next.startsWith("nova://")) setDesktopNext(next);
    window.location.assign(next);
  }

  async function legacyLogin(id: string, password: string, signal: AbortSignal) {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, password }),
      signal,
    });
    if (signal.aborted) return;
    if (response.ok) {
      setPassword("");
      // A document navigation makes middleware validate the newly issued
      // httpOnly cookie before the protected host screen is rendered.
      window.location.assign("/admin");
      return;
    }
    await response.json().catch(() => null);
    if (signal.aborted) return;
    if (response.status === 429) applyRetryAfter(response.headers.get("Retry-After"));
    setError(t(response.status === 429 ? "rateLimited" : "invalidCredentials"));
  }

  async function startGoogle() {
    clearFeedback();
    const origin = window.location.origin;
    const desktop = desktopRef.current;
    try {
      if (desktop && window.novaDesktopLogin) {
        // Inside the Electron login window: Google must run in the system browser,
        // which returns through nova://auth/callback (Task 6).
        await window.novaDesktopLogin?.openExternal(buildDesktopGoogleStartUrl(origin, desktop.state));
        setNotice({ title: t("desktopGoogleHint") });
        return;
      }
      const { error: oauthError } = await getBrowserSupabase().auth.signInWithOAuth({ provider: "google", options: { redirectTo: buildCallbackRedirect(origin, desktop) } });
      if (oauthError) setError(t("network"));
    } catch {
      setError(t("network"));
    }
  }

  async function resetPassword() {
    clearFeedback();
    if (classifyIdentifier(identifier) !== "email") {
      setFieldErrors((current) => ({ ...current, identifier: "emailInvalid" }));
      return;
    }
    try {
      const { error: resetError } = await getBrowserSupabase().auth.resetPasswordForEmail(identifier.trim(), { redirectTo: buildCallbackRedirect(window.location.origin, null) });
      if (resetError) { setError(t("network")); return; }
      setNotice({ title: t("resetSent") });
    } catch {
      setError(t("network"));
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submissionRef.current || retryUntilRef.current > Date.now()) return;
    const controller = new AbortController();
    submissionRef.current = controller;
    setSubmitting(true);
    clearFeedback();
    try {
      if (mode === "signup") {
        const errors = validateSignup({ name, email: identifier, password });
        setFieldErrors(errors);
        if (Object.keys(errors).length > 0) return;
        const email = identifier.trim();
        const { data, error: signUpError } = await getBrowserSupabase().auth.signUp({
          email,
          password,
          options: { data: { full_name: name.trim() }, emailRedirectTo: buildCallbackRedirect(window.location.origin, null) },
        });
        if (controller.signal.aborted) return;
        if (signUpError) { setError(t("signUpFailed")); return; }
        setPassword("");
        // Projects without email confirmation return a session right away; hand
        // it to the exchange so the pending page appears without a second login.
        if (data.session?.access_token) { await exchange(data.session.access_token, controller.signal); return; }
        setNotice({ title: t("checkEmail"), body: t("checkEmailBody", { email }) });
        return;
      }
      const kind = classifyIdentifier(identifier);
      if (kind === "invalid") { setFieldErrors({ identifier: "identifierInvalid" }); return; }
      setFieldErrors({});
      if (kind === "legacy-id") { await legacyLogin(identifier.trim(), password, controller.signal); return; }
      const { data, error: signInError } = await getBrowserSupabase().auth.signInWithPassword({ email: identifier.trim(), password });
      if (controller.signal.aborted) return;
      if (signInError || !data.session) { setError(t("invalidCredentials")); return; }
      await exchange(data.session.access_token, controller.signal);
    } catch {
      if (!controller.signal.aborted) setError(t("network"));
    } finally {
      if (submissionRef.current === controller) submissionRef.current = null;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  function switchMode() {
    setMode(mode === "signup" ? "signin" : "signup");
    setFieldErrors({});
    setShowPassword(false);
    clearFeedback();
  }

  function validateIdentifierOnBlur() {
    const trimmed = identifier.trim();
    setFieldErrors((current) => {
      if (mode === "signup") return { ...current, email: trimmed && classifyIdentifier(trimmed) !== "email" ? "emailInvalid" : undefined };
      return { ...current, identifier: trimmed && classifyIdentifier(trimmed) === "invalid" ? "identifierInvalid" : undefined };
    });
  }

  const identifierError = fieldErrors.identifier ?? fieldErrors.email;

  return (
    <AuthShell
      title={t(mode === "signup" ? "signUp" : "title")}
      lede={t("lede")}
      aside={<p className="live-join-admin live-login-role-switch">{t("participantQuestion")} <a href="/watch">{t("participantEntry")}</a></p>}
    >
      <section className="live-join-card live-login-card auth-card" aria-label={t(mode === "signup" ? "signUp" : "signInFormLabel")}>
        <button type="button" className="live-primary-action auth-button auth-google" data-auth-action="google" onClick={() => void startGoogle()} disabled={submitting}>
          <GoogleIcon />
          <span>{t("googleContinue")}</span>
        </button>
        {notice ? (
          <div className="auth-notice" role="status">
            <p>{notice.title}</p>
            {notice.body ? <p>{notice.body}</p> : null}
          </div>
        ) : null}
        {desktopNext ? <a className="auth-button auth-secondary" href={desktopNext}>{t("returnToApp")}</a> : null}
        <div className="auth-divider" role="separator" aria-label={t("or")}><span>{t("or")}</span></div>
        <form onSubmit={handleSubmit} className="live-login-form auth-form" aria-busy={submitting} noValidate>
          {mode === "signup" ? (
            <FormField id="signup-name" name="name" label={t("name")} type="text" autoComplete="name" className="live-name-input" value={name}
              onChange={(event) => { setName(event.target.value); setError(""); }}
              onBlur={() => setFieldErrors((current) => ({ ...current, name: name.trim() ? undefined : "nameRequired" }))}
              disabled={submitting} required />
          ) : null}
          {fieldErrors.name ? <FormError>{t(fieldErrors.name)}</FormError> : null}
          <FormField id="login-identifier" name="identifier" label={t(mode === "signup" ? "email" : "identifier")} type={mode === "signup" ? "email" : "text"}
            autoComplete={mode === "signup" ? "email" : "username"} className="live-name-input" autoCapitalize="none" spellCheck={false} value={identifier}
            onChange={(event) => { setIdentifier(event.target.value); setError(""); }}
            onBlur={validateIdentifierOnBlur}
            disabled={submitting} required />
          {identifierError ? <FormError>{t(identifierError)}</FormError> : null}
          <div className="auth-password">
            <FormField id="login-password" name="password" label={t("password")} type={showPassword ? "text" : "password"}
              autoComplete={mode === "signup" ? "new-password" : "current-password"} className="live-name-input" value={password}
              onChange={(event) => { setPassword(event.target.value); setError(""); }}
              onBlur={() => { if (mode === "signup") setFieldErrors((current) => ({ ...current, password: password.length < 8 ? "passwordTooShort" : undefined })); }}
              disabled={submitting} required />
            <button type="button" className="auth-password-toggle" aria-pressed={showPassword} aria-label={t(showPassword ? "hidePassword" : "showPassword")}
              onClick={() => setShowPassword((value) => !value)} disabled={submitting}>
              <EyeIcon hidden={showPassword} />
            </button>
          </div>
          {fieldErrors.password ? <FormError>{t(fieldErrors.password)}</FormError> : null}
          {error ? <FormError>{error}</FormError> : null}
          {retrySeconds > 0 ? (
            <p id="login-retry-status" className="auth-notice" role="timer" aria-live="off" aria-label={t("retryStatusLabel")}>{t("retryIn", { seconds: retrySeconds })}</p>
          ) : retryUntil > 0 ? (
            <p id="login-retry-status" className="auth-notice" role="status">{t("retryReady")}</p>
          ) : null}
          <FormButton type="submit" className="auth-button auth-submit" data-auth-action="submit" disabled={submitting || retrySeconds > 0}
            aria-describedby={retryUntil > 0 ? "login-retry-status" : undefined}>
            {t(mode === "signup" ? (submitting ? "signingUp" : "signUpSubmit") : submitting ? "signingIn" : "signIn")}
          </FormButton>
        </form>
        <div className="auth-links">
          <button type="button" onClick={switchMode} disabled={submitting}>{t(mode === "signup" ? "backToSignIn" : "signUp")}</button>
          {mode === "signin" ? <button type="button" onClick={() => void resetPassword()} disabled={submitting}>{t("resetPassword")}</button> : null}
        </div>
      </section>
    </AuthShell>
  );
}
