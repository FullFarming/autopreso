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
      await response.json().catch(() => null);
      setError(response.status === 429
        ? "Too many sign-in attempts. Please wait and try again."
        : "Check your user ID and password.");
    } catch {
      setError("Unable to connect to the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center px-4">
      <div className="glass-strong w-full max-w-sm p-8">
        <h1 className="display mb-1 text-3xl">Realtime Noel</h1>
        <p className="mb-6 text-sm text-cw-grey75">Live translated captions for your team</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="login-name" className="mb-1 block text-sm font-medium text-cw-grey75">Display name</label>
            <input id="login-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Noel" required className="glass-input" />
          </div>
          <div>
            <label htmlFor="login-id" className="mb-1 block text-sm font-medium text-cw-grey75">User ID</label>
            <input id="login-id" type="text" autoComplete="username" value={id} onChange={(event) => setId(event.target.value)} className="glass-input" required />
          </div>
          <div>
            <label htmlFor="login-password" className="mb-1 block text-sm font-medium text-cw-grey75">Password</label>
            <input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="glass-input" required />
          </div>
          {error ? (
            <div className="rounded-2xl border border-cw-darkRed/20 bg-cw-darkRedTint px-4 py-2 text-sm text-cw-darkRed">{error}</div>
          ) : null}
          <button type="submit" disabled={submitting} className="accent-btn w-full px-4 py-3 text-base font-semibold disabled:opacity-60">
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
      <p className="mt-6 text-xs text-cw-grey50">Internal access only</p>
    </main>
  );
}
