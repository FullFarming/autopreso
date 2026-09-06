import { z } from "zod";

export const CONSENT_NOTICE_VERSION_MAX_CODEPOINTS = 64;

const NOTICE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

export class LiveConsentValidationError extends Error {
  readonly code = "INVALID_CONSENT_INPUT";
  readonly status = 400;

  constructor(message = "동의 정보가 올바르지 않습니다.") {
    super(message);
    this.name = "LiveConsentValidationError";
  }
}

export function normalizeConsentNoticeVersion(value: string): string {
  if (typeof value !== "string") throw new LiveConsentValidationError();
  const normalized = value.normalize("NFC").trim();
  const codepointLength = Array.from(normalized).length;
  if (codepointLength < 1
    || codepointLength > CONSENT_NOTICE_VERSION_MAX_CODEPOINTS
    || !NOTICE_VERSION_PATTERN.test(normalized)) {
    throw new LiveConsentValidationError("동의 안내 버전이 올바르지 않습니다.");
  }
  return normalized;
}

export const consentNoticeVersionInputSchema = z.string().transform((value, context) => {
  try {
    return normalizeConsentNoticeVersion(value);
  } catch (error: unknown) {
    context.addIssue({
      code: "custom",
      message: error instanceof LiveConsentValidationError ? error.message : "동의 안내 버전이 올바르지 않습니다.",
    });
    return z.NEVER;
  }
});

export const joinConsentInputSchema = z.object({
  privacyConsent: z.literal(true),
  summaryConsent: z.boolean(),
  marketingConsent: z.boolean(),
  consentNoticeVersions: z.object({
    privacy: consentNoticeVersionInputSchema,
    summaryDelivery: consentNoticeVersionInputSchema,
    marketing: consentNoticeVersionInputSchema,
  }).strict(),
}).strict();

export const participantConsentUpdateInputSchema = z.object({
  summaryConsent: z.boolean(),
  marketingConsent: z.boolean(),
  consentNoticeVersions: z.object({
    summaryDelivery: consentNoticeVersionInputSchema,
    marketing: consentNoticeVersionInputSchema,
  }).strict(),
}).strict();

export type OptionalConsentPurpose = "summaryDelivery" | "marketing";
export type OptionalConsentState = Readonly<{
  accepted: boolean;
  noticeVersion: string;
}>;
export type OptionalConsentAuditTransition = Readonly<{
  purpose: OptionalConsentPurpose;
  accepted: boolean;
  noticeVersion: string;
  transition: "granted" | "withdrawn";
}>;

export function createOptionalConsentAuditTransitions(
  current: Readonly<Record<OptionalConsentPurpose, OptionalConsentState>>,
  next: z.infer<typeof participantConsentUpdateInputSchema>,
): readonly OptionalConsentAuditTransition[] {
  const candidates = [
    {
      purpose: "summaryDelivery" as const,
      accepted: next.summaryConsent,
      noticeVersion: next.consentNoticeVersions.summaryDelivery,
    },
    {
      purpose: "marketing" as const,
      accepted: next.marketingConsent,
      noticeVersion: next.consentNoticeVersions.marketing,
    },
  ];
  return candidates.flatMap((candidate) => {
    const prior = current[candidate.purpose];
    const hasAcceptanceChanged = prior.accepted !== candidate.accepted;
    const hasAcceptedNoticeChanged = candidate.accepted && prior.noticeVersion !== candidate.noticeVersion;
    if (!hasAcceptanceChanged && !hasAcceptedNoticeChanged) return [];
    return [{
      ...candidate,
      transition: candidate.accepted ? "granted" as const : "withdrawn" as const,
    }];
  });
}
