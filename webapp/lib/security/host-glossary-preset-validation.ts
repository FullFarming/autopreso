import { z } from "zod";

import { LANGUAGE_CODES, normalizeLanguageCode } from "../languageDetect";

export const MAX_GLOSSARY_PRESET_NAME_CHARS = 80;
export const MAX_GLOSSARY_PRESET_DOMAIN_CHARS = 600;
export const MAX_GLOSSARY_PRESET_GLOSSARY_CHARS = 16_000;
export const MAX_GLOSSARY_PRESETS_PER_HOST = 50;

const disallowedSingleLineCharacters = /[<>]|\p{Cc}|\p{Cf}/u;
const disallowedGlossaryCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\p{Cf}/u;

function normalizeNfcAndTrim(value: string): string {
  return value.normalize("NFC").trim();
}

function hasLengthBetween(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

const languageSchema = z.preprocess(
  (value) => normalizeLanguageCode(value),
  z.enum(LANGUAGE_CODES),
);
const presetVersionSchema = z.number().int().min(1).max(2_147_483_647);

export const hostGlossaryPresetHostIdSchema = z
  .string()
  .transform(normalizeNfcAndTrim)
  .refine((value) => hasLengthBetween(value, 1, 100) && !disallowedSingleLineCharacters.test(value));

export const glossaryPresetIdSchema = z.string().uuid();

const presetNameSchema = z
  .string()
  .transform(normalizeNfcAndTrim)
  .refine((value) => hasLengthBetween(value, 1, MAX_GLOSSARY_PRESET_NAME_CHARS)
    && !disallowedSingleLineCharacters.test(value));

const presetDomainSchema = z
  .string()
  .transform(normalizeNfcAndTrim)
  .refine((value) => hasLengthBetween(value, 0, MAX_GLOSSARY_PRESET_DOMAIN_CHARS)
    && !disallowedSingleLineCharacters.test(value));

const presetGlossarySchema = z
  .string()
  .transform(normalizeNfcAndTrim)
  .refine((value) => hasLengthBetween(value, 1, MAX_GLOSSARY_PRESET_GLOSSARY_CHARS)
    && !disallowedGlossaryCharacters.test(value));

const languagePairSchema = z.object({
  a: languageSchema,
  b: languageSchema,
}).strict().refine(
  ({ a, b }) => a !== b,
  { path: ["b"], message: "서로 다른 두 언어를 선택해 주세요." },
);

const presetFieldsSchema = z.object({
  name: presetNameSchema,
  domain: presetDomainSchema,
  glossary: presetGlossarySchema,
  languagePair: languagePairSchema,
}).strict();

export const createGlossaryPresetInputSchema = presetFieldsSchema;

export const updateGlossaryPresetBodySchema = presetFieldsSchema.extend({
  version: presetVersionSchema,
});

export const deleteGlossaryPresetBodySchema = z.object({
  version: presetVersionSchema,
}).strict();

export type CreateGlossaryPresetInput = z.infer<typeof createGlossaryPresetInputSchema>;
export type UpdateGlossaryPresetBody = z.infer<typeof updateGlossaryPresetBodySchema>;
export type DeleteGlossaryPresetBody = z.infer<typeof deleteGlossaryPresetBodySchema>;
