import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  clearViewerRecoveryContext,
  readViewerRecoveryContext,
  resolveViewerRecoverySelection,
  selectViewerRecoveryLanguage,
  writeViewerRecoveryContext,
} from "./viewer-session-recovery";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const sessionId = "0192d0f4-9f72-7a36-91f5-6a76ef736f41";

test("recovery storage contains only opaque session and presentation context", () => {
  const storage = new MemoryStorage();
  writeViewerRecoveryContext(storage, {
    sessionId,
    language: "ko",
    preferredTargetLanguage: "ko",
    selectedLaneId: "translation:ko",
    expandedTopicIds: ["0192d0f4-9f72-7a36-91f5-6a76ef736f42"],
    anchorUtteranceKey: "gateway:source:7",
    anchorsByLane: { "translation:ko": "gateway:source:7" },
  });
  const serialized = [...storage.values.values()][0] ?? "";
  assert.deepEqual(JSON.parse(serialized), {
    sessionId,
    language: "ko",
    preferredTargetLanguage: "ko",
    selectedLaneId: "translation:ko",
    expandedTopicIds: ["0192d0f4-9f72-7a36-91f5-6a76ef736f42"],
    anchorUtteranceKey: "gateway:source:7",
    anchorsByLane: { "translation:ko": "gateway:source:7" },
  });
  assert.doesNotMatch(serialized, /email|token|company|department|jobTitle|consent|title|summary|text/iu);
  assert.equal(readViewerRecoveryContext(storage)?.selectedLaneId, "translation:ko");
  clearViewerRecoveryContext(storage);
  assert.equal(readViewerRecoveryContext(storage), null);
});

test("tampered recovery context fails closed and language selection stays session-bound", () => {
  const storage = new MemoryStorage();
  storage.setItem("rnw-live-viewer-context-v1", JSON.stringify({ sessionId: "../other", language: "ko", email: "leak@example.com" }));
  assert.equal(readViewerRecoveryContext(storage), null);
  assert.equal(selectViewerRecoveryLanguage("ko", ["en", "ko"]), "ko");
  assert.equal(selectViewerRecoveryLanguage("fr", ["en", "ko"]), "en");
});

test("source refresh preserves the preferred English target and each lane's own reading anchor", () => {
  const storage = new MemoryStorage();
  writeViewerRecoveryContext(storage, {
    sessionId, language: "en", preferredTargetLanguage: "en", selectedLaneId: "source",
    expandedTopicIds: [], anchorUtteranceKey: "source:8",
    anchorsByLane: { source: "source:8", "translation:en": "en:4", "translation:ko": "ko:6" },
  });
  const restored = readViewerRecoveryContext(storage);
  assert.ok(restored);
  assert.deepEqual(resolveViewerRecoverySelection(restored, ["ko", "en"]), {
    language: "en", selectedLaneId: "source", anchorUtteranceKey: "source:8",
  });
  assert.deepEqual(resolveViewerRecoverySelection({ ...restored, selectedLaneId: "translation:en" }, ["ko", "en"]), {
    language: "en", selectedLaneId: "translation:en", anchorUtteranceKey: "en:4",
  });
  assert.deepEqual(resolveViewerRecoverySelection({ ...restored, selectedLaneId: "translation:en" }, ["ko"]), {
    language: "ko", selectedLaneId: "translation:ko", anchorUtteranceKey: "ko:6",
  });
});

test("legacy recovery migrates only its selected lane anchor and rejects extra private fields", () => {
  const storage = new MemoryStorage();
  const legacy = { sessionId, language: "en", selectedLaneId: "source", expandedTopicIds: [], anchorUtteranceKey: "source:2" };
  storage.setItem("rnw-live-viewer-context-v1", JSON.stringify(legacy));
  const restored = readViewerRecoveryContext(storage);
  assert.ok(restored);
  assert.equal(restored.preferredTargetLanguage, "en");
  assert.deepEqual(restored.anchorsByLane, { source: "source:2" });
  storage.setItem("rnw-live-viewer-context-v1", JSON.stringify({ ...restored, token: "not-allowed" }));
  assert.equal(readViewerRecoveryContext(storage), null);
  storage.setItem("rnw-live-viewer-context-v1", JSON.stringify({ ...restored, anchorsByLane: { source: "<script>" } }));
  assert.equal(readViewerRecoveryContext(storage), null);
});

test("viewer restores once through the exact cookie-only endpoint and clears private state on failure or leave", () => {
  const source = readFileSync(resolve(process.cwd(), "components/live/LiveViewer.tsx"), "utf8");
  const contract = readFileSync(resolve(process.cwd(), "components/live/viewer-controller-contract.ts"), "utf8");
  const hook = readFileSync(resolve(process.cwd(), "components/live/useViewerRecovery.ts"), "utf8");
  assert.match(source, /useViewerRecovery\(restoreViewerSession\)/u);
  assert.match(hook, /viewerRestorePromiseRef/u);
  assert.match(source, /fetch\(\s*`\/api\/live-sessions\/\$\{stored\.sessionId\}\/viewer-session`,\s*\{ method: "GET", cache: "no-store" \}/u);
  assert.match(source, /if \(!isViewerJoinData\(result\)\)/u);
  assert.match(contract, /value\.grant\.sessionId === value\.session\.id/u);
  assert.match(contract, /Number\(value\.session\.maxViewers\) <= 200/u);
  assert.doesNotMatch(contract, /Number\(value\.session\.maxViewers\) <= 50/u);
  assert.match(source, /if \(result\.session\.id !== stored\.sessionId\)/u);
  assert.doesNotMatch(source.slice(
    source.indexOf("const restoreViewerSession"),
    source.indexOf("const { isRestoringViewer"),
  ), /subscribe\(/u,
  "restoring a preparing session must wait for the status-gated gateway lifecycle");
  assert.match(source, /connectViewerGatewayOnce/u);
  assert.match(source, /selectedLaneId: restoredLaneId/u);
  assert.match(source, /clearViewerPrivateState\(\)/u);
  assert.match(source, /persistSession: false/u);
  assert.doesNotMatch(source, /interface ViewerState[\s\S]{0,160}accessToken:/u);
});

test("join and language changes persist only non-sensitive recovery context", () => {
  const source = readFileSync(resolve(process.cwd(), "components/live/LiveViewer.tsx"), "utf8");
  assert.match(source, /selectedLaneId: firstLaneId/u);
  assert.match(source, /selectedLaneId: nextLaneId/u);
  assert.match(source, /if \(isRestoringViewer\)[\s\S]*라이브 세션으로 돌아가는 중입니다/u);
});
