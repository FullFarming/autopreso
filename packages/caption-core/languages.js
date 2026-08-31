export const CAPTION_LANGUAGE_CODES = Object.freeze([
  "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "pt", "fr", "de", "ru", "hi", "id", "vi", "it",
]);

const aliases = new Map([
  ["en", "en"], ["english", "en"], ["eng", "en"], ["en-us", "en"], ["en-gb", "en"], ["en-au", "en"], ["en-ca", "en"],
  ["ko", "ko"], ["korean", "ko"], ["kor", "ko"], ["ko-kr", "ko"],
  ["ja", "ja"], ["japanese", "ja"], ["jpn", "ja"], ["jp", "ja"], ["ja-jp", "ja"],
  ["zh", "zh-Hans"], ["zh-hans", "zh-Hans"], ["zh-cn", "zh-Hans"], ["zh-sg", "zh-Hans"], ["cmn-hans-cn", "zh-Hans"], ["chinese", "zh-Hans"], ["chinese simplified", "zh-Hans"], ["zho", "zh-Hans"], ["cmn", "zh-Hans"],
  ["zh-hant", "zh-Hant"], ["zh-tw", "zh-Hant"], ["zh-hk", "zh-Hant"], ["zh-mo", "zh-Hant"], ["cmn-hant-tw", "zh-Hant"], ["chinese traditional", "zh-Hant"],
  ["es", "es"], ["es-es", "es"], ["es-mx", "es"], ["spanish", "es"], ["spa", "es"],
  ["pt", "pt"], ["pt-br", "pt"], ["pt-pt", "pt"], ["portuguese", "pt"], ["por", "pt"],
  ["fr", "fr"], ["fr-fr", "fr"], ["fr-ca", "fr"], ["french", "fr"], ["fra", "fr"],
  ["de", "de"], ["de-de", "de"], ["german", "de"], ["deu", "de"],
  ["ru", "ru"], ["ru-ru", "ru"], ["russian", "ru"], ["rus", "ru"],
  ["hi", "hi"], ["hi-in", "hi"], ["hindi", "hi"], ["hin", "hi"],
  ["id", "id"], ["id-id", "id"], ["indonesian", "id"], ["ind", "id"],
  ["vi", "vi"], ["vi-vn", "vi"], ["vietnamese", "vi"], ["vie", "vi"],
  ["it", "it"], ["it-it", "it"], ["italian", "it"], ["ita", "it"],
]);

export function normalizeCaptionLanguage(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  return aliases.get(normalized) ?? aliases.get(normalized.split("-")[0]) ?? "";
}
