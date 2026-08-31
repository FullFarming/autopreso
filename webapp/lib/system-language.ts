import { DEFAULT_SYSTEM_LANGUAGE, SYSTEM_LANGUAGES, SYSTEM_LANGUAGE_LABELS, SYSTEM_LANGUAGE_STORAGE_KEY, normalizeSystemLanguage as normalizeSharedSystemLanguage } from "../../public/system-language.js";

export { DEFAULT_SYSTEM_LANGUAGE, SYSTEM_LANGUAGES, SYSTEM_LANGUAGE_LABELS, SYSTEM_LANGUAGE_STORAGE_KEY };
export type SystemLanguage = "ko" | "en" | "ja";
export type SystemMessages = Record<SystemLanguage, Record<string, string>>;
export type SystemTextValues = Record<string, string | number>;
export const SYSTEM_LOCALES = { ko: "ko-KR", en: "en-US", ja: "ja-JP" } as const;

export function isSystemLanguage(value: unknown): value is SystemLanguage {
  return typeof value === "string" && SYSTEM_LANGUAGES.includes(value);
}

export function normalizeSystemLanguage(value: unknown): SystemLanguage {
  const normalized: unknown = normalizeSharedSystemLanguage(value);
  return isSystemLanguage(normalized) ? normalized : "ko";
}

export function readStoredSystemLanguage(storage: Pick<Storage, "getItem">, fallback: SystemLanguage): SystemLanguage {
  const stored = storage.getItem(SYSTEM_LANGUAGE_STORAGE_KEY);
  return isSystemLanguage(stored) ? stored : fallback;
}

export function formatSystemText(messages: SystemMessages, language: SystemLanguage, key: string, values?: SystemTextValues): string {
  const message = Object.hasOwn(messages[language], key) ? messages[language][key]
    : Object.hasOwn(messages.ko, key) ? messages.ko[key] : key;
  return message.replace(/\{([a-zA-Z0-9_]+)\}/gu, (placeholder, name: string) =>
    values && Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}
