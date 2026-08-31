export interface HostInvitation {
  sessionId: string;
  url: string;
  admissionCode: string;
  expiresAt: string;
}

export function hasOpenStageAdmission(
  session: { status: string; admissionOpenUntil: string | null } | null,
  now: number,
): boolean {
  return Boolean(session && ["preparing", "live", "paused"].includes(session.status)
    && session.admissionOpenUntil && Date.parse(session.admissionOpenUntil) > now);
}

export function getCurrentHostInvite(
  invite: HostInvitation | null,
  session: { id: string; status: string; admissionOpenUntil: string | null } | null,
  admission: { code: string; openUntil: string } | null,
  now: number,
): HostInvitation | null {
  if (!invite || !session || !admission || session.id !== invite.sessionId
    || !hasOpenStageAdmission(session, now)
    || !/^[0-9]{6}$/u.test(invite.admissionCode)
    || admission.code !== invite.admissionCode
    || Date.parse(admission.openUntil) !== Date.parse(invite.expiresAt)
    || Date.parse(session.admissionOpenUntil ?? "") !== Date.parse(invite.expiresAt)
    || !(Date.parse(invite.expiresAt) > now)) return null;
  return invite;
}

export function getCurrentStageInvite(
  invite: HostInvitation | null,
  session: { id: string; status: string; admissionOpenUntil: string | null } | null,
  now: number,
): HostInvitation | null {
  return getCurrentHostInvite(invite, session, invite && session?.admissionOpenUntil
    ? { code: invite.admissionCode, openUntil: session.admissionOpenUntil } : null, now);
}

interface InvitationBrowser {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  clipboard?: { writeText: (value: string) => Promise<void> };
}

export async function shareHostInvitation(
  mode: "share" | "copy",
  text: string,
  browser: InvitationBrowser,
): Promise<"shared" | "copied" | "copied-unsupported" | "cancelled"> {
  const data = { title: "NOVA 라이브 초대", text };
  if (mode === "share" && browser.share && (!browser.canShare || browser.canShare(data))) {
    try {
      await browser.share(data);
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
      throw error;
    }
  }
  if (!browser.clipboard) throw new Error("이 브라우저에서는 복사할 수 없습니다. 이메일로 초대를 이용해 주세요.");
  await browser.clipboard.writeText(text);
  return mode === "share" ? "copied-unsupported" : "copied";
}
