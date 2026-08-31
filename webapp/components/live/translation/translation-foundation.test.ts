import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

const directory = resolve(process.cwd(), "components/live/translation");
const read = (file: string) => readFileSync(resolve(directory, file), "utf8");

test("translation viewport preserves content and announces finals through a bounded polite region", () => {
  const source = read("TranslationViewport.tsx");

  assert.match(source, /aria-live="polite"/u);
  assert.match(source, /aria-atomic="true"/u);
  assert.match(source, /finalAnnouncement\.slice\(0, 500\)/u);
  assert.match(source, /isPinnedToLiveEdge\(event\.currentTarget\)/u);
  assert.match(source, /최신 자막으로 이동/u);
  assert.match(source, /isEmpty/u);
  assert.match(source, /role="region"/u);
  assert.match(source, /aria-label=\{ariaLabel\}/u);
});

test("caption entry exposes semantic final partial and failed states without raw colors", () => {
  const source = read("CaptionEntry.tsx");
  const styles = read("translation.module.css");

  assert.match(source, /data-caption-state=/u);
  assert.match(source, /data-list-item="caption"/u);
  assert.match(source, /isFinal/u);
  assert.match(source, /translationStatus === "failed"/u);
  assert.match(styles, /word-break:\s*keep-all/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/iu);
  assert.doesNotMatch(styles, /linear-gradient|radial-gradient/iu);
});

test("translation viewport exposes the SEED caption-first status list and feed contract", () => {
  const source = read("TranslationViewport.tsx");
  const styles = read("translation.module.css");

  assert.match(source, /captionFirstPreview/u);
  assert.match(source, /data-caption-first=\{hasPreview \|\| undefined\}/u);
  assert.match(source, /data-density=\{density\}/u);
  assert.match(source, /className=\{styles\.statusBar\}/u);
  assert.match(source, /role="status" aria-live="polite" aria-atomic="true"/u);
  assert.match(source, /className=\{styles\.preview\}/u);
  assert.match(source, /aria-label=\{listLabel\}/u);
  assert.match(styles, /\.statusBar\s*\{[^}]*min-height:\s*44px/su);
  assert.match(styles, /\.preview\s*\{/u);
  assert.match(styles, /\.previewText\s*\{/u);
  assert.match(styles, /\.viewport\[data-density="compact"\]/u);
});

test("language and secondary controls keep native semantics and 44px targets", () => {
  const selector = read("LanguageSelector.tsx");
  const drawer = read("ControlDrawer.tsx");
  const toolbar = read("TranslationToolbar.tsx");
  const styles = read("translation.module.css");

  assert.match(selector, /<select/u);
  assert.match(selector, /role="radiogroup"/u);
  assert.match(selector, /type="radio"/u);
  assert.match(selector, /useId\(\)/u);
  assert.match(selector, /htmlFor=\{selectId\}/u);
  assert.match(selector, /id=\{selectId\}/u);
  assert.match(selector, /name=\{selectId\}/u);
  assert.match(drawer, /<dialog/u);
  assert.match(drawer, /onCancel=/u);
  assert.match(drawer, /triggerRef\.current\?\.focus\(\)/u);
  assert.match(toolbar, /aria-label=/u);
  for (const selector of ["jumpButton", "secondaryButton", "selectLabel select", "segmented label", "segmented span"]) {
    const rule = [...styles.matchAll(/([^{}]+)\{([^}]*)\}/gu)].find((match) =>
      match[1].split(",").some((candidate) => candidate.trim() === `.${selector}`)
      && /min-height:\s*(\d+)px/u.test(match[2]));
    const height = rule?.[2].match(/min-height:\s*(\d+)px/u)?.[1];
    assert.ok(height && Number(height) >= 44, `${selector} must keep a 44px target`);
  }
});

test("foundation components stay focused and consume semantic NOVA tokens", () => {
  for (const file of ["TranslationViewport.tsx", "CaptionEntry.tsx", "LanguageSelector.tsx", "ControlDrawer.tsx", "TranslationToolbar.tsx"]) {
    assert.ok(read(file).split("\n").length <= 200, `${file} exceeds 200 lines`);
  }

  const styles = read("translation.module.css");
  assert.match(styles, /var\(--nova-/u);
  assert.doesNotMatch(styles, /font-family:/u);
  assert.doesNotMatch(styles, /9999px|emoji/u);
  assert.match(styles, /outline:\s*2px solid var\(--nova-system-default\)/u);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/u);
});

test("partial captions carry a non-color in-progress signal and never double-print the source", () => {
  const source = read("CaptionEntry.tsx");
  const styles = read("translation.module.css");

  // 2A: the uncommitted body gets the dashed system-blue underline (shape, not
  // just color), same size and weight, no chip - DESIGN.md 8.2.
  assert.ok(styles.includes('.entry[data-caption-state="partial"] .captionText'));
  assert.match(styles, /underline dashed var\(--nova-system-default\) 1px/u);
  assert.match(source, /입력 중/u);

  // T-C: a verbatim caption IS the original - rendering the disclosure would
  // print the same sentence twice.
  assert.match(source, /translationStatus !== "verbatim"/u);
  assert.match(source, /sourceText !== text/u);

  // T-C: a failed lane shows a status line instead of the raw source body, so
  // the original never appears in two scripts on one lane.
  assert.match(source, /번역을 불러오지 못했어요/u);
});

test("caption entries honor the global transcript display mode without bilingual duplication", () => {
  const source = read("CaptionEntry.tsx");

  assert.match(source, /displayMode/u);
  // bilingual: source line above the translation - but NEVER when the caption
  // is verbatim (that would print the same sentence twice).
  assert.match(source, /"bilingual"/u);
  assert.match(source, /"source"/u);
  assert.ok(source.includes("sourceLine"));
});

test("speaker names carry an accessible per-speaker color on the viewer", () => {
  const source = read("CaptionEntry.tsx");
  assert.match(source, /speakerColor/u);
});
