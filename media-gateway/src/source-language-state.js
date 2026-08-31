import { createCaptionLanguageState } from "../../packages/caption-core/index.js";

/** Gateway compatibility adapter. The shared state preserves the richer
 * captions-only observation object; the provider adapter historically consumes
 * only its canonical language string. */
export function createSourceLanguageState() {
  const state = createCaptionLanguageState();
  return {
    observe(value) {
      const safeValue = value && typeof value === "object"
        ? {
            providerLanguage: typeof value.providerLanguage === "string" ? value.providerLanguage : "",
            transcript: typeof value.transcript === "string" ? value.transcript : "",
          }
        : {};
      const language = state.observe(safeValue).language;
      return language === "unknown" ? "" : language;
    },
    reset() {
      state.reset();
    },
  };
}
