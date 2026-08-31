// Security owns the only validation truth source. This module keeps domain
// imports stable without defining a second, drifting zod contract.
export {
  createGlossaryPresetInputSchema,
  deleteGlossaryPresetBodySchema,
  glossaryPresetIdSchema,
  MAX_GLOSSARY_PRESET_DOMAIN_CHARS,
  MAX_GLOSSARY_PRESET_GLOSSARY_CHARS,
  MAX_GLOSSARY_PRESET_NAME_CHARS,
  MAX_GLOSSARY_PRESETS_PER_HOST,
  updateGlossaryPresetBodySchema,
  type CreateGlossaryPresetInput,
  type DeleteGlossaryPresetBody,
  type UpdateGlossaryPresetBody,
} from "../security/host-glossary-preset-validation";

export function parsePositiveVersion(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647
    ? Number(value)
    : null;
}

export function parsePositiveVersionText(value: string): number | null {
  return /^[1-9][0-9]{0,9}$/u.test(value) ? parsePositiveVersion(Number(value)) : null;
}

export function parseActivateDocumentBody(value: unknown): Readonly<{
  presetVersion: number;
  documentVersion: number;
}> | null {
  if (!isExactObject(value, ["presetVersion", "documentVersion"])) return null;
  const presetVersion = parsePositiveVersion(value.presetVersion);
  const documentVersion = parsePositiveVersion(value.documentVersion);
  return presetVersion && documentVersion ? { presetVersion, documentVersion } : null;
}

export function parseDuplicateDocumentBody(value: unknown): Readonly<{
  documentVersion: number;
  name: string;
}> | null {
  if (!isExactObject(value, ["documentVersion", "name"])) return null;
  const documentVersion = parsePositiveVersion(value.documentVersion);
  const name = normalizeBoundedText(value.name, 1, 80);
  return documentVersion && name ? { documentVersion, name } : null;
}

export function parseDeleteDocumentBody(value: unknown): Readonly<{ presetVersion: number }> | null {
  if (!isExactObject(value, ["presetVersion"])) return null;
  const presetVersion = parsePositiveVersion(value.presetVersion);
  return presetVersion ? { presetVersion } : null;
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function normalizeBoundedText(value: unknown, minimum: number, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  const length = Array.from(normalized).length;
  if (length < minimum || length > maximum || /[<>]|\p{Cc}|\p{Cf}/u.test(normalized)) return null;
  return normalized;
}
