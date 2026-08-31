"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages } from "@/lib/system-language/records-messages";

import { useEffect, useRef, useState } from "react";

import { FormButton, FormError, FormField } from "@/components/ui/FormControls";
import { getLoginRetryDeadline, getLoginRetrySeconds } from "./login-retry";

export default function LoginPage() {
  const t = useSystemText(recordsMessages);
  const [id, setId] = useState("");
  useEffect(() => {
    const url = new URL(window.location.href);
    const hasLegacyPairingParameters = ["pair", "sig", "exp"].some((parameter) =>
      url.searchParams.has(parameter),
    );
    if (!hasLegacyPairingParameters) return;

    url.searchParams.delete("pair");
    url.searchParams.delete("sig");
    url.searchParams.delete("exp");
    const search = url.searchParams.toString();
    window.history.replaceState(null, "", `${url.pathname}${search ? `?${search}` : ""}${url.hash}`);
  }, []);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [retryUntil, setRetryUntil] = useState(0);
  const [clock, setClock] = useState(Date.now);
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

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submissionRef.current || retryUntilRef.current > Date.now()) return;
    const controller = new AbortController();
    submissionRef.current = controller;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, password }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (response.ok) {
        setPassword("");
        // A document navigation makes middleware validate the newly issued
        // httpOnly cookie before the protected host screen is rendered.
        window.location.assign("/admin");
        return;
      }
      await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (response.status === 429) {
        const now = Date.now();
        const deadline = getLoginRetryDeadline(response.headers.get("Retry-After"), now) ?? 0;
        retryUntilRef.current = deadline;
        setRetryUntil(deadline);
        setClock(now);
      }
      setError(response.status === 429
        ? "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요."
        : "사용자 ID와 비밀번호를 확인해 주세요.");
    } catch {
      if (!controller.signal.aborted) setError("서버에 연결할 수 없습니다.");
    } finally {
      if (submissionRef.current === controller) submissionRef.current = null;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  return (
    <main className="live-viewer-shell is-join live-login-shell">
      <div className="live-join-lobby">
        <section className="live-join-context" aria-labelledby="live-login-title">
          <header className="live-join-brand"><span className="live-join-wordmark">NOVA</span></header>
          <div className="live-join-context-body">
            <h1 id="live-login-title" className="live-join-heading">{t("관리자 로그인")}</h1>
            <p className="live-join-lede">{t("라이브 세션을 만들고 참여자를 초대하세요.")}</p>
          </div>
          <p className="live-join-admin live-login-role-switch">
            {t("참가자이신가요?")} <a href="/watch">{t("참가자로 입장")}</a>
          </p>
          <footer className="live-join-credit">Realtime by Noel</footer>
        </section>
        <section className="live-join-card live-login-card" aria-label={t("관리자 로그인 정보 입력")}>
          <form onSubmit={handleSubmit} className="live-login-form" aria-label={t("관리자(호스트) 로그인")} aria-busy={submitting}>
            <FormField id="login-id" name="id" label={t("아이디")} type="text" autoComplete="username"
              className="live-name-input" autoCapitalize="none" spellCheck={false}
              value={id} onChange={(event) => { setId(event.target.value); setError(""); }} disabled={submitting} required />
            <FormField id="login-password" name="password" label={t("비밀번호")} type="password" autoComplete="current-password"
              className="live-name-input"
              value={password} onChange={(event) => { setPassword(event.target.value); setError(""); }} disabled={submitting} required />
            {error ? <FormError>{t(error)}</FormError> : null}
            {retrySeconds > 0 ? <p id="login-retry-status" role="timer" aria-live="off" aria-label={t("다시 시도까지 남은 시간")}>
              {t("{seconds}초 후 다시 로그인할 수 있습니다.", { seconds: retrySeconds })}
            </p> : retryUntil > 0 ? <p id="login-retry-status" role="status">{t("다시 로그인할 수 있습니다. 로그인 버튼을 눌러 주세요.")}</p> : null}
            <FormButton type="submit" className="live-primary-action" disabled={submitting || retrySeconds > 0}
              aria-describedby={retryUntil > 0 ? "login-retry-status" : undefined}>
              {t(submitting ? "로그인 중…" : "로그인")}
            </FormButton>
          </form>
        </section>
      </div>
    </main>
  );
}
