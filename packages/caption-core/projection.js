import { normalizeCaptionLanguage } from "./languages.js";

export function projectCanonicalCaption(caption = {}) {
  const utteranceKey = String(caption.utteranceKey ?? "");
  const phase = caption.phase === "final" ? "final" : "partial";
  const sourceText = String(caption.sourceText ?? "").trim();
  const translatedText = String(caption.translatedText ?? "").trim();
  const sourceLanguage = normalizeCaptionLanguage(caption.sourceLanguage);
  const targetLanguage = normalizeCaptionLanguage(caption.targetLanguage);
  const translationStatus = caption.translationStatus === "translated" ? "translated" : "failed";
  const records = [];
  if (phase === "final" && sourceText && sourceLanguage) {
    records.push({ utteranceKey, phase, language: sourceLanguage, sourceLanguage, sourceText, text: sourceText, translationStatus: "source" });
  }
  if (phase === "final" && translatedText && targetLanguage && targetLanguage !== sourceLanguage && translationStatus === "translated") {
    records.push({ utteranceKey, phase, language: targetLanguage, sourceLanguage, sourceText, text: translatedText, translationStatus });
  }
  const overlay = translatedText && targetLanguage && targetLanguage !== sourceLanguage && translationStatus === "translated"
    ? { utteranceKey, phase, language: targetLanguage, text: translatedText }
    : null;
  return { overlay, records };
}
