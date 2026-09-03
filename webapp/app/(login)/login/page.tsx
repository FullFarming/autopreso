"use client";

import { useEffect } from "react";

import { LoginCard } from "@/components/auth/LoginCard";

export default function LoginPage() {
  useEffect(() => {
    // Old desktop pairing links carried pair/sig/exp; strip them so a stale
    // bookmark does not keep a dead signature in the address bar.
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

  return <LoginCard />;
}
