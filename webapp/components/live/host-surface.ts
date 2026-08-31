import type {
  LiveHostParticipantActivity,
  LiveSession,
  LiveSessionStatus,
} from "@/lib/live-contract";

export type HostSurface = "setup" | "invite" | "live" | "ended";

export interface HostSurfaceState {
  hasSession: boolean;
  hasEndedSession: boolean;
  isEditingSession: boolean;
  sessionStatus: LiveSessionStatus | null;
}

export function resolveHostSurface(state: HostSurfaceState): HostSurface {
  if (state.hasEndedSession && !state.hasSession) return "ended";
  if (!state.hasSession || state.isEditingSession) return "setup";
  if (state.sessionStatus === "live" || state.sessionStatus === "paused") return "live";
  return "invite";
}

export function mergePolledHostSession(
  current: LiveSession | null,
  latest: LiveSession,
): LiveSession | null {
  if (!current || current.id !== latest.id) return current;
  const merged: LiveSession = {
    ...current,
    ...latest,
    languages: [...latest.languages],
    version: latest.version,
  };
  // Identity-stable merge: 폴링마다 새 객체를 돌려주면 session을 의존하는
  // 이펙트(스테이지 BroadcastChannel 재브로드캐스트 등)가 5초마다 재실행돼
  // 스테이지가 이중 폴링을 했다. 내용이 같으면 기존 참조를 유지한다.
  if (JSON.stringify(merged) === JSON.stringify(current)) return current;
  return merged;
}

export function buildHostInviteShareText(input: {
  url: string;
  admissionCode: string;
  expiresAtLabel: string;
}): string {
  return [
    "아래 링크로 NOVA 라이브에 참여하세요.",
    "",
    input.url,
    "",
    `인증 코드: ${input.admissionCode}`,
    `초대 유효 시간: ${input.expiresAtLabel}`,
  ].join("\n");
}

export function resolveHostParticipantPresentation(
  participant: LiveHostParticipantActivity,
): {
  identity: string;
  company: string;
  department: string;
  jobTitle: string;
  hasSummaryConsent: boolean;
} {
  return {
    identity: participant.email ?? participant.displayName,
    company: participant.company || "—",
    department: participant.department || "—",
    jobTitle: participant.jobTitle || "—",
    hasSummaryConsent: participant.summaryConsentAt !== null,
  };
}
