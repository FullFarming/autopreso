import { liveModelPreferencesSchema } from "../live/model-preferences";
import { z } from "zod";

import { LANGUAGE_CODES, normalizeLanguageCode } from "../languageDetect";
import { joinConsentInputSchema } from "./live-consent-validation";
import { canonicalizeParticipantEmail } from "./participant-identity";

const SESSION_TYPES = ["presentation", "meeting"] as const;
// New and edited Live Calls are captions-only. These two schemas remain only
// for one-release request compatibility; callers should omit both fields.
const OUTPUT_MODES = ["captions"] as const;
const VOICE_PROVIDERS = ["gemini"] as const;
const GLOSSARY_PACKS = ["general_cre", "hotel", "fnb"] as const;
const LIVE_EVENT_TYPES = ["earnings_call", "investor_day", "conference", "other"] as const;
const LIVE_SESSION_SECTIONS = ["prepared_remarks", "qa", "other"] as const;
const PII_LIKE_PATTERN = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/u;

const languageSchema = z.preprocess(
  (value) => normalizeLanguageCode(value),
  z.enum(LANGUAGE_CODES),
);

export const sessionTypeInputSchema = z.enum(SESSION_TYPES);
export const outputModeInputSchema = z.enum(OUTPUT_MODES);
export const voiceProviderInputSchema = z.enum(VOICE_PROVIDERS);
export const glossaryPackInputSchema = z.enum(GLOSSARY_PACKS);
export const liveEventTypeInputSchema = z.enum(LIVE_EVENT_TYPES);
export const liveSessionSectionInputSchema = z.enum(LIVE_SESSION_SECTIONS);

const languagesInputSchema = z
  .array(languageSchema)
  .min(1)
  .max(3)
  .refine((languages) => new Set(languages).size === languages.length);

const liveTitleInputSchema = z
  .string()
  .transform((value) => value.normalize("NFC").replace(/\p{Cc}|\p{Cf}/gu, "").replace(/\s+/gu, " ").trim())
  .refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= 120 && !/[<>]/u.test(value));

const scheduledAtInputSchema = z.iso.datetime({ offset: true }).nullable();

function publicMetadataSchema(maximumLength: number) {
  return z
    .string()
    .nullable()
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (value === null) return null;
      return value.normalize("NFC").replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ").trim();
    })
    .refine((value) => value === undefined
      || value === null
      || (Array.from(value).length >= 1 && Array.from(value).length <= maximumLength && !/[<>]/u.test(value) && !PII_LIKE_PATTERN.test(value)));
}

const tickerInputSchema = z
  .string()
  .nullable()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return value.normalize("NFC").replace(/\s+/gu, "").toUpperCase();
  })
  .refine((value) => value === undefined || value === null || /^[A-Z0-9.-]{1,12}$/u.test(value));

