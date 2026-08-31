const EMAIL_MAX_LENGTH = 254;
const EMAIL_LOCAL_PART_MAX_LENGTH = 64;
const EMAIL_DOMAIN_MAX_LENGTH = 253;
const EMAIL_DOMAIN_LABEL_MAX_LENGTH = 63;
const PARTICIPANT_LABEL_MAX_LENGTH = 40;
const TRUNCATED_DOMAIN_LENGTH = 34;
const EMAIL_LOCAL_ATOM_PATTERN = /^[A-Za-z0-9\u00C0-\u02AF\u0300-\u036F\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3.!#$%&'*+\/=?^_`{|}~-]+$/u;
const EMAIL_DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9\u00C0-\u02AF\u0300-\u036F\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3-]+$/u;

export class ParticipantIdentityError extends Error {
  constructor() {
    super("참여자 이메일 형식이 올바르지 않습니다.");
    this.name = "ParticipantIdentityError";
  }
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function canonicalizeParticipantEmail(value: string): string {
  const email = value.normalize("NFC").trim().toLocaleLowerCase("en-US");
  if (codePointLength(email) < 3
    || codePointLength(email) > EMAIL_MAX_LENGTH
    || /[\s<>\p{Cc}\p{Cf}]/u.test(email)) {
    throw new ParticipantIdentityError();
  }

  const parts = email.split("@");
  if (parts.length !== 2) throw new ParticipantIdentityError();
  const [localPart, domain] = parts;
  if (!localPart
    || codePointLength(localPart) > EMAIL_LOCAL_PART_MAX_LENGTH
    || localPart.startsWith(".")
    || localPart.endsWith(".")
    || localPart.includes("..")
    || !EMAIL_LOCAL_ATOM_PATTERN.test(localPart)) {
    throw new ParticipantIdentityError();
  }
  if (!domain || codePointLength(domain) > EMAIL_DOMAIN_MAX_LENGTH) {
    throw new ParticipantIdentityError();
  }
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !label
    || codePointLength(label) > EMAIL_DOMAIN_LABEL_MAX_LENGTH
    || label.startsWith("-")
    || label.endsWith("-")
    || !EMAIL_DOMAIN_LABEL_PATTERN.test(label))) {
    throw new ParticipantIdentityError();
  }
  return email;
}

export function maskParticipantEmail(value: string): string {
  const email = canonicalizeParticipantEmail(value);
  const separator = email.lastIndexOf("@");
  const localPart = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const [firstCodePoint] = Array.from(localPart);
  if (!firstCodePoint) throw new ParticipantIdentityError();
  const prefix = `${firstCodePoint}***@`;
  const fullMask = `${prefix}${domain}`;
  if (codePointLength(fullMask) <= PARTICIPANT_LABEL_MAX_LENGTH) return fullMask;
  return `${prefix}${Array.from(domain).slice(0, TRUNCATED_DOMAIN_LENGTH).join("")}…`;
}

export interface ParticipantVisibleIdentity {
  readonly displayName: string;
}

export function createParticipantVisibleIdentity(email: string): ParticipantVisibleIdentity {
  return { displayName: maskParticipantEmail(email) };
}
