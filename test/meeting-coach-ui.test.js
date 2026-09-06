import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const PUBLIC = path.join(process.cwd(), "public");

async function readPublic(name) {
  return readFile(path.join(PUBLIC, name), "utf8");
}

test("Meeting Coach renderers use safe text nodes and the canonical brief fields", async () => {
  const [prep, record, response] = await Promise.all([
    readPublic("meeting-coach-prep.js"),
    readPublic("meeting-coach-record.js"),
    readPublic("meeting-coach-response.js"),
  ]);
  for (const source of [prep, record, response]) {
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/u);
    assert.match(source, /textContent/u);
  }
  assert.match(prep, /agenda/u);
  assert.match(prep, /knownUnknowns/u);
  assert.match(prep, /meetingCoachStart/u);
  assert.match(response, /READY_GROUNDED/u);
  assert.match(response, /evidenceRefs/u);
  assert.match(record, /endedAt/u);
});

test("Meeting Coach Record uses the shared bounded transcript renderer without replacing its state surface", async () => {
  const [record, coreCss] = await Promise.all([
    readPublic("meeting-coach-record.js"),
    readPublic("nova-core.css"),
  ]);

  assert.match(record, /from "\/nova-transcript\.js"/u);
  assert.match(record, /createNovaTranscriptRenderer\(/u);
  assert.match(record, /adaptMeetingCoachTurn/u);
  assert.match(record, /transcriptRenderer\.replace\(/u);
  assert.doesNotMatch(record, /turns\.map\(renderTurn\)/u);
  assert.equal(record.match(/feed\.replaceChildren\(/gu)?.length, 1);
  assert.match(coreCss, /\.nova-transcript-row/u);
  assert.match(coreCss, /\.nova-transcript-row__source/u);
  assert.match(coreCss, /\.nova-transcript-row__translation/u);
});

test("Meeting Coach controls keep keyboard focus and 44px target metrics", async () => {
  const css = await readPublic("meeting-coach.css");
  assert.match(css, /:focus-visible\s*\{/u);
  assert.match(css, /\.coach-button,[\s\S]*?\.coach-chip[\s\S]*?min-height:\s*44px/u);
  assert.doesNotMatch(css, /\.coach-chip\s*\{[\s\S]*?min-height:\s*(?:3[0-9]|4[0-3])px/u);
  assert.doesNotMatch(css.replace(/:root\s*\{[\s\S]*?\}/u, ""), /#[0-9a-f]{3,8}/iu);
});

test("Meeting Coach follows the preview-first NOVA shell and flat Field/List contracts", async () => {
  const [prep, record, response, css] = await Promise.all([
    readPublic("meeting-coach-prep.html"),
    readPublic("meeting-coach-record.html"),
    readPublic("meeting-coach-response.html"),
    readPublic("meeting-coach.css"),
  ]);

  for (const html of [prep, record, response]) {
    assert.match(html, /class="coach-wordmark"[^>]*aria-label="NOVA"[^>]*>NOVA</u);
  }
  assert.ok(prep.indexOf('class="coach-panel prep-brief-panel"') < prep.indexOf('class="coach-panel prep-conversation-panel"'));
  assert.doesNotMatch(css, /:root\s*\{/u);
  assert.doesNotMatch(css, /linear-gradient|#[0-9a-f]{3,8}\b/iu);
  assert.match(css, /\.coach-form\s*\{[^}]*gap:\s*0;/u);
  assert.match(css, /\.coach-field\s*\{[^}]*min-height:\s*56px;[^}]*border-bottom:\s*1px solid var\(--nova-surface-hairline\);/u);
  assert.match(css, /@media \(max-width:\s*540px\)[\s\S]*?\.coach-field\s*\{[^}]*grid-template-columns:\s*1fr;/u);
});

test("Meeting Coach windows enforce a strict local-only content policy", async () => {
  const pages = await Promise.all([
    readPublic("meeting-coach-prep.html"),
    readPublic("meeting-coach-record.html"),
    readPublic("meeting-coach-response.html"),
  ]);
  const policy = /default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:/u;
  for (const html of pages) {
    assert.match(html, /http-equiv="Content-Security-Policy"/u);
    assert.match(html, policy);
    assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|ws:\/\//u);
  }
});

test("Meeting prep exposes a continuous accessible conversation and one canonical streaming contract", async () => {
  const [html, source] = await Promise.all([
    readPublic("meeting-coach-prep.html"),
    readPublic("meeting-coach-prep.js"),
  ]);

  assert.match(html, /id="prep-conversation"[^>]*role="log"[^>]*aria-live="polite"/u);
  assert.match(html, /id="interview-form"/u);
  assert.match(html, /id="interview-message"/u);
  assert.match(html, /id="send-interview"/u);
  assert.match(source, /snapshot\.prepMessages/u);
  assert.match(source, /snapshot\.prepLane/u);
  assert.match(source, /prepLane\.partialText/u);
  assert.doesNotMatch(source, /data\?\.messages|conversationHistory|interviewHistory/u);
});

test("Response coach never retains an automatic recommendation after the lane returns to idle", async () => {
  const source = await readPublic("meeting-coach-response.js");

  assert.doesNotMatch(source, /lastReadyAuto/u);
  assert.match(source, /statusValue === "IDLE"/u);
  assert.match(source, /automaticList\.replaceChildren\(renderEmptyState\("다음 질문 대기"\)\)/u);
  assert.match(source, /statusValue === "GENERATING"/u);
  assert.match(source, /renderLoadingCard/u);
});

test("Response Coach makes the recommendation the primary stage with use, copy, retry, and collapsible evidence", async () => {
  const html = await readPublic("meeting-coach-response.html");
  assert.match(html, /class="coach-panel recommendation-stage"/u);
  assert.match(html, /id="use-suggestion"/u);
  assert.match(html, /id="copy-suggestion"/u);
  assert.match(html, /id="regenerate-answer"/u);
  assert.match(html, /id="arrange-windows"[^>]*class="coach-button secondary"/u);
  assert.match(html, /<details[^>]*id="evidence-details"/u);
  assert.match(html, /<summary[^>]*>근거/u);
  const source = await readPublic("meeting-coach-response.js");
  assert.match(source, /meetingCoachArrangeWindows/u);
});

test("Response coach removes a ready answer as soon as an idle auto-lane snapshot arrives", async () => {
  const source = await readPublic("meeting-coach-response.js");
  const listeners = new Map();
  const elements = new Map();

  function makeElement(id) {
    const attributes = new Map();
    const classes = new Set();
    return {
      id,
      value: "",
      textContent: "",
      className: "",
      children: [],
      dataset: {},
      hidden: false,
      disabled: false,
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
        contains(name) {
          return classes.has(name);
        },
      },
      addEventListener(type, listener) {
        listeners.set(`${id}:${type}`, listener);
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
      requestSubmit() {},
    };
  }

  const ids = [
    "coach-status",
    "ready-state",
    "latest-question",
    "latest-question-ko",
    "evidence-summary",
    "source-list",
    "automatic-state",
    "manual-state",
    "automatic-list",
    "suggestion-actions",
    "use-suggestion",
    "copy-suggestion",
    "manual-list",
    "coach-composer",
    "composer-form",
    "regenerate-answer",
  ];
  for (const id of ids) elements.set(id, makeElement(id));

  /** @type {((snapshot: Record<string, unknown>) => void) | null} */
  let snapshotListener = null;
  let copiedText = "";
  const usedRequests = [];
  const initial = {
    seq: 1,
    state: "LIVE",
    currentQuestion: { turnId: "turn-1", english: "Any issues?", korean: "문제가 있나요?" },
    autoLane: { status: "READY_GROUNDED", sourceTurnId: "turn-1", result: { english: "No issues.", korean: "문제 없습니다." } },
    manualLane: { status: "IDLE" },
  };
  const bridge = {
    meetingCoachGetSnapshot: async () => ({ ok: true, data: initial }),
    meetingCoachAnswerTurn: async () => ({ ok: true, data: {} }),
    meetingCoachManualAction: async () => ({ ok: true, data: {} }),
    meetingCoachUseRecommendation: async (request) => {
      usedRequests.push(request);
      return { ok: true, data: { sourceTurnId: request.sourceTurnId } };
    },
    onMeetingCoachSnapshot(listener) {
      snapshotListener = listener;
    },
  };
  const flattenText = (node) => [node?.textContent, ...(node?.children ?? []).flatMap(flattenText)].filter(Boolean).join(" ");

  vm.runInNewContext(source, {
    window: { realtimeNoelDesktop: bridge },
    document: {
      getElementById(id) {
        return elements.get(id);
      },
      querySelectorAll() {
        return [];
      },
      createElement(tagName) {
        return makeElement(tagName);
      },
    },
    navigator: {
      clipboard: {
        async writeText(text) {
          copiedText = text;
        },
      },
    },
    Error,
    Map,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.match(flattenText(elements.get("automatic-list")), /No issues\./u);
  assert.equal(elements.get("suggestion-actions").hidden, false);

  await listeners.get("use-suggestion:click")();
  assert.deepEqual(usedRequests.map((request) => request.sourceTurnId), ["turn-1"]);
  assert.equal(elements.get("automatic-list").classList.contains("is-used"), true);
  assert.equal(elements.get("automatic-state").textContent, "사용 중");

  await listeners.get("copy-suggestion:click")();
  assert.equal(copiedText, "No issues.");

  if (typeof snapshotListener !== "function") throw new Error("Meeting Coach snapshot listener was not registered");
  snapshotListener({
    ...initial,
    seq: 2,
    currentQuestion: { turnId: "turn-2", english: "What is next?", korean: "다음은 무엇인가요?" },
    autoLane: { status: "GENERATING", sourceTurnId: "turn-2", partialText: "" },
  });
  assert.doesNotMatch(flattenText(elements.get("automatic-list")), /No issues\./u);
  assert.equal(elements.get("suggestion-actions").hidden, true);
  assert.equal(elements.get("automatic-list").classList.contains("is-replacing"), true);

  snapshotListener({
    ...initial,
    seq: 3,
    currentQuestion: null,
    autoLane: { status: "IDLE" },
  });
  const clearedText = flattenText(elements.get("automatic-list"));
  assert.equal(clearedText, "다음 질문 대기");
  assert.doesNotMatch(clearedText, /No issues\./u);
});

test("Response coach marks a recommendation used only after IPC success", async () => {
  const source = await readPublic("meeting-coach-response.js");
  const listeners = new Map();
  const elements = new Map();

  function makeElement(id) {
    const classes = new Set();
    return {
      id,
      value: "",
      textContent: "",
      className: "",
      children: [],
      dataset: {},
      hidden: false,
      disabled: false,
      classList: {
        toggle(name, force) { if (force === true) classes.add(name); else classes.delete(name); },
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      addEventListener(type, listener) { listeners.set(`${id}:${type}`, listener); },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute() {},
      getAttribute() { return null; },
      requestSubmit() {},
    };
  }
  for (const id of [
    "coach-status", "ready-state", "latest-question", "latest-question-ko", "evidence-summary",
    "source-list", "automatic-state", "manual-state", "automatic-list", "suggestion-actions",
    "use-suggestion", "copy-suggestion", "manual-list", "coach-composer", "composer-form", "regenerate-answer",
  ]) elements.set(id, makeElement(id));

  const initial = {
    seq: 1,
    state: "LIVE",
    currentQuestion: { turnId: "turn-1", english: "Any issues?", korean: "문제가 있나요?" },
    autoLane: { status: "READY_GROUNDED", sourceTurnId: "turn-1", result: { english: "No issues.", korean: "문제 없습니다." } },
    manualLane: { status: "IDLE" },
    usedRecommendations: [],
  };
  const bridge = {
    meetingCoachGetSnapshot: async () => ({ ok: true, data: initial }),
    meetingCoachAnswerTurn: async () => ({ ok: true, data: {} }),
    meetingCoachManualAction: async () => ({ ok: true, data: {} }),
    meetingCoachUseRecommendation: async () => ({ ok: false, code: "FAILED" }),
    onMeetingCoachSnapshot() {},
  };

  vm.runInNewContext(source, {
    window: { realtimeNoelDesktop: bridge },
    document: {
      getElementById(id) { return elements.get(id); },
      querySelectorAll() { return []; },
      createElement(tagName) { return makeElement(tagName); },
    },
    navigator: { clipboard: { async writeText() {} } },
    Error,
    Map,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await listeners.get("use-suggestion:click")();
  assert.equal(elements.get("automatic-list").classList.contains("is-used"), false);
  assert.equal(elements.get("automatic-state").textContent, "사용 실패");
});

test("Response coach clears manual answers across ended, idle, and coach-session boundaries", async () => {
  const source = await readPublic("meeting-coach-response.js");
  const listeners = new Map();
  const elements = new Map();

  function makeElement(id) {
    const attributes = new Map();
    const classes = new Set();
    return {
      id,
      value: "",
      textContent: "",
      className: "",
      children: [],
      dataset: {},
      hidden: false,
      disabled: false,
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
        listeners.set(`${id}:${type}`, listener);
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
      requestSubmit() {},
    };
  }

  const ids = [
    "coach-status",
    "ready-state",
    "latest-question",
    "latest-question-ko",
    "evidence-summary",
    "source-list",
    "automatic-state",
    "manual-state",
    "automatic-list",
    "suggestion-actions",
    "use-suggestion",
    "copy-suggestion",
    "manual-list",
    "coach-composer",
    "composer-form",
    "regenerate-answer",
  ];
  for (const id of ids) elements.set(id, makeElement(id));

  /** @type {((snapshot: Record<string, unknown>) => void) | null} */
  let snapshotListener = null;
  let manualActionCount = 0;
  const initial = {
    seq: 1,
    coachSessionId: "coach-a",
    state: "LIVE",
    currentQuestion: null,
    autoLane: { status: "IDLE" },
    manualLane: { status: "READY_GROUNDED", result: { english: "Old manual answer", korean: "이전 수동 답변" } },
  };
  const bridge = {
    meetingCoachGetSnapshot: async () => ({ ok: true, data: initial }),
    meetingCoachAnswerTurn: async () => ({ ok: true, data: {} }),
    meetingCoachManualAction: async () => {
      manualActionCount += 1;
      return { ok: true, data: {} };
    },
    meetingCoachUseRecommendation: async () => ({ ok: true, data: {} }),
    onMeetingCoachSnapshot(listener) {
      snapshotListener = listener;
    },
  };
  const flattenText = (node) => [node?.textContent, ...(node?.children ?? []).flatMap(flattenText)].filter(Boolean).join(" ");

  vm.runInNewContext(source, {
    window: { realtimeNoelDesktop: bridge },
    document: {
      getElementById(id) {
        return elements.get(id);
      },
      querySelectorAll() {
        return [];
      },
      createElement(tagName) {
        return makeElement(tagName);
      },
    },
    Error,
    Map,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.match(flattenText(elements.get("manual-list")), /Old manual answer/u);
  if (typeof snapshotListener !== "function") throw new Error("Meeting Coach snapshot listener was not registered");

  snapshotListener({ ...initial, seq: 2, state: "ENDED" });
  assert.equal(flattenText(elements.get("manual-list")), "요청 대기");

  snapshotListener({
    ...initial,
    seq: 3,
    manualLane: { status: "READY_GROUNDED", result: { english: "Fresh answer", korean: "새 답변" } },
  });
  assert.match(flattenText(elements.get("manual-list")), /Fresh answer/u);

  snapshotListener({
    ...initial,
    seq: 4,
    coachSessionId: "coach-b",
    manualLane: { status: "IDLE" },
  });
  assert.equal(flattenText(elements.get("manual-list")), "요청 대기");
  assert.equal(elements.get("manual-state").textContent, "대기");

  listeners.get("composer-form:submit")({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manualActionCount, 0);
});

test("Meeting Coach composers send on Enter and keep Shift+Enter for a new line", async () => {
  const [prep, response] = await Promise.all([
    readPublic("meeting-coach-prep.js"),
    readPublic("meeting-coach-response.js"),
  ]);

  for (const source of [prep, response]) {
    assert.match(source, /event\.key !== "Enter" \|\| event\.shiftKey/u);
    assert.match(source, /event\.preventDefault\(\)/u);
  }
});

test("Meeting prep keeps unsaved form input across unrelated snapshot updates", async () => {
  const source = await readPublic("meeting-coach-prep.js");
  const listeners = new Map();
  const elements = new Map();

  function makeElement(id) {
    return {
      id,
      value: "",
      textContent: "",
      children: [],
      disabled: false,
      readOnly: false,
      scrollHeight: 0,
      scrollTop: 0,
      clientHeight: 0,
      classList: {
        toggle() {},
        remove() {},
      },
      setAttribute() {},
      addEventListener(type, listener) {
        listeners.set(`${id}:${type}`, listener);
      },
      append(...children) {
        this.children.push(...children);
      },
      replaceChildren(...children) {
        this.children = children;
      },
    };
  }

  const ids = [
    "coach-status",
    "brief-title",
    "brief-counterparty",
    "brief-notes",
    "brief-goals",
    "brief-contradictions",
    "interview-message",
    "interview-form",
    "interview-state",
    "prep-conversation",
    "brief-preview",
    "brief-state",
    "save-brief",
    "freeze-brief",
    "send-interview",
    "open-live-windows",
  ];
  for (const id of ids) elements.set(id, makeElement(id));

  /** @type {((snapshot: Record<string, unknown>) => void) | null} */
  let snapshotListener = null;
  const pushSnapshot = (snapshot) => {
    if (typeof snapshotListener !== "function") throw new Error("Meeting Coach snapshot listener was not registered");
    snapshotListener(snapshot);
  };
  const initialBrief = {
    id: "brief-1",
    version: 1,
    status: "DRAFT",
    title: "Server title",
    counterparty: "Panel",
    contextNotes: "Server notes",
    agenda: ["Server agenda"],
    knownUnknowns: [{ topic: "Server unknown" }],
  };
  const bridge = {
    meetingCoachGetSnapshot: async () => ({
      ok: true,
      data: {
        seq: 1,
        state: "PREP",
        brief: initialBrief,
        prepMessages: [
          { id: "message-1", role: "USER", text: "랩탑 현황을 준비할게", createdAt: "2026-08-01T00:00:00.000Z" },
          { id: "message-2", role: "ASSISTANT", text: "현재 수량을 알려주세요.", createdAt: "2026-08-01T00:00:01.000Z" },
        ],
        prepLane: { status: "GENERATING", partialText: "반납 대기 수량도" },
      },
    }),
    meetingCoachSaveDraft: async ({ brief }) => ({ ok: true, data: { brief: { ...brief, id: "brief-1", version: 2 } } }),
    meetingCoachFreezeBrief: async ({ brief }) => ({ ok: true, data: { brief: { ...brief, id: "brief-1", version: 3, status: "FROZEN" } } }),
    meetingCoachInterview: async () => ({ ok: true, data: {} }),
    meetingCoachStart: async () => ({ ok: true, data: {} }),
    meetingCoachOpenLiveWindows: async () => ({ ok: true, data: {} }),
    onMeetingCoachSnapshot(listener) {
      snapshotListener = listener;
    },
  };

  vm.runInNewContext(source, {
    window: { realtimeNoelDesktop: bridge },
    document: {
      getElementById(id) {
        return elements.get(id);
      },
      createElement(tagName) {
        return makeElement(tagName);
      },
    },
    Error,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("brief-title").value, "Server title");
  const restoredConversation = JSON.stringify(elements.get("prep-conversation").children);
  assert.match(restoredConversation, /랩탑 현황을 준비할게/u);
  assert.match(restoredConversation, /현재 수량을 알려주세요/u);
  assert.match(restoredConversation, /반납 대기 수량도/u);

  elements.get("brief-title").value = "Unsaved local title";
  listeners.get("brief-title:input")();

  pushSnapshot({
    seq: 2,
    state: "LIVE",
    brief: { ...initialBrief, title: "Unrelated server title" },
    prepMessages: [],
    prepLane: { status: "IDLE", partialText: "" },
  });
  assert.equal(elements.get("brief-title").value, "Unsaved local title");

  pushSnapshot({
    seq: 3,
    state: "PREP",
    brief: { ...initialBrief, version: 2, title: "Saved server title" },
    prepMessages: [],
    prepLane: { status: "IDLE", partialText: "" },
  });
  assert.equal(elements.get("brief-title").value, "Saved server title");
});