const agendaInputSchema = z
  .array(z.string()
    .transform((value) => value.normalize("NFC").replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ").trim())
    .refine((value) => Array.from(value).length >= 1
      && Array.from(value).length <= 120
      && !/[<>]/u.test(value)
      && !PII_LIKE_PATTERN.test(value)))
  .max(20)
  .optional();

export const createLiveSessionInputSchema = z
  .object({
    title: liveTitleInputSchema.default("Live Session"),
    scheduledAt: scheduledAtInputSchema.default(null),
    sessionType: sessionTypeInputSchema,
    outputMode: outputModeInputSchema.optional(),
    voiceProvider: voiceProviderInputSchema.optional(),
    // Deprecated selector: nothing reads it at runtime (session terminology is
    // pinned glossaries). Optional so new clients can stop sending it; the
    // service still defaults it to "general_cre" for the DB column.
    glossaryPack: glossaryPackInputSchema.optional(),
    languages: languagesInputSchema,
    maxViewers: z.number().int().min(1).max(200).default(200),
    participantSpeakingEnabled: z.boolean().default(false),
    companyName: publicMetadataSchema(160),
    ticker: tickerInputSchema,
    fiscalPeriod: publicMetadataSchema(80),
    eventType: liveEventTypeInputSchema.nullable().optional(),
    agenda: agendaInputSchema,
    modelPreferences: liveModelPreferencesSchema.optional(),
  })
  .strict();

export const updateLiveSessionInputSchema = z
  .object({
    version: z.number().int().safe().min(1),
    title: liveTitleInputSchema.optional(),
    scheduledAt: scheduledAtInputSchema.optional(),
    sessionType: sessionTypeInputSchema.optional(),
    outputMode: outputModeInputSchema.optional(),
    voiceProvider: voiceProviderInputSchema.optional(),
    glossaryPack: glossaryPackInputSchema.optional(),
    languages: languagesInputSchema.optional(),
    maxViewers: z.number().int().min(1).max(200).optional(),
    participantSpeakingEnabled: z.boolean().optional(),
    companyName: publicMetadataSchema(160),
    ticker: tickerInputSchema,
    fiscalPeriod: publicMetadataSchema(80),
    eventType: liveEventTypeInputSchema.nullable().optional(),
    agenda: agendaInputSchema,
    modelPreferences: liveModelPreferencesSchema.optional(),
  })
  .strict()
  .refine(
    (input) => input.sessionType !== undefined
      || input.title !== undefined
      || input.scheduledAt !== undefined
      || input.outputMode !== undefined
      || input.voiceProvider !== undefined
      || input.glossaryPack !== undefined
      || input.languages !== undefined
      || input.maxViewers !== undefined
      || input.participantSpeakingEnabled !== undefined
      || input.companyName !== undefined
      || input.ticker !== undefined
      || input.fiscalPeriod !== undefined
      || input.eventType !== undefined
      || input.agenda !== undefined
      || input.modelPreferences !== undefined,
    { message: "변경할 라이브 설정이 필요합니다." },
  );

export const admissionActionInputSchema = z
  .object({
    action: z.enum(["open", "close"]),
    version: z.number().int().safe().min(1),
  })
  .strict();

export const startLiveSessionInputSchema = z.object({
  version: z.number().int().safe().min(1),
}).strict();

export const restoreLiveSessionInputSchema = z.object({
  version: z.number().int().min(1).max(2_147_483_646),
}).strict();

export const liveSessionRecoveryQuerySchema = z.object({
  scope: z.literal("mine"),
  offset: z.string().regex(/^(?:0|[1-9][0-9]{0,6})$/u).transform(Number)
    .refine((offset) => offset <= 1_000_000).default(0),
}).strict();

export const sectionTransitionInputSchema = z.object({
  version: z.number().int().safe().min(1),
  section: liveSessionSectionInputSchema,
  transitionKey: z.string()
    .transform((value) => value.normalize("NFC").replace(/\p{Cc}/gu, "").replace(/\p{Cf}/gu, "").trim())
    .refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= 256 && !/[<>]/u.test(value)),
  sourceSeq: z.number().int().safe().min(0).nullable().optional(),
}).strict();

export const createLiveInviteInputSchema = z.object({ action: z.enum(["create", "read-if-open"]) }).strict();

export function sanitizeViewerDisplayName(value: string): string {
  return value
    .normalize("NFC")
    .replace(/<[^>]*>/gu, " ")
    .replace(/[<>]/gu, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeParticipantProfile(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function participantProfileSchema(maximumLength: number) {
  return z
    .string()
    .default("")
    .transform(normalizeParticipantProfile)
    .refine((value) => Array.from(value).length <= maximumLength && !/[<>]/u.test(value));
}

const participantEmailSchema = z.string().transform((value, context) => {
  try {
    return canonicalizeParticipantEmail(value);
  } catch {
    context.addIssue({ code: "custom", message: "이메일 형식이 올바르지 않습니다." });
    return z.NEVER;
  }
});

const viewerDisplayNameSchema = z
  .string()
  .transform(sanitizeViewerDisplayName)
  .refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= 40);

const participantCompanySchema = participantProfileSchema(100);
const participantDepartmentSchema = participantProfileSchema(80);
const participantJobTitleSchema = participantProfileSchema(100);
const participantDisplayNameSchema = z
  .string()
  .refine((value) => !/[<>]/u.test(value))
  .transform(sanitizeViewerDisplayName)
  .refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= 40);

export const hostLoginInputSchema = z
  .object({
    id: z.string().min(1).max(128),
    password: z.string().min(1).max(256),
    name: viewerDisplayNameSchema.optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    name: input.name ?? (Array.from(sanitizeViewerDisplayName(input.id)).slice(0, 40).join("") || "관리자"),
  }));

export const joinLiveSessionInputSchema = z
  .object({
    inviteToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),
    accessCode: z.string().regex(/^[0-9]{6}$/u).optional(),
    email: participantEmailSchema,
    displayName: participantDisplayNameSchema,
    company: participantCompanySchema,
    department: participantDepartmentSchema,
    jobTitle: participantJobTitleSchema,
    privacyConsent: joinConsentInputSchema.shape.privacyConsent,
    summaryConsent: joinConsentInputSchema.shape.summaryConsent,
    marketingConsent: joinConsentInputSchema.shape.marketingConsent,
    consentNoticeVersions: joinConsentInputSchema.shape.consentNoticeVersions,
    deviceId: z.string().min(16).max(128),
    accessToken: z.string().min(20).max(8192),
  })
  .strict()
  .refine(
    (input) => Number(input.inviteToken !== undefined) + Number(input.accessCode !== undefined) === 1,
    { message: "QR 초대 또는 인증번호 중 하나만 필요합니다." },
  );

export const liveLanguageInputSchema = languageSchema;
