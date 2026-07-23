import { z } from "zod";

import { LANGUAGE_CODES, normalizeLanguageCode } from "../languageDetect";

const SESSION_TYPES = ["presentation", "meeting"] as const;
const OUTPUT_MODES = ["captions", "captions_audio", "audio"] as const;
const VOICE_PROVIDERS = ["gemini", "openai"] as const;
const GLOSSARY_PACKS = ["general_cre", "hotel", "fnb"] as const;

const languageSchema = z.preprocess(
  (value) => normalizeLanguageCode(value),
  z.enum(LANGUAGE_CODES),
);

export const sessionTypeInputSchema = z.enum(SESSION_TYPES);
export const outputModeInputSchema = z.enum(OUTPUT_MODES);
export const voiceProviderInputSchema = z.enum(VOICE_PROVIDERS);
export const glossaryPackInputSchema = z.enum(GLOSSARY_PACKS);

const languagesInputSchema = z
  .array(languageSchema)
  .min(1)
  .max(3)
  .refine((languages) => new Set(languages).size === languages.length);

export const createLiveSessionInputSchema = z
  .object({
    sessionType: sessionTypeInputSchema,
    outputMode: outputModeInputSchema,
    voiceProvider: voiceProviderInputSchema.default("gemini"),
    glossaryPack: glossaryPackInputSchema,
    languages: languagesInputSchema,
    maxViewers: z.number().int().min(1).max(50).default(50),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.voiceProvider === "openai" && input.sessionType !== "presentation") {
      context.addIssue({ code: "custom", path: ["voiceProvider"], message: "OpenAI 음성은 프레젠테이션 모드에서만 사용할 수 있습니다." });
    }
    if (input.voiceProvider === "openai" && input.outputMode === "captions") {
      context.addIssue({ code: "custom", path: ["voiceProvider"], message: "음성 출력 모드에서만 OpenAI 음성을 선택할 수 있습니다." });
    }
  });

export const updateLiveSessionInputSchema = z
  .object({
    version: z.number().int().safe().min(1),
    sessionType: sessionTypeInputSchema.optional(),
    outputMode: outputModeInputSchema.optional(),
    voiceProvider: voiceProviderInputSchema.optional(),
    glossaryPack: glossaryPackInputSchema.optional(),
    languages: languagesInputSchema.optional(),
    maxViewers: z.number().int().min(1).max(50).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.voiceProvider === "openai" && input.sessionType === "meeting") {
      context.addIssue({ code: "custom", path: ["voiceProvider"], message: "OpenAI 음성은 프레젠테이션 모드에서만 사용할 수 있습니다." });
    }
    if (input.voiceProvider === "openai" && input.outputMode === "captions") {
      context.addIssue({ code: "custom", path: ["voiceProvider"], message: "음성 출력 모드에서만 OpenAI 음성을 선택할 수 있습니다." });
    }
  })
  .refine(
    (input) => input.sessionType !== undefined
      || input.outputMode !== undefined
      || input.voiceProvider !== undefined
      || input.glossaryPack !== undefined
      || input.languages !== undefined
      || input.maxViewers !== undefined,
    { message: "변경할 라이브 설정이 필요합니다." },
  );

export const admissionActionInputSchema = z
  .object({
    action: z.enum(["open", "close"]),
    version: z.number().int().safe().min(1),
  })
  .strict();

export const createLiveInviteInputSchema = z.object({ action: z.literal("create") }).strict();

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

const viewerDisplayNameSchema = z
  .string()
  .transform(sanitizeViewerDisplayName)
  .refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= 40);

export const hostLoginInputSchema = z
  .object({
    id: z.string().min(1).max(128),
    password: z.string().min(1).max(256),
    name: viewerDisplayNameSchema,
  })
  .strict();

export const joinLiveSessionInputSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/u).optional(),
    inviteToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),
    displayName: viewerDisplayNameSchema,
    deviceId: z.string().min(16).max(128),
    accessToken: z.string().min(20).max(8192),
  })
  .strict()
  .refine((input) => Number(input.code !== undefined) + Number(input.inviteToken !== undefined) === 1);

export const liveLanguageInputSchema = languageSchema;
