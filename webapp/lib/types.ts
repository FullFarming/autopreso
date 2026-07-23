import type { LanguageCode } from "./languageDetect";

export type AudioSource = "mic" | "tab";
export type EngineKind = "openai" | "gemini";
export type ToneKind = "natural" | "business";
export type InputMode = "mic" | "tab" | "both";
export type LanguagePairId = "ko-en" | "ko-ja" | "en-ja";

export interface SubtitleLine {
  id: string;
  at: number; // epoch ms
  source: AudioSource;
  targetLanguage: LanguageCode;
  sourceText: string;
  translatedText: string;
}

export interface PartialLine {
  key: string; // `${source}:${targetLanguage}`
  source: AudioSource;
  targetLanguage: LanguageCode;
  sourceText: string;
  translatedText: string;
  at: number;
}

export type EngineEvent =
  | { type: "level"; source: AudioSource; value: number }
  | { type: "partial"; source: AudioSource; targetLanguage: LanguageCode; sourceText: string; translatedText: string }
  | { type: "committed"; source: AudioSource; targetLanguage: LanguageCode; sourceText: string; translatedText: string }
  | { type: "status"; status: string; source?: AudioSource; targetLanguage?: LanguageCode }
  | { type: "error"; message: string; code?: string };

export interface PolishRequest {
  translatedText: string;
  sourceText: string;
  targetLanguage: LanguageCode;
  tone: ToneKind;
  glossary: string;
  domain: string;
}

export type PolishFn = (request: PolishRequest) => Promise<string>;
