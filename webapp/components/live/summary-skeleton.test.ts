import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(file: string) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const output = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
  new Function("require", "module", "exports", code)(require, output, output.exports);
  return output.exports;
}

const styles = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const minutes = readFileSync(new URL("./MeetingMinutes.tsx", import.meta.url), "utf8");

test("the summary skeleton announces progress once and draws the card that is coming", () => {
  const SummarySkeleton = load("./SummarySkeleton.tsx").default;
  const html = renderToStaticMarkup(createElement(SummarySkeleton, {
    label: "회의 요약을 만들고 있습니다",
    elapsedLabel: "경과 시간 00:12",
  }));

  assert.match(html, /role="status"/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /aria-label="회의 요약을 만들고 있습니다"/u);
  assert.match(html, /회의 요약을 만들고 있습니다/u);
  assert.match(html, /경과 시간 00:12/u);
  // A title bar, two overview lines and three chapter lines - the card shape.
  assert.equal(html.match(/live-summary-skeleton-title/gu)?.length, 1);
  assert.equal(html.match(/live-summary-skeleton-line/gu)?.length, 2);
  assert.equal(html.match(/live-summary-skeleton-chapter/gu)?.length, 3);
  assert.match(html, /class="live-summary-skeleton" aria-hidden="true"/u,
    "the bars are decorative; only the label may be announced");
  assert.doesNotMatch(html, /<button/u, "a generating summary offers nothing to retry yet");
  assert.doesNotMatch(html, /live-minutes-loading-dots/u);

  const withoutElapsed = renderToStaticMarkup(createElement(SummarySkeleton, { label: "Preparing the meeting summary" }));
  assert.match(withoutElapsed, /Preparing the meeting summary/u);
  assert.doesNotMatch(withoutElapsed, /live-minutes-elapsed/u);
});

test("the skeleton shimmer is compositor-only, bounded, and static under reduced motion", () => {
  assert.match(styles, /@keyframes live-summary-shimmer \{[^}]*\}/su);
  const shimmer = styles.match(/@keyframes live-summary-shimmer \{[^}]*\}/su)?.[0] ?? "";
  assert.match(shimmer, /transform:/u);
  assert.doesNotMatch(shimmer, /width:|height:|left:|top:|margin|background/u,
    "only transform and opacity may animate so the shimmer never triggers layout");
  assert.match(styles, /animation: live-summary-shimmer 1200ms/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.live-summary-skeleton span::after[^}]*animation: none/u);
  assert.doesNotMatch(styles, /live-minutes-loading-dots/u, "the replaced dot loader must leave no dead styles");
  assert.doesNotMatch(styles, /@keyframes live-minutes-dot/u);
});

test("the host summary panel shows the skeleton while generating and a single regenerate action on failure", () => {
  assert.match(minutes, /import SummarySkeleton from "\.\/SummarySkeleton"/u);
  assert.match(minutes, /<SummarySkeleton/u);
  assert.doesNotMatch(minutes, /live-minutes-loading-dots/u);
  const panel = minutes.slice(minutes.indexOf("<RecapStatePanel"), minutes.indexOf("</RecapStatePanel>"));
  assert.ok(panel.indexOf("<SummarySkeleton") < panel.indexOf("<button"),
    "the retry affordance must never render while a generation is in flight");
  assert.match(panel, /isSummaryEmpty \?/u);
  assert.match(panel, /기록된 발언이 없어 요약을 만들 수 없습니다\./u);
  assert.equal(panel.match(/role=\{summaryError \? "alert" : undefined\}/gu)?.length, 1);
  assert.match(panel, /다시 생성/u);
  assert.ok(minutes.split("\n").length < 200, "MeetingMinutes must remain a focused component surface");
});
