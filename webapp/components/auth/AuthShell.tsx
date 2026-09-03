"use client";

import type { ReactNode } from "react";

// The two-column lobby shared by /login, /auth/callback, and /pending: brand and
// title on the left, the caller's card `<section>` on the right. The card is
// left to the caller so each page owns its own aria-label and content order.
export function AuthShell({ title, lede, aside, children }: { title: string; lede: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <main className="live-viewer-shell is-join live-login-shell">
      <div className="live-join-lobby">
        <section className="live-join-context" aria-labelledby="live-login-title">
          <header className="live-join-brand"><span className="live-join-wordmark">NOVA</span></header>
          <div className="live-join-context-body">
            <h1 id="live-login-title" className="live-join-heading">{title}</h1>
            <p className="live-join-lede">{lede}</p>
          </div>
          {aside}
          <footer className="live-join-credit">Realtime by Noel</footer>
        </section>
        {children}
      </div>
    </main>
  );
}
