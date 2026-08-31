import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/subtitle.html", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../public/subtitle-dashboard.js", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../public/subtitle-workspace.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/subtitle-i18n.js", import.meta.url), "utf8");

test("both language selections are dropdown multi-selects with checkbox mirrors", () => {
  for (const id of ["subtitle-language-trigger", "live-call-language-trigger"]) {
    assert.match(html, new RegExp(`id="${id}"[\\s\\S]{0,120}aria-haspopup`, "u"));
  }
  assert.match(html, /id="subtitle-language-panel"/u);
  assert.match(html, /id="live-call-language-panel"/u);
  // The form contract stays checkbox-based inside the panels.
  assert.match(html, /name="translationLanguages" type="checkbox" value="ja"/u);
  assert.match(dashboard, /buildLanguagePill\("liveCallTranslationLanguages", language/u);
  assert.match(dashboard, /function setupLanguageDropdowns/u);
  assert.match(dashboard, /aria-expanded/u);
});

test("dropdown panels stay legible at any width: viewport clamp, min width, ellipsis", () => {
  const css = readFileSync(new URL("../public/subtitle.css", import.meta.url), "utf8");
  // The panel is never narrower than the trigger nor wider than the viewport…
  assert.match(css, /\.lang-select-panel \{[\s\S]*?min-width: 100%;[\s\S]*?width: min\(400px, calc\(100vw - 24px\)\);[\s\S]*?\}/u);
  // …columns collapse automatically instead of forcing two…
  assert.match(css, /\.lang-select-panel \.language-pills \{[\s\S]*?repeat\(auto-fill, minmax\(160px, 1fr\)\)/u);
  // …and long labels truncate inside the pill instead of escaping the panel.
  assert.match(css, /\.lang-select-panel \.lang-pill span \{[\s\S]*?text-overflow: ellipsis;/u);
  assert.match(css, /scrollbar-width: thin;/u);
  // The open handler shifts a panel back on-screen when the trigger sits near
  // the right edge, and close resets the shift.
  assert.match(dashboard, /panel\.style\.marginLeft = `\$\{-Math\.min\(overflowRight/u);
  assert.match(dashboard, /panel\.style\.marginLeft = "";\n      trigger\.setAttribute\("aria-expanded", "false"\)/u);
  // One pill factory feeds both dropdowns — no diverging markup.
  assert.match(dashboard, /function buildLanguagePill/u);
  assert.equal((dashboard.match(/buildLanguagePill\(/gu) ?? []).length, 3);
});

test("Live Call languages are independent with an inherit (empty) default", () => {
  assert.match(dashboard, /liveCallTranslationLanguages: readLiveCallLanguagesFromForm\(\)/u);
  assert.match(dashboard, /writeLiveCallLanguageCheckboxes\(settings\.liveCallTranslationLanguages \?\? \[\]\)/u);
  assert.match(dashboard, /t\("live\.languagesInherit"\)/u);
  // The workspace draft prefers the Live Call selection and falls back to the
  // subtitle languages, so unset behaves exactly like before the split.
  assert.match(workspace, /function selectedLiveCallLanguages/u);
  assert.match(workspace, /input\[name="liveCallTranslationLanguages"\]:checked/u);
  assert.match(workspace, /languages: selectedLiveCallLanguages\(\)/u);
  assert.match(i18n, /"live\.languagesInherit": "자막 언어와 동일"/u);
  // Local overlay channel rebuilds stay bound to subtitle languages only.
  assert.match(dashboard, /CHANNEL_REBUILD_CONTROLS = new Set\(\["translationLanguages"\]\)/u);
});
