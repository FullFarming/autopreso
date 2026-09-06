import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compositeColors, contrastRatio, createCssColorResolver, readCssDeclaration } from "../css-contrast-test-helper";
import test from "node:test";

const read = (file: string) => readFileSync(resolve(process.cwd(), "components/live/earnings", file), "utf8");

test("earnings UI composes compact public context, section navigation, selected search, glossary disclosure, and post-call index", () => {
  const combined = [
    read("EarningsCallHeader.tsx"), read("EarningsSectionNav.tsx"), read("SelectedTranscriptSearch.tsx"),
    read("GlossaryMatchDisclosure.tsx"), read("GroundedPostCallIndex.tsx"), read("earnings-presentation.ts"),
  ].join("\n");
  for (const copy of ["실적 발표", "발표", "질의응답", "기타", "선택한 자막 검색", "용어 일치", "회의 인덱스"]) {
    assert.match(combined, new RegExp(copy, "u"));
  }
  assert.match(combined, /aria-current/u);
  assert.match(combined, /aria-live="polite"/u);
  assert.match(combined, /name="transcriptSearch"/u);
  assert.doesNotMatch(combined, /model|token|prompt|documentBody|glossaryBody|scrollIntoView|getUserMedia|microphone/iu);
});

test("earnings section navigation links only the active section to the live caption region", () => {
  const navigation = read("EarningsSectionNav.tsx");
  assert.match(navigation, /data-section-state=/u);
  assert.match(navigation, /section === activeSection/u);
  assert.match(navigation, /완료|예정|대기/u);
  assert.match(navigation, /<a[^>]*href=\{`#\$\{targetId\}`\}/u);
  assert.match(navigation, /<span/u);
  assert.doesNotMatch(navigation, /SECTIONS\.map\([\s\S]*<a[^>]*href=\{`#\$\{targetId\}`\}[\s\S]*<\/a>[\s\S]*\)\)/u);
});

test("active earnings section text meets WCAG AA on the semantic tinted surface", () => {
  const css = read("earnings.module.css");
  const globals = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
  const resolveColor = createCssColorResolver(globals, [".live-viewer-shell"]);
  const foreground = resolveColor(readCssDeclaration(css, ".sectionNav a[aria-current]", "color"));
  const raised = resolveColor(readCssDeclaration(css, ".context", "background"));
  const selectedSurface = compositeColors(
    resolveColor(readCssDeclaration(css, ".sectionNav a[aria-current]", "background")), raised,
  );
  assert.match(css, /\.sectionNav a\[aria-current\]\s*\{[^}]*color:\s*var\(--nova-fg-primary\)/su);
  assert.ok(contrastRatio(foreground, selectedSurface) >= 4.5);
});

test("earnings styles keep captions dominant and responsive with NOVA accessibility tokens", () => {
  const css = read("earnings.module.css");
  assert.match(css, /min-height:\s*44px/u);
  assert.match(css, /outline:\s*2px solid var\(--nova-system-default\)/u);
  assert.match(css, /@media \(max-width:\s*1023px\)/u);
  assert.match(css, /@media \(max-width:\s*767px\)/u);
  assert.match(css, /@media \(max-width:\s*359px\)/u);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/u);
  assert.match(css, /max-height:\s*30vh/u);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}|gradient\(|9999px/iu);
});

test("320px viewer chains remain width-contained while lane tabs retain their own horizontal scroll", () => {
  const earnings = read("earnings.module.css");
  const translation = readFileSync(resolve(process.cwd(), "components/live/translation/translation.module.css"), "utf8");
  const globals = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
  assert.match(earnings, /\.context\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/su);
  assert.match(earnings, /\.context\s*\{[^}]*box-sizing:\s*border-box/su);
  assert.match(translation, /\.toolbar\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*flex-wrap:\s*wrap/su);
  assert.match(translation, /\.viewport[^}]*box-sizing:\s*border-box[^}]*max-width:\s*100%/su);
  assert.match(translation, /\.feed[^}]*box-sizing:\s*border-box[^}]*max-width:\s*100%/su);
  assert.match(translation, /\.laneTabList\s*\{[^}]*overflow-x:\s*auto/su);
  assert.match(globals, /@media \(max-width:\s*767px\)[\s\S]*\.live-viewer-shell\.is-compact[\s\S]*max-width:\s*100%/u);
});

test("event contract remains available while participant reading omits competing context controls", () => {
  const viewer = readFileSync(resolve(process.cwd(), "components/live/LiveViewer.tsx"), "utf8");
  const minutes = readFileSync(resolve(process.cwd(), "components/live/MeetingMinutes.tsx"), "utf8");
  const demo = readFileSync(resolve(process.cwd(), "app/m/watch/demo/page.tsx"), "utf8");
  const contract = readFileSync(resolve(process.cwd(), "components/live/viewer-controller-contract.ts"), "utf8");
  const combined = [viewer, minutes, demo, contract].join("\n");
  for (const field of ["companyName", "ticker", "fiscalPeriod", "eventType", "agenda", "activeSection", "sectionStartedAt"]) {
    assert.match(combined, new RegExp(field, "u"));
  }
  assert.doesNotMatch(viewer, /<EarningsCallContext/u);
  assert.match(viewer, /<ViewerReadingFeed/u);
  assert.match(minutes, /<GroundedPostCallIndex/u);
  assert.doesNotMatch(demo, /<GlossaryMatchDisclosure/u);
  assert.match(demo, /<ParticipantMeetingMinutes/u);
  assert.match(viewer, /participantSpeakingEnabled === true/u);
  assert.match(viewer, /speak-client/u);
  assert.doesNotMatch(combined, /translated-audio|audio-control/u);
});
