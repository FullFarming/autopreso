import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compositeColors, contrastRatio, createCssColorResolver, readCssDeclaration } from "./css-contrast-test-helper";
import { test } from "node:test";

const stage = readFileSync(resolve(process.cwd(), "components/live/LiveStageView.tsx"), "utf8");
const login = readFileSync(resolve(process.cwd(), "app/(login)/login/page.tsx"), "utf8");
const minutes = readFileSync(resolve(process.cwd(), "components/live/MeetingMinutes.tsx"), "utf8");
const summarySkeleton = readFileSync(resolve(process.cwd(), "components/live/SummarySkeleton.tsx"), "utf8");
const controls = readFileSync(resolve(process.cwd(), "components/ui/FormControls.tsx"), "utf8");
const controlStyles = readFileSync(resolve(process.cwd(), "components/ui/form-controls.module.css"), "utf8");
const layout = readFileSync(resolve(process.cwd(), "app/layout.tsx"), "utf8");
const styles = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

test("stage keeps access prelive, translations live, and a clean completion state", () => {
  assert.match(stage, /recentSpeeches:\s*LiveSpeechActivity\[\]/u);
  assert.match(stage, /<TranslationViewport/u);
  assert.match(stage, /<CaptionEntry/u);
  assert.match(stage, /data-stage-surface="caption-first"/u);
  assert.match(stage, /captionFirstPreview=\{recentSpeeches\.at\(-1\)\?\.text \?\? ""\}/u);
  assert.match(stage, /previewLabel="Stage caption preview"/u);
  assert.match(stage, /isPrelive\s*\?\s*\(/u);
  assert.match(stage, /isEnded\s*\?\s*\(/u);
  assert.match(stage, /className="live-stage-complete"/u);
  assert.match(stage, /\{isPrelive && currentInvite && \(/u);
  assert.doesNotMatch(stage, /is-faded-out|aria-hidden=\{!isPrelive\}/u);
  assert.doesNotMatch(stage, /<(?:button|a)\b/u);
});

// 2026-08-22: the access code + QR must stay reachable until the host ends the
// session — latecomers scan mid-call. The stage keeps a compact access strip on
// the live surface, and the invite self-fetch is no longer preparing-only.
test("stage keeps the QR and access code available while live", () => {
  assert.match(stage, /className="live-stage-access is-live"/u);
  assert.match(stage, /\{!isEnded && currentInvite && \(/u);
  assert.match(stage, /session\.status === "stopped" \|\| session\.status === "failed"/u);
  assert.doesNotMatch(stage, /session\.status !== "preparing"\) return/u);
  const liveAccessStart = styles.indexOf(".live-stage-access.is-live");
  assert.notEqual(liveAccessStart, -1, "compact live access strip needs stage styles");
});

test("stage gates creation and display on current admission and rejects late invite responses", () => {
  assert.match(stage, /hasOpenStageAdmission\(activeSession, Date\.now\(\)\)/u);
  assert.match(stage, /action: "read-if-open"/u);
  assert.doesNotMatch(stage, /action: "create"|action: "create-if-open"/u);
  assert.match(stage, /url: `\$\{window\.location\.origin\}\/watch`/u);
  assert.match(stage, /getCurrentStageInvite\(candidate, latestSessionRef\.current, Date\.now\(\)\)/u);
  assert.match(stage, /getCurrentStageInvite\(invite, session, now\)/u);
  assert.match(stage, /controller\.abort\(\)/u);
  assert.match(stage, /params\.get\("expiresAt"\)/u);
});

test("login composes shared accessible controls with only the required credentials", () => {
  assert.match(login, /FormField/u);
  assert.match(login, /FormButton/u);
  assert.match(login, /FormError/u);
  assert.match(login, /JSON\.stringify\(\{ id, password \}\)/u);
  assert.doesNotMatch(login, /name="name"/u);
  for (const field of [
    ['name="id"', 'autoComplete="username"'],
    ['name="password"', 'autoComplete="current-password"'],
  ]) {
    assert.match(login, new RegExp(`${field[0]}[\\s\\S]{0,180}${field[1]}|${field[1]}[\\s\\S]{0,180}${field[0]}`, "u"));
  }
  assert.match(controls, /role="alert"/u);
  assert.match(controlStyles, /min-height:\s*44px/u);
  assert.match(controlStyles, /outline:\s*2px solid var\(--nova-system-default/u);
});

test("root viewport permits browser zoom while preserving safe-area coverage", () => {
  assert.match(layout, /viewportFit:\s*"cover"/u);
  assert.doesNotMatch(layout, /maximumScale|userScalable/u);
});

test("web UI self-hosts the three Pretendard weights without external font requests", () => {
  assert.doesNotMatch(layout, /fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|EB Garamond|Noto Sans KR|Inter/u);
  for (const [file, weight] of [["Pretendard-Regular.woff2", "400"], ["Pretendard-Medium.woff2", "500"], ["Pretendard-SemiBold.woff2", "600"]]) {
    assert.ok(existsSync(resolve(process.cwd(), "public/fonts", file)), `${file} must be bundled`);
    assert.match(styles, new RegExp(`url\\(["']?/fonts/${file.replace(".", "\\.")}["']?\\)[\\s\\S]{0,180}font-weight:\\s*${weight}`, "u"));
  }
  assert.ok(existsSync(resolve(process.cwd(), "public/fonts/Pretendard-LICENSE.txt")));
  assert.match(styles, /font-display:\s*swap/u);
  assert.match(styles, /:lang\(ja\)[\s\S]*Hiragino Sans/u);
  assert.match(styles, /:lang\(zh-Hans\)[\s\S]*PingFang SC/u);
  assert.doesNotMatch(styles, /font-weight:\s*700|font:\s*700/u);
});

test("login primary action keeps WCAG AA text contrast on the NOVA blue token", () => {
  assert.match(controlStyles, /background:\s*var\(--nova-blue\)/u);
  const resolveColor = createCssColorResolver(styles, [".live-viewer-shell"]);
  const background = resolveColor(readCssDeclaration(controlStyles, ".button", "background"));
  const foreground = resolveColor(readCssDeclaration(controlStyles, ".button", "color"));
  assert.ok(contrastRatio(foreground, background) >= 4.5);
});

test("CSS contrast checks resolve aliases and alpha without concealing invalid or low-contrast colors", () => {
  const resolveColor = createCssColorResolver(`:root {
    --background: #000; --foreground: #fff; --text: var(--foreground);
    --overlay: color-mix(in srgb, var(--text) 50%, transparent);
    --cycle: var(--cycle);
  }`);
  const background = resolveColor("var(--background)");
  const foreground = resolveColor("var(--text)");
  assert.equal(contrastRatio(foreground, background), 21);
  assert.deepEqual(compositeColors(resolveColor("var(--overlay)"), background), [0.5, 0.5, 0.5, 1]);
  assert.deepEqual(resolveColor("var(--missing, rgba(255, 255, 255, 0.5))"), [1, 1, 1, 0.5]);
  assert.ok(contrastRatio(resolveColor("rgba(255, 255, 255, 0.2)"), background) < 4.5);
  assert.throws(() => resolveColor("var(--missing)"), /Missing CSS color token/u);
  assert.throws(() => resolveColor("var(--cycle)"), /Circular CSS color token/u);
  assert.throws(() => resolveColor("not-a-color"), /Unsupported CSS color/u);
});

test("minutes use the shared bounded reading surface and explicit states", () => {
  assert.match(minutes, /<ReadingSurface/u);
  assert.match(minutes, /GroundedPostCallIndex/u);
  assert.match(minutes, /MeetingTopicChapters/u);
  assert.match(minutes, /RecapStatePanel/u);
  // The generating state lives in SummarySkeleton; it keeps the live region.
  assert.match(minutes, /<SummarySkeleton/u);
  assert.match(summarySkeleton, /role="status" aria-live="polite"/u);
  assert.match(minutes, /role="alert"/u);
  assert.match(styles, /\.live-minutes-reading\s*\{[^}]*max-width:\s*920px/su);
  assert.ok(minutes.split("\n").length < 200, "MeetingMinutes must remain a focused component surface");
  assert.match(minutes, /activeTab === "summary" \? \(/u);
  assert.doesNotMatch(minutes, /hidden=\{/u, "inactive minutes tabs must not build hidden transcript or topic DOM");
});

test("every recap recovery and ended action keeps a 44px target and exact NOVA focus ring", () => {
  assert.match(styles, /\.live-recap-state button\s*\{[^}]*min-height:\s*44px/su);
  assert.match(styles, /\.live-summary-actions button\s*\{[^}]*min-height:\s*44px/su);
  assert.match(styles, /\.live-recap-state button:focus-visible,[\s\S]*\.live-summary-actions button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--nova-system-default\)/su);
});

test("minutes styles use semantic NOVA tokens without raw colors", () => {
  const start = styles.indexOf("/* Meeting minutes (회의록)");
  const end = styles.indexOf("/* End meeting minutes */", start);
  const contract = styles.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(contract, /#[0-9a-f]{3,8}\b|rgba?\(/iu);
  assert.match(contract, /var\(--nova-/u);
});

test("participant media selectors are absent only after production TSX references reach zero", () => {
  const deadSelectors = [
    "live-audio-only-state",
    "live-audio-consent-state",
    "live-audio-bars",
    "live-pip-body",
    "live-pip-button",
    "live-viewer-legend",
  ];
  const productionSources = [stage, login, minutes,
    readFileSync(resolve(process.cwd(), "components/live/LiveViewer.tsx"), "utf8"),
    readFileSync(resolve(process.cwd(), "app/m/watch/demo/page.tsx"), "utf8")].join("\n");
  for (const selector of deadSelectors) {
    assert.doesNotMatch(productionSources, new RegExp(selector, "u"));
    assert.doesNotMatch(styles, new RegExp(`\\.${selector}`, "u"));
  }
});

test("new composition styles use semantic tokens and reduced motion", () => {
  const start = styles.indexOf("/* Stage login minutes composition */");
  const end = styles.indexOf("/* End stage login minutes composition */", start);
  assert.ok(start >= 0 && end > start);
  const contract = styles.slice(start, end);
  assert.doesNotMatch(contract, /#[0-9a-f]{3,8}\b/iu);
  assert.doesNotMatch(contract, /gradient\(/iu);
  assert.match(contract, /var\(--nova-/u);
  assert.match(contract, /prefers-reduced-motion:\s*reduce/u);
});
