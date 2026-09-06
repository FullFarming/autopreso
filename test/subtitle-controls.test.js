import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateHelpPosition, createCaptionDisplaySelection } from "../public/subtitle-controls.js";

test("help remains inside narrow viewport and moves above a low control", () => {
  const position = calculateHelpPosition({ left: 350, bottom: 555, top: 511 }, { width: 280, height: 150 }, { width: 375, height: 568 });
  assert.ok(position.left >= 16);
  assert.ok(position.left + 280 <= 375 - 16);
  assert.ok(position.top >= 16 && position.top + 150 < 511);
});

test("caption display selection keeps opaque display IDs and never restarts capture", async () => {
  const writes = [];
  let displays = [{ id: "internal", label: "내장", isSelected: true }, { id: "external", label: "외부", isSelected: false }];
  const model = createCaptionDisplaySelection({
    listOverlayDisplays: async () => ({ displays }),
    selectOverlayDisplays: async ids => { writes.push(ids); displays = displays.map(display => ({ ...display, isSelected: ids.includes(display.id) })); return { displays }; },
  });
  await model.refresh();
  await model.select("external", true);
  assert.deepEqual(writes, [["internal", "external"]]);
  await model.select("internal", false);
  assert.deepEqual(writes[1], ["external"]);
  await assert.rejects(model.select("untrusted", true));
  assert.equal(writes.length, 2);
});

test("caption display failures keep previous selection and reject duplicate in-flight writes", async () => {
  const completions = [];
  const model = createCaptionDisplaySelection({
    listOverlayDisplays: async () => ({ displays: [{ id: "1", label: "화면", isSelected: true }] }),
    selectOverlayDisplays: () => new Promise((resolve, reject) => completions.push({ resolve, reject })),
  });
  await model.refresh();
  const pending = model.select("1", false);
  await assert.rejects(model.select("1", false));
  completions[0].reject(new Error("offline"));
  await assert.rejects(pending);
  assert.equal(model.getState().displays[0].isSelected, true);
});

test("caption details default closed and preserve existing appearance IDs", async () => {
  const html = await readFile(new URL("../public/subtitle.html", import.meta.url), "utf8");
  assert.match(html, /<details id="caption-details"[^>]*>/u);
  assert.doesNotMatch(html.match(/<details id="caption-details"[^>]*>/u)?.[0] || "", /\bopen\b/u);
  const details = html.slice(html.indexOf('<details id="caption-details"'), html.indexOf('</details>', html.indexOf('<details id="caption-details"')));
  for (const name of ['name="opacity"', 'name="translationFontSize"', 'id="subtitle-placement"', 'id="glossary-session-selection"']) assert.ok(details.includes(name), name);
  assert.ok(html.indexOf('id="caption-display-trigger"') < html.indexOf('<details id="caption-details"'));
  assert.equal((html.match(/id="start-subtitles"/gu) || []).length, 1);
});

test("an old display refresh cannot overwrite a completed selection", async () => {
  const reads = [];
  const initial = { displays: [{ id: "1", label: "화면", isSelected: true }] };
  const model = createCaptionDisplaySelection({ listOverlayDisplays: () => new Promise(resolve => reads.push(resolve)), selectOverlayDisplays: async () => ({ displays: [{ ...initial.displays[0], isSelected: false }] }) });
  model.accept(initial);
  const refresh = model.refresh();
  await model.select("1", false);
  reads[0](initial);
  await refresh;
  assert.equal(model.getState().displays[0].isSelected, false);
});
