import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { LIVE_TRANSLATION_LANGUAGES } from "../media-gateway/src/config.js";
import { SUBTITLE_LANGUAGES } from "../src/subtitle-languages.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CANONICAL_LANGUAGES = [
  "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "pt", "fr", "de", "ru", "hi", "id", "vi", "it",
];

function extractQuotedArray(source, declaration) {
  const match = source.match(new RegExp(`export const ${declaration} = \\[([\\s\\S]*?)\\]`));
  assert.ok(match, `${declaration} 선언을 찾을 수 없습니다.`);
  return [...match[1].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]);
}

test("desktop, web, gateway, Chrome, and database share one canonical live-language contract", async () => {
  const [webSource, chromeSource, migrationSource] = await Promise.all([
    readFile(path.join(ROOT, "webapp/lib/languageDetect.ts"), "utf8"),
    readFile(path.join(ROOT, "chrome-extension/sidepanel.html"), "utf8"),
    readFile(path.join(ROOT, "supabase/migrations/202607230001_live_multilingual_languages.sql"), "utf8"),
  ]);

  const desktopLanguages = SUBTITLE_LANGUAGES.map(({ code }) => code);
  const webLanguages = extractQuotedArray(webSource, "LANGUAGE_CODES");
  const chromeLanguages = [...chromeSource.matchAll(/<option value="([^"]+)"/gu)].map((entry) => entry[1]);
  const databaseLanguages = [...migrationSource.matchAll(/when '([^']+)' then '\1'/gu)].map((entry) => entry[1]);

  assert.deepEqual(desktopLanguages, CANONICAL_LANGUAGES);
  assert.deepEqual(webLanguages, CANONICAL_LANGUAGES);
  assert.deepEqual(LIVE_TRANSLATION_LANGUAGES, CANONICAL_LANGUAGES);
  assert.deepEqual(chromeLanguages, CANONICAL_LANGUAGES);
  assert.deepEqual(databaseLanguages, CANONICAL_LANGUAGES);
});
