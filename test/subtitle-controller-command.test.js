import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSubtitleControllerCommand } from "../src/subtitle-controller-command.js";

test("appearance preview preserves zero opacity and clamps absolute font size", () => {
  assert.deepEqual(normalizeSubtitleControllerCommand({ command: "opacity", opacity: 0, preview: true }), {
    type: "subtitle:control", command: "opacity", opacity: 0, preview: true,
  });
  assert.equal(normalizeSubtitleControllerCommand({ command: "font-size", fontSize: 500 }).fontSize, 72);
  assert.equal(normalizeSubtitleControllerCommand({ command: "font-size", fontSize: 2 }).fontSize, 18);
  assert.equal(normalizeSubtitleControllerCommand({ command: "font-size", fontSize: 38 }).preview, false);
});

test("malformed values cannot reset appearance or invoke unknown commands", () => {
  for (const opacity of [null, "", "0", NaN, Infinity, undefined]) {
    assert.equal(normalizeSubtitleControllerCommand({ command: "opacity", opacity }), null);
  }
  assert.equal(normalizeSubtitleControllerCommand({ command: "font-size", fontSize: null }), null);
  assert.equal(normalizeSubtitleControllerCommand({ command: "position", position: "outside" }), null);
  assert.equal(normalizeSubtitleControllerCommand({ command: "delete" }), null);
});

test("controller command boundary allows legacy actions without forwarding arbitrary fields", () => {
  assert.deepEqual(normalizeSubtitleControllerCommand({ command: "stop", preview: true, token: "not-forwarded" }), {
    type: "subtitle:control", command: "stop",
  });
  assert.deepEqual(normalizeSubtitleControllerCommand({ command: "font", delta: -2 }), {
    type: "subtitle:control", command: "font", delta: -2,
  });
  assert.deepEqual(normalizeSubtitleControllerCommand({ command: "position", position: "bottom-center", preview: true }), {
    type: "subtitle:control", command: "position", position: "bottom-center", preview: true,
  });
  assert.deepEqual(normalizeSubtitleControllerCommand({ command: "languages", languages: ["en", "invalid", "ja"] }), {
    type: "subtitle:control", command: "languages", languages: ["en", "ja"],
  });
});
