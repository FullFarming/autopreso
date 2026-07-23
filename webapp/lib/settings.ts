// Client settings persisted in localStorage (no database, per spec).

import { DOMAIN_HOSPITALITY, GLOSSARY_HOSPITALITY } from "./presets";
import type { LanguageCode } from "./languageDetect";
import type { EngineKind, InputMode, LanguagePairId, ToneKind } from "./types";

export const MAX_GLOSSARY_CHARS = 16000;
export const MAX_DOMAIN_CHARS = 2000;

export type PipPosition = "bottom" | "middle" | "top";

/** both = bidirectional (1 channel per pair language); a2b/b2a = one direction
 *  only (half the realtime audio cost when a single speaker is translated). */
export type DirectionMode = "both" | "a2b" | "b2a";

export interface AppSettings {
  inputMode: InputMode;
  languagePair: LanguagePairId;
  /** Translate both directions, or only pair[0]→pair[1] / pair[1]→pair[0]. */
  direction: DirectionMode;
  tone: ToneKind;
  engine: EngineKind;
  glossary: string;
  domain: string;
  presetId: string; // "" = custom / none
  pipPosition: PipPosition;
  pipFontSize: number; // px, translation line in the overlay
  pipShowSource: boolean;
  /** Drop near-silent audio so dead air isn't billed (no word clipping). */
  silenceGate: boolean;
  /** Simultaneous output languages; empty = derive from languagePair. */
  targetLanguages: LanguageCode[];
  /** Publish lines to the phone↔desktop link channel. */
  syncLink: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  inputMode: "mic",
  languagePair: "ko-en",
  direction: "both",
  tone: "natural",
  engine: "openai",
  // Ship with the prepared hotel-investment termbase active out of the box —
  // glossary/domain are part of the program, not an empty field to fill.
  glossary: GLOSSARY_HOSPITALITY,
  domain: DOMAIN_HOSPITALITY,
  presetId: "hospitality",
  pipPosition: "bottom",
  pipFontSize: 34,
  pipShowSource: true,
  silenceGate: true,
  targetLanguages: [],
  syncLink: false,
};

const STORAGE_KEY = "realtime-noel-web-settings-v1";

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeSettings(raw: any): AppSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) };
  return {
    inputMode: ["mic", "tab", "both"].includes(merged.inputMode) ? merged.inputMode : DEFAULT_SETTINGS.inputMode,
    languagePair: ["ko-en", "ko-ja", "en-ja"].includes(merged.languagePair)
      ? merged.languagePair
      : DEFAULT_SETTINGS.languagePair,
    direction: ["both", "a2b", "b2a"].includes(merged.direction) ? merged.direction : DEFAULT_SETTINGS.direction,
    tone: ["natural", "business"].includes(merged.tone) ? merged.tone : DEFAULT_SETTINGS.tone,
    engine: ["openai", "gemini"].includes(merged.engine) ? merged.engine : DEFAULT_SETTINGS.engine,
    glossary: typeof merged.glossary === "string" ? merged.glossary.slice(0, MAX_GLOSSARY_CHARS) : "",
    domain: typeof merged.domain === "string" ? merged.domain.slice(0, MAX_DOMAIN_CHARS) : "",
    presetId: typeof merged.presetId === "string" ? merged.presetId : "",
    pipPosition: ["bottom", "middle", "top"].includes(merged.pipPosition)
      ? merged.pipPosition
      : DEFAULT_SETTINGS.pipPosition,
    pipFontSize: Math.round(clampNumber(merged.pipFontSize, 18, 64, DEFAULT_SETTINGS.pipFontSize)),
    pipShowSource: merged.pipShowSource !== false,
    silenceGate: merged.silenceGate !== false,
    targetLanguages: Array.isArray(merged.targetLanguages)
      ? merged.targetLanguages.filter((lang: any) => ["ko", "en", "ja"].includes(lang)).slice(0, 3)
      : [],
    syncLink: merged.syncLink === true,
  };
}

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage full / private mode — non-fatal
  }
}
