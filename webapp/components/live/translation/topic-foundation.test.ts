import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contrastRatio, createCssColorResolver, readCssDeclaration } from "../css-contrast-test-helper";
import { test } from "node:test";

import {
  boundedTopicAnnouncement,
  dedupeEquivalentTranslationLanes,
  dedupeTopicPresentations,
  indexTopicCaptions,
  topicDomId,
} from "./topic-presentation";
import { buildTopicNavigationModel, revealTopicTarget } from "../quality/topic-navigation";

const directory = resolve(process.cwd(), "components/live/translation");
const read = (file: string) => readFileSync(resolve(directory, file), "utf8");

test("source is distinct from fixed targets while duplicate target aliases dedupe in stable order", () => {
  assert.deepEqual(dedupeEquivalentTranslationLanes([
    { id: "source", kind: "source", language: "ko", label: "원문" },
    { id: "ko", kind: "translation", language: "KO", label: "한국어" },
    { id: "en", kind: "translation", language: "en", label: "English" },
    { id: "en-copy", kind: "translation", language: "en", label: "English duplicate" },
  ]), [
    { id: "source", kind: "source", language: "ko", label: "원문" },
    { id: "ko", kind: "translation", language: "KO", label: "한국어" },
    { id: "en", kind: "translation", language: "en", label: "English" },
  ]);
});

test("topic announcements are bounded and normalized", () => {
  assert.equal(boundedTopicAnnouncement("  New   topic  "), "New topic");
  assert.equal(boundedTopicAnnouncement("가".repeat(260)).length, 200);
});

test("lane tabs implement the native keyboard tab pattern and panels", () => {
  const source = read("TranslationLaneTabs.tsx");
  assert.match(source, /role="tablist"/u);
  assert.match(source, /role="tab"/u);
  assert.match(source, /role="tabpanel"/u);
  assert.match(source, /aria-selected=/u);
  assert.match(source, /aria-controls=/u);
  assert.match(source, /tabIndex=\{isSelected \? 0 : -1\}/u);
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) assert.match(source, new RegExp(`"${key}"`, "u"));
  assert.match(source, /\.focus\(\)/u);
  assert.match(source, /renderPanel\(options\[selectedIndex\]\)/u);
  assert.doesNotMatch(source, /options\.map\([^)]*renderPanel/su);
});

test("topic caption indexing visits a large transcript once", () => {
  let visits = 0;
  function* captions() {
    for (let index = 0; index < 12_000; index += 1) {
      visits += 1;
      yield { id: `caption-${index}`, topicId: `topic-${index % 1_000}` };
    }
  }
  const indexed = indexTopicCaptions(captions());
  assert.equal(visits, 12_000);
  assert.equal(indexed.byTopicId.size, 1_000);
  assert.equal(indexed.unassigned.length, 0);
});

test("topic anchors escape opaque ids and dedupe duplicate DOM targets", () => {
  assert.equal(topicDomId("topic/a b"), "meeting-topic-topic%2Fa%20b");
  assert.deepEqual(dedupeTopicPresentations([
    { id: "same", title: "첫 주제", captions: [] },
    { id: "same", title: "중복 주제", captions: [] },
    { id: "next", title: "다음 주제", captions: [] },
  ]).map((topic) => topic.title), ["첫 주제", "다음 주제"]);
});

test("topic navigation bounds a 1000-topic DOM and reveals the selected native target", () => {
  const topics = Array.from({ length: 1_000 }, (_, index) => ({ id: `topic-${index}`, title: `주제 ${index}`, captions: [] }));
  const model = buildTopicNavigationModel(topics);
  assert.equal(model.mode, "select");
  assert.equal(model.directItems.length, 12);
  assert.equal(model.options.length, 1_000);
  let focused = false;
  const details = { open: false, querySelector: () => ({ focus: () => { focused = true; } }) };
  const root = { getElementById: () => details };
  assert.equal(revealTopicTarget("topic-999", root), true);
  assert.equal(details.open, true);
  assert.equal(focused, true);
});

test("active topic stays expanded with bounded live announcements and explicit degraded state", () => {
  const source = read("CurrentTopicPanel.tsx");
  assert.match(source, /<section/u);
  assert.doesNotMatch(source, /<details|hidden=/u);
  assert.match(source, /aria-live="polite"/u);
  assert.match(source, /boundedTopicAnnouncement/u);
  assert.match(source, /role="alert"/u);
  assert.match(source, /<CaptionEntry/u);
});

