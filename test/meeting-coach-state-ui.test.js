import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const PUBLIC = path.join(process.cwd(), "public");

async function readPublic(name) {
  return readFile(path.join(PUBLIC, name), "utf8");
}

function createElement(id) {
  const attributes = new Map();
  const classes = new Set();
  const listeners = new Map();
  return {
    id,
    value: "",
    textContent: "",
    className: "",
    children: [],
    dataset: {},
    hidden: false,
    disabled: false,
    readOnly: false,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    listeners,
    classList: {
      toggle(name, force) {
        if (force === true) classes.add(name);
        else if (force === false) classes.delete(name);
        else if (classes.has(name)) classes.delete(name);
        else classes.add(name);
      },
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    focus() {
      this.isFocused = true;
    },
    requestSubmit() {},
  };
}

function flattenText(node) {
  return [node?.textContent, ...(node?.children ?? []).flatMap(flattenText)].filter(Boolean).join(" ");
}

function findButton(node, label) {
  if (node?.textContent === label) return node;
  for (const child of node?.children ?? []) {
    const match = findButton(child, label);
    if (match) return match;
  }
  return null;
}

test("Meeting Coach prep and record expose actionable NOVA state surfaces", async () => {
  const [prepHtml, recordHtml, prepJs, recordJs, css] = await Promise.all([
    readPublic("meeting-coach-prep.html"),
    readPublic("meeting-coach-record.html"),
    readPublic("meeting-coach-prep.js"),
    readPublic("meeting-coach-record.js"),
    readPublic("meeting-coach.css"),
  ]);

  assert.match(prepHtml, /id="prep-state-surface"[^>]*aria-live="polite"/u);
  assert.match(prepHtml, /id="brief-state-surface"[^>]*aria-live="polite"/u);
  assert.match(recordHtml, /id="record-state-surface"[^>]*aria-live="polite"/u);
  assert.match(recordHtml, /id="arrange-windows"[^>]*class="coach-button secondary"/u);
  assert.match(css, /\.nova-state-action[\s\S]*?min-height:\s*44px/u);
  for (const source of [prepJs, recordJs]) {
    assert.match(source, /nova-empty-state/u);
    assert.match(source, /nova-error-action/u);
    assert.match(source, /nova-permission-state/u);
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/u);
    assert.doesNotMatch(source, /getUserMedia|openScreenRecordingSettings/u);
  }
});

