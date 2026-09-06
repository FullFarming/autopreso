import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { ConsoleShell } from "@/components/console/ConsoleShell";
import { AuthenticationError, AuthorizationError } from "@/lib/auth/live-auth";
import { requireAdminFromCookieValue } from "@/lib/auth/require-admin";
import { getConsoleStore } from "@/lib/console/console-store";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

// The console guard lives here rather than in middleware (plan deviation 1): middleware keeps
// its cookie-only gate, and this server component does the one Supabase round-trip per page.
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  let email = "";
  try {
    const { profile } = await requireAdminFromCookieValue((await cookies()).get(SESSION_COOKIE)?.value);
    email = profile.email;
  } catch (error: unknown) {
    if (error instanceof AuthorizationError) redirect("/admin");
    if (error instanceof AuthenticationError) redirect("/login");
    throw error;
  }
  // The rail badge seed; a store hiccup must not take the whole console down, so it degrades to no badge.
  let initialPendingCount: number | null = null;
  try { initialPendingCount = await getConsoleStore().countPending(); } catch { initialPendingCount = null; }
  return <ConsoleShell email={email} initialPendingCount={initialPendingCount}>{children}</ConsoleShell>;
}