test("completed topics use native accordions with title time count summary and selected-lane captions", () => {
  const source = read("CompletedTopicAccordion.tsx");
  assert.match(source, /<details/u);
  assert.match(source, /<summary/u);
  assert.match(source, /topic\.title/u);
  assert.match(source, /topic\.timeLabel/u);
  assert.match(source, /topic\.captions\.length/u);
  assert.match(source, /topic\.summary/u);
  assert.match(source, /<CaptionEntry/u);
  assert.match(source, /role="alert"/u);
  assert.match(source, /uniqueTopics\.slice\(0, visibleCount\)/u);
  assert.match(source, /Math\.min\(count \+ 40, uniqueTopics\.length\)/u);
  assert.match(source, /open=\{isExpanded\}/u);
  assert.match(source, /\{isExpanded && \(/u);
});

test("closed completed topics never mount their caption bodies across a 12k-caption fixture", () => {
  const source = read("CompletedTopicAccordion.tsx");
  const topics = Array.from({ length: 1_000 }, (_, topicIndex) => ({
    id: `topic-${topicIndex}`,
    captions: Array.from({ length: 12 }, (_, captionIndex) => ({ id: `caption-${topicIndex}-${captionIndex}` })),
  }));
  const expanded = new Set(["topic-999"]);
  const mountedCaptionCount = topics.reduce((count, topic) => count + (expanded.has(topic.id) ? topic.captions.length : 0), 0);
  assert.equal(mountedCaptionCount, 12);
  assert.match(source, /expandedTopicSet\.has\(topic\.id\)/u);
  assert.doesNotMatch(source, /visibleTopics\.flatMap\([^)]*captions/u);
});

test("topic foundation uses NOVA tokens accessible targets and reduced motion", () => {
  const styles = read("translation.module.css");
  const start = styles.indexOf("/* Topic presentation foundation */");
  const contract = styles.slice(start);
  assert.ok(start >= 0);
  assert.doesNotMatch(contract, /#[0-9a-f]{3,8}\b/iu);
  assert.doesNotMatch(contract, /gradient\(/iu);
  assert.match(contract, /min-height:\s*44px/u);
  assert.match(contract, /outline:\s*2px solid var\(--nova-system-default\)/u);
  assert.match(contract, /prefers-reduced-motion:\s*reduce/u);
  assert.match(
    contract,
    /\.laneTabs\s*\{[^}]*grid-template-rows:\s*minmax\(48px,\s*auto\)\s+minmax\(0,\s*1fr\)/su,
    "the tablist row must not collapse when the caption panel owns overflow",
  );
  for (const file of ["TranslationLaneTabs.tsx", "CurrentTopicPanel.tsx", "CompletedTopicAccordion.tsx"]) {
    assert.ok(read(file).split("\n").length < 200, `${file} must stay below 200 lines`);
  }
});

test("topic metadata and live status keep WCAG AA contrast on the viewer surface", () => {
  const styles = read("translation.module.css");
  const globals = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
  const resolveColor = createCssColorResolver(globals, [".live-viewer-shell"]);
  const muted = resolveColor(readCssDeclaration(styles, ".timestamp", "color"));
  const body = resolveColor("var(--nova-fg-primary)");
  const raised = resolveColor(readCssDeclaration(styles, ".statusChip", "background"));
  const liveStatus = resolveColor(readCssDeclaration(styles, ".statusChip", "color"));

  assert.match(styles, /\.timestamp\s*\{\s*color:\s*var\(--nova-fg-secondary\)/u);
  assert.match(styles, /\.topicMeta,[^}]*color:\s*var\(--nova-fg-secondary\)/su);
  assert.match(styles, /\.statusChip\s*\{[^}]*background:\s*var\(--nova-surface-float\)[^}]*color:\s*var\(--nova-status-live,\s*var\(--nova-fg-primary\)\)/su);
  assert.ok(contrastRatio(muted, raised) >= 4.5, "metadata must meet WCAG AA");
  assert.ok(contrastRatio(body, raised) >= 4.5, "status text fallback must meet WCAG AA");
  assert.ok(contrastRatio(liveStatus, raised) >= 4.5, "live status text must meet WCAG AA");
});
