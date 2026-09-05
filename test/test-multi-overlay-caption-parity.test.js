import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { createSubtitleChannelHub } from "../src/subtitle-channels.js";
import {
  resolveControllerDisplay,
  resolveOverlayDisplays,
  resolveSelectedOverlayDisplay,
} from "../src/live-caption-ipc-relay.js";

const PROJECT_ROOT = path.join(import.meta.dirname, "..");

function liveFinal(text, overrides = {}) {
  return {
    type: "subtitle:committed",
    source: "live-call",
    liveSessionId: "live-parity",
    targetLanguage: "en",
    sourceLanguage: "ko",
    translatedText: text,
    ...overrides,
  };
}

function visibleCommittedStack(events, maximum = 3) {
  const lines = [];
  for (const event of events) {
    if (event.type !== "subtitle:committed") continue;
    if (lines.at(-1) !== event.translatedText) lines.push(event.translatedText);
  }
  return lines.slice(-maximum);
}

test("an overlay joining after Live Call starts receives the same visible sentence stack", () => {
  let now = 1_000;
  const hub = createSubtitleChannelHub({ now: () => now });
  const connectedOverlayEvents = [];

  connectedOverlayEvents.push(hub.ingest(liveFinal("First sentence.")));
  now += 180;
  connectedOverlayEvents.push(hub.ingest(liveFinal("Second sentence.")));
  now += 180;
  connectedOverlayEvents.push(hub.ingest(liveFinal("Third sentence.")));

  const lateOverlaySnapshot = hub.snapshotFor({});
  assert.ok(Array.isArray(lateOverlaySnapshot.events), "snapshot must carry the canonical visible event history");
  assert.deepEqual(
    visibleCommittedStack(lateOverlaySnapshot.events),
    visibleCommittedStack(connectedOverlayEvents),
    "every monitor must reconstruct the same roll-up even when its renderer loads later",
  );
  assert.deepEqual(
    lateOverlaySnapshot.events.map((event) => event.displayTimestamp),
    [1_000, 1_180, 1_360],
    "direction timing must be stamped once by the hub, not independently by each monitor",
  );
});

test("canonical snapshot history is bounded and cleared at terminal boundaries", () => {
  const hub = createSubtitleChannelHub({ maximumSnapshotEventsPerLane: 3 });
  for (let index = 1; index <= 5; index += 1) {
    hub.ingest(liveFinal(`Sentence ${index}.`));
  }
  assert.deepEqual(
    hub.snapshotFor({}).events.map((event) => event.translatedText),
    ["Sentence 3.", "Sentence 4.", "Sentence 5."],
  );

  hub.ingest({ type: "subtitle:status", status: "idle" });
  assert.deepEqual(hub.snapshotFor({}).events, []);
});

const displays = [
  { id: 10, label: "Built-in Retina Display", internal: true, bounds: { width: 1728, height: 1117 } },
  { id: 20, label: "Conference Display", internal: false, bounds: { width: 2560, height: 1440 } },
];

test("one persisted display identity restores the selected overlay after hot-plug", () => {
  const preferred = String(displays[1].id);
  assert.equal(resolveSelectedOverlayDisplay(displays, preferred, displays[0]).id, 20);
  assert.equal(
    resolveSelectedOverlayDisplay([displays[0]], preferred, displays[0]).id,
    10,
    "disconnect falls back without erasing the preferred external display identity",
  );
  assert.equal(resolveSelectedOverlayDisplay(displays, preferred, displays[0]).id, 20);
});

// "All displays" mode: the controller tick puts the SAME captions on every
// connected screen instead of only the selected one. The window set is derived
// from one pure resolver so hot-plug, deselection, and the toggle all reconcile
// through a single rule rather than three ad-hoc branches.
test("all-displays mode targets every connected display and single mode targets only the selection", () => {
  const preferred = String(displays[1].id);
  const ids = (list) => list.map((display) => display.id);

  assert.deepEqual(ids(resolveOverlayDisplays(displays, preferred, displays[0], false)), [20],
    "single mode keeps the current one-overlay behavior");
  assert.deepEqual(ids(resolveOverlayDisplays(displays, preferred, displays[0], true)), [10, 20],
    "all-displays mode covers every connected screen");
  // Hot-plug: a display leaving shrinks the set without losing the preference.
  assert.deepEqual(ids(resolveOverlayDisplays([displays[0]], preferred, displays[0], true)), [10]);
  assert.deepEqual(ids(resolveOverlayDisplays([displays[0]], preferred, displays[0], false)), [10]);
  // No displays at all yields no overlays rather than a phantom window.
  assert.deepEqual(resolveOverlayDisplays([], preferred, displays[0], true), []);
  assert.deepEqual(resolveOverlayDisplays([], preferred, displays[0], false), []);
});

test("the all-displays tick is persisted, local-only, and reconciles every surface", async () => {
  const [main, preload, controllerJs, controllerHtml, settingsStore] = await Promise.all([
    fs.readFile(path.join(PROJECT_ROOT, "electron/main.js"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, "electron/preload.js"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, "public/subtitle-controller.js"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, "public/subtitle-controller.html"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, "src/settings-store.js"), "utf8"),
  ]);

  // Persisted like the display selection, so the choice survives a restart.
  assert.match(settingsStore, /overlayAllDisplays: true/u);
  assert.match(settingsStore, /overlayAllDisplays must be a boolean/u);
  assert.match(main, /overlayAllDisplays = settings\.subtitle\?\.overlayAllDisplays !== false/u);

  // Same origin fence as every other overlay IPC, and a boolean-only payload.
  const handler = main.slice(
    main.indexOf('ipcMain.handle("subtitle-overlay:set-all-displays"'),
    main.indexOf('ipcMain.handle("subtitle-overlay:get-enabled"'),
  );
  assert.ok(handler.length > 0, "the all-displays IPC handler must exist");
  assert.match(handler, /isAllowedOrigin\(event\.sender\.getURL\(\), new Set\(\[localAppOrigin\]\)\)/u);
  assert.match(handler, /typeof allDisplays !== "boolean"/u);
  // Persist before reconciling, and roll the in-memory flag back on failure so
  // the windows can never disagree with the saved setting.
  assert.match(handler, /await settingsStore\.save\(\{ subtitle: \{ overlayAllDisplays, overlayDisplayIds: null \} \}\)/u);
  assert.match(handler, /catch \(error\)[\s\S]{0,80}overlayAllDisplays = previous/u);
  assert.match(handler, /syncOverlayBounds\(\)[\s\S]{0,200}notifyOverlayDisplaysChanged\(\)/u);
  assert.match(preload, /setOverlayAllDisplays: \(allDisplays\) => ipcRenderer\.invoke\("subtitle-overlay:set-all-displays", allDisplays\)/u);

  assert.match(controllerHtml, /id="controller-display-options"/u);
  assert.match(controllerJs, /input.type = "checkbox"/u);
  assert.match(controllerJs, /selectOverlayDisplays\(ids\)/u);
  assert.match(preload, /subtitle-overlay:select-displays/u);

});

test("controller uses primary fallback independently of overlay and shares the only display", () => {
  assert.equal(resolveControllerDisplay(displays, displays[1], displays[0]).id, 10);
  assert.equal(resolveControllerDisplay(displays, displays[0], displays[0]).id, 10);
  assert.equal(resolveControllerDisplay([displays[0]], displays[0], displays[0]).id, 10);
});
