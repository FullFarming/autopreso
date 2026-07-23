"use client";

import { useEffect, useState } from "react";

export default function LoginPage() {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
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

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, password, name }),
      });
      if (response.ok) {
        // A document navigation makes middleware validate the newly issued
        // httpOnly cookie before the protected host screen is rendered.
        window.location.assign("/");
        return;
      }
      const data: unknown = await response.json().catch(() => null);
      const message = data && typeof data === "object" && "error" in data
        && typeof data.error === "string"
        ? data.error
        : "로그인에 실패했습니다.";
      setError(message);
    } catch {
      setError("서버에 연결할 수 없습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center px-4">
      <div className="glass-strong w-full max-w-sm p-8">
        <h1 className="display mb-1 text-3xl">Realtime Noel</h1>
        <p className="mb-6 text-sm text-cw-grey75">실시간 번역 자막 — 사내용</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="login-name" className="mb-1 block text-sm font-medium text-cw-grey75">이름 (자막에 표시될 이름)</label>
            <input id="login-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="예: Noel" required className="glass-input" />
          </div>
          <div>
            <label htmlFor="login-id" className="mb-1 block text-sm font-medium text-cw-grey75">아이디</label>
            <input id="login-id" type="text" autoComplete="username" value={id} onChange={(event) => setId(event.target.value)} className="glass-input" required />
          </div>
          <div>
            <label htmlFor="login-password" className="mb-1 block text-sm font-medium text-cw-grey75">비밀번호</label>
            <input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="glass-input" required />
          </div>
          {error ? (
            <div className="rounded-2xl border border-cw-darkRed/20 bg-cw-darkRedTint px-4 py-2 text-sm text-cw-darkRed">{error}</div>
          ) : null}
          <button type="submit" disabled={submitting} className="accent-btn w-full px-4 py-3 text-base font-semibold disabled:opacity-60">
            {submitting ? "확인 중…" : "로그인"}
          </button>
        </form>
      </div>
      <p className="mt-6 text-xs text-cw-grey50">사내용 — 외부 공유 금지</p>
    </main>
  );
}
