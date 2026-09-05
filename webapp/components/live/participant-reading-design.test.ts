import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("participant toolbar owns one compact interface language control before the overflow menu", () => {
  const viewer = read("./LiveViewer.tsx");
  assert.match(viewer, /data-inline-system-language="true"/u);
  assert.match(viewer, /<SystemLanguageButton compact\s*\/>[\s\S]*<ControlDrawer[^>]*iconOnly/u);
  const shell = read("../system-language/system-language.module.css");
  assert.match(shell, /data-inline-system-language[^}]*--system-language-bar-height: 0px/su);
});

test("paragraph emphasis identifies only the newest utterance and keeps manual reading position", () => {
  const feed = read("./ViewerReadingFeed.tsx");
  assert.match(feed, /data-current=\{index === captions.length - 1 \|\| undefined\}/u);
  assert.match(feed, /if \(isPinned.current\) node.scrollTop = node.scrollHeight/u);
  assert.match(feed, /if \(firstPresentedCaptions.current === captions\) return/u);
  assert.match(feed, /onReadingAnchorChange/u);
});

test("participant paragraphs and drawer fit small viewports with scalable readable text", () => {
  const css = read("../../app/globals.css");
  assert.match(css, /font-size: calc\(16px \* var\(--live-caption-scale, 1\)\)/u);
  assert.match(css, /padding-inline: 12px/u);
  assert.match(css, /data-current="true"/u);
  const drawer = read("./translation/translation.module.css");
  assert.doesNotMatch(drawer, /\.drawerBody[^}]*min-width: max-content/u);
  assert.match(drawer, /\.drawer\[open\][^}]*display: flex/su);
});
