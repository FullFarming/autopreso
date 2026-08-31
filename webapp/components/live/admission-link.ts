const admissionCodePattern = /^[0-9]{6}$/u;
const inviteTokenPattern = /^[A-Za-z0-9_-]{43}$/u;

export type AdmissionLinkFragment =
  | { kind: "none" | "invalid"; canonicalHash: "" }
  | { kind: "code"; accessCode: string; canonicalHash: string }
  | { kind: "invite"; inviteToken: string; canonicalHash: string };

/** @throws 참여 코드가 6자리 ASCII 숫자가 아니거나 origin이 HTTP(S) 출처가 아닌 경우. */
export function buildAdmissionJoinUrl(origin: string, accessCode: string): string {
  if (typeof accessCode !== "string" || !admissionCodePattern.test(accessCode)) throw new Error("INVALID_ADMISSION_CODE");
  const base = new URL(origin);
  if (!["https:", "http:"].includes(base.protocol) || (origin !== base.origin && origin !== `${base.origin}/`)) {
    throw new Error("INVALID_ADMISSION_ORIGIN");
  }
  return `${base.origin}/m/watch#code=${accessCode}`;
}

export function parseAdmissionLinkHash(hash: string): AdmissionLinkFragment {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const invites = params.getAll("invite");
  const codes = params.getAll("code");
  if (invites.length > 1 || codes.length > 1) return { kind: "invalid", canonicalHash: "" };
  // 2026-08-31 fix: 기존 QR 초대가 있으면 코드로 인증 방식을 바꾸지 않는다.
  // 잘못된 초대도 코드로 우회하지 않고, 공유할 fragment에는 선택된 자격만 남긴다.
  if (invites.length === 1) {
    const inviteToken = invites[0];
    return inviteTokenPattern.test(inviteToken)
      ? { kind: "invite", inviteToken, canonicalHash: `#invite=${inviteToken}` }
      : { kind: "invalid", canonicalHash: "" };
  }
  if (codes.length === 1) {
    const accessCode = codes[0];
    return admissionCodePattern.test(accessCode)
      ? { kind: "code", accessCode, canonicalHash: `#code=${accessCode}` }
      : { kind: "invalid", canonicalHash: "" };
  }
  return { kind: "none", canonicalHash: "" };
}