test("Prep shows provider and empty-brief actions without overwriting dirty form data", async () => {
  const source = await readPublic("meeting-coach-prep.js");
  const ids = [
    "coach-status", "brief-title", "brief-counterparty", "brief-notes", "brief-goals",
    "brief-contradictions", "interview-form", "interview-message", "send-interview",
    "interview-state", "prep-conversation", "brief-preview", "brief-state",
    "prep-state-surface", "brief-state-surface", "save-brief", "freeze-brief", "open-live-windows",
  ];
  const elements = new Map(ids.map((id) => [id, createElement(id)]));
  let settingsOpenCount = 0;
  const snapshot = {
    seq: 1,
    state: "PREPARED",
    brief: null,
    prepMessages: [],
    prepLane: { status: "ERROR", error: "GEMINI_RATE_LIMITED", partialText: "" },
    connection: { caption: "DISCONNECTED", provider: "ERROR" },
  };
  const bridge = {
    meetingCoachGetSnapshot: async () => ({ ok: true, data: snapshot }),
    meetingCoachSaveDraft: async ({ brief }) => ({ ok: true, data: { brief } }),
    meetingCoachFreezeBrief: async ({ brief }) => ({ ok: true, data: { brief } }),
    meetingCoachInterview: async () => ({ ok: true, data: {} }),
    meetingCoachStart: async () => ({ ok: true, data: {} }),
    meetingCoachOpenLiveWindows: async () => ({ ok: true, data: {} }),
    meetingCoachOpenRecord: async () => ({ ok: true, data: {} }),
    meetingCoachOpenResponse: async () => ({ ok: true, data: {} }),
    showMainWindow: async () => {
      settingsOpenCount += 1;
      return { ok: true, data: {} };
    },
    onMeetingCoachSnapshot() {},
  };

  vm.runInNewContext(source, {
    window: { realtimeNoelDesktop: bridge, location: { reload() {} } },
    document: {
      getElementById(id) {
        return elements.get(id);
      },
      createElement,
    },
    Error,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(flattenText(elements.get("prep-state-surface")), /AI 응답 오류/u);
  assert.match(flattenText(elements.get("prep-state-surface")), /Gemini 요청 한도를 초과했습니다/u);
  assert.match(flattenText(elements.get("prep-state-surface")), /잠시 후 다시 시도/u);
  assert.doesNotMatch(flattenText(elements.get("prep-conversation")), /GEMINI_RATE_LIMITED/u);
  assert.match(flattenText(elements.get("brief-state-surface")), /브리프를 준비해 주세요/u);
  const settingsButton = findButton(elements.get("prep-state-surface"), "설정 확인");
  assert.ok(settingsButton);
  await settingsButton.listeners.get("click")();
  assert.equal(settingsOpenCount, 1);
});

test("Prep Live start keeps the provider message and gives an agenda recovery action", async () => {
  const source = await readPublic("meeting-coach-prep.js");
  const ids = [
    "coach-status", "brief-title", "brief-counterparty", "brief-notes", "brief-goals",
    "brief-contradictions", "interview-form", "interview-message", "send-interview",
    "interview-state", "prep-conversation", "brief-preview", "brief-state",
    "prep-state-surface", "brief-state-surface", "save-brief", "freeze-brief", "open-live-windows",
  ];
  const elements = new Map(ids.map((id) => [id, createElement(id)]));
  elements.get("brief-title").value = "APAC IT Call";
  elements.get("brief-counterparty").value = "APAC IT Managers";
  elements.get("brief-notes").value = "이번 달 현황";
  const bridge = {
    meetingCoachGetSnapshot: async () => ({
      ok: true,
      data: {
        seq: 1,
        state: "PREPARED",
        brief: null,
        prepMessages: [],
        prepLane: { status: "IDLE", partialText: "" },
        connection: { caption: "CONNECTED", provider: "IDLE" },
      },
    }),
    meetingCoachSaveDraft: async ({ brief }) => ({ ok: true, data: { brief: { ...brief, id: "brief-1", version: 1 } } }),
    meetingCoachFreezeBrief: async () => ({
      ok: false,
      code: "AGENDA_REQUIRED",
      error: "회의 브리프를 확정하려면 안건이 하나 이상 필요합니다.",
    }),
    meetingCoachInterview: async () => ({ ok: true, data: {} }),
    meetingCoachStart: async () => ({ ok: true, data: {} }),
    meetingCoachOpenLiveWindows: async () => ({ ok: true, data: {} }),
    onMeetingCoachSnapshot() {},
  };

  vm.runInNewContext(source, {
    window: { realtimeNoelDesktop: bridge, location: { reload() {} } },
    document: {
      getElementById(id) { return elements.get(id); },
      createElement,
    },
    Error,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await elements.get("open-live-windows").listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));

  const stateText = flattenText(elements.get("brief-state-surface"));
  assert.match(stateText, /Live를 시작할 수 없습니다/u);
  assert.match(stateText, /안건이 하나 이상 필요합니다/u);
  assert.match(stateText, /안건 입력/u);
  assert.doesNotMatch(stateText, /AGENDA_REQUIRED/u);
  const agendaButton = findButton(elements.get("brief-state-surface"), "안건 입력");
  assert.ok(agendaButton);
  await agendaButton.listeners.get("click")();
  assert.equal(elements.get("brief-goals").isFocused, true);
});

test("Response Coach explains its Caption or Live Call dependency and opens NOVA for recovery", async () => {
  const source = await readPublic("meeting-coach-response.js");
  const ids = [
    "coach-status", "ready-state", "latest-question", "latest-question-ko", "evidence-summary",
    "source-list", "automatic-state", "manual-state", "automatic-list", "manual-list",
    "arrange-windows", "suggestion-actions", "use-suggestion", "copy-suggestion",
    "coach-composer", "composer-form", "regenerate-answer",
  ];
  const elements = new Map(ids.map((id) => [id, createElement(id)]));
  let mainWindowOpenCount = 0;
  const bridge = {
    meetingCoachGetSnapshot: async () => ({
      ok: true,
      data: {
        seq: 1,
        coachSessionId: "coach-1",
        state: "LIVE",
        turns: [],
        currentQuestion: null,
        autoLane: { status: "IDLE" },
        manualLane: { status: "IDLE" },
        connection: { caption: "CONNECTED", provider: "READY" },
      },
    }),
    meetingCoachAnswerTurn: async () => ({ ok: true, data: {} }),
    meetingCoachManualAction: async () => ({ ok: true, data: {} }),
    meetingCoachUseRecommendation: async () => ({ ok: true, data: {} }),
    showMainWindow: async () => {
      mainWindowOpenCount += 1;
      return { ok: true, data: {} };
    },
    onMeetingCoachSnapshot() {},
  };

  vm.runInNewContext(source, {
    window: { realtimeNoelDesktop: bridge },
    document: {
      getElementById(id) { return elements.get(id); },
      querySelectorAll() { return []; },
      createElement,
    },
    navigator: { clipboard: { async writeText() {} } },
    Error,
    Map,
    Set,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const stateText = flattenText(elements.get("automatic-list"));
  assert.match(stateText, /자막 또는 Live Call/u);
  assert.match(stateText, /NOVA에서 자막 시작/u);
  const openButton = findButton(elements.get("automatic-list"), "NOVA에서 자막 시작");
  assert.ok(openButton);
  await openButton.listeners.get("click")();
  assert.equal(mainWindowOpenCount, 1);
});

test("Record renders connecting, disconnected, recovered, empty, provider-error, and window-arrange states", async () => {
  const source = await readPublic("meeting-coach-record.js");
  const executableSource = source.replace(/^import \{ createNovaTranscriptRenderer \} from "\/nova-transcript\.js";\n+/u, "");
  const ids = [
    "record-feed", "record-state-surface", "coach-status", "record-state", "record-updated",
    "record-count", "jump-latest", "arrange-windows",
  ];
  const elements = new Map(ids.map((id) => [id, createElement(id)]));
  /** @type {((snapshot: Record<string, unknown>) => void) | null} */
  let snapshotListener = null;
  let responseOpenCount = 0;
  let arrangeCount = 0;
  const initial = {
    seq: 1,
    state: "LIVE",
    turns: [],
    connection: { caption: "CONNECTING", provider: "IDLE" },
  };
  const bridge = {
    meetingCoachGetSnapshot: async () => ({ ok: true, data: initial }),
    meetingCoachOpenResponse: async () => {
      responseOpenCount += 1;
      return { ok: true, data: {} };
    },
    meetingCoachArrangeWindows: async () => {
      arrangeCount += 1;
      return { ok: true, data: {} };
    },
    showMainWindow: async () => ({ ok: true, data: {} }),
    onMeetingCoachSnapshot(listener) {
      snapshotListener = listener;
    },
  };

  vm.runInNewContext(executableSource, {
    window: { realtimeNoelDesktop: bridge, location: { reload() {} } },
    document: {
      getElementById(id) {
        return elements.get(id);
      },
      createElement,
    },
    Error,
    Date,
    createNovaTranscriptRenderer() {
      return {
        replace() {},
        moveToLatest() {},
      };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(flattenText(elements.get("record-state-surface")), /자막 연결 중/u);
  if (typeof snapshotListener !== "function") throw new Error("Record snapshot listener was not registered");

  snapshotListener({ ...initial, seq: 2, connection: { caption: "DISCONNECTED", provider: "IDLE" } });
  assert.match(flattenText(elements.get("record-state-surface")), /자막 연결이 끊겼습니다/u);

  snapshotListener({ ...initial, seq: 3, connection: { caption: "CONNECTED", provider: "READY" } });
  assert.match(flattenText(elements.get("record-state-surface")), /자막 연결이 복구되었습니다/u);

  snapshotListener({ ...initial, seq: 4, connection: { caption: "CONNECTED", provider: "READY" } });
  assert.match(flattenText(elements.get("record-state-surface")), /아직 기록이 없습니다/u);
  const responseButton = findButton(elements.get("record-state-surface"), "응답창 열기");
  assert.ok(responseButton);
  await responseButton.listeners.get("click")();
  assert.equal(responseOpenCount, 1);

  snapshotListener({ ...initial, seq: 5, connection: { caption: "CONNECTED", provider: "ERROR" } });
  assert.match(flattenText(elements.get("record-state-surface")), /AI 응답 오류/u);

  await elements.get("arrange-windows").listeners.get("click")();
  assert.equal(arrangeCount, 1);
  assert.equal(elements.get("coach-status").textContent, "창 정렬됨");
});
