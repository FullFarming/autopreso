const bridge = window.realtimeNoelDesktop;
const status = document.getElementById("coach-status");
const titleInput = document.getElementById("brief-title");
const counterpartyInput = document.getElementById("brief-counterparty");
const notesInput = document.getElementById("brief-notes");
const goalsInput = document.getElementById("brief-goals");
const contradictionsInput = document.getElementById("brief-contradictions");
const interviewForm = document.getElementById("interview-form");
const interviewInput = document.getElementById("interview-message");
const interviewButton = document.getElementById("send-interview");
const interviewState = document.getElementById("interview-state");
const conversation = document.getElementById("prep-conversation");
const preview = document.getElementById("brief-preview");
const briefState = document.getElementById("brief-state");
const prepStateSurface = document.getElementById("prep-state-surface");
const briefStateSurface = document.getElementById("brief-state-surface");
const openLiveWindowsButton = document.getElementById("open-live-windows");

let latestSeq = -1;
let currentBrief = null;
let isBriefDirty = false;
let isConversationPinned = true;
let lastCaptionConnection = null;

function requireBridge() {
  return Boolean(
    bridge?.meetingCoachGetSnapshot
      && bridge?.meetingCoachSaveDraft
      && bridge?.meetingCoachFreezeBrief
      && bridge?.meetingCoachInterview
      && bridge?.meetingCoachStart
      && bridge?.meetingCoachOpenLiveWindows
      && bridge?.onMeetingCoachSnapshot,
  );
}

function unwrap(result) {
  if (!result) throw new Error("NO_RESPONSE");
  if (result.ok === false) {
    const error = new Error(result.error || "Meeting Coach 요청을 처리하지 못했습니다.");
    error.code = String(result.code || "MEETING_COACH_ERROR");
    throw error;
  }
  return result.data;
}

function setStatus(text, tone = "idle") {
  status.textContent = text;
  status.classList.toggle("is-error", tone === "error");
  status.classList.toggle("is-live", tone === "live");
}

function setInterviewState(text, tone = "idle") {
  interviewState.textContent = text;
  interviewState.classList.toggle("is-error", tone === "error");
  interviewState.classList.toggle("is-warn", tone === "warn");
}

function setInterviewBusy(isBusy) {
  interviewButton.disabled = isBusy;
  interviewInput.readOnly = isBusy;
  conversation.setAttribute("aria-busy", String(isBusy));
}

function createStateAction(action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `nova-state-action${action.isPrimary ? "" : " secondary"}`;
  button.textContent = action.label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await action.run();
    } catch {
      setStatus("작업 실패", "error");
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function renderStateSurface(surface, state) {
  if (!surface) return;
  if (!state) {
    surface.hidden = true;
    surface.replaceChildren();
    return;
  }
  surface.hidden = false;
  const panel = document.createElement("section");
  panel.className = `nova-state-panel ${state.className}`;
  const title = document.createElement("strong");
  title.textContent = state.title;
  const message = document.createElement("p");
  message.textContent = state.message;
  const actions = document.createElement("div");
  actions.className = "nova-state-actions";
  actions.append(...state.actions.map(createStateAction));
  panel.append(title, message, actions);
  surface.replaceChildren(panel);
}

async function openMainSettings() {
  await bridge.showMainWindow();
  setStatus("설정 창 열림");
}

async function openCaptionSource() {
  if (typeof bridge?.showMainWindow !== "function") throw new Error("MAIN_WINDOW_UNAVAILABLE");
  await bridge.showMainWindow();
  setStatus("NOVA 열림");
}

function reloadWindow() {
  window.location.reload();
}

const PROVIDER_ERROR_MESSAGES = Object.freeze({
  GEMINI_API_KEY_REQUIRED: "Gemini API 키가 없습니다. 설정에서 API 키를 입력한 뒤 다시 시도하세요.",
  GEMINI_AUTH_FAILED: "Gemini API 키를 확인할 수 없습니다. 설정에서 키를 확인한 뒤 다시 시도하세요.",
  GEMINI_RATE_LIMITED: "Gemini 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.",
  GEMINI_TIMEOUT: "Gemini 응답 시간이 초과되었습니다. 잠시 후 다시 시도하세요.",
  GEMINI_UNAVAILABLE: "Gemini 연결을 시작할 수 없습니다. 네트워크와 설정을 확인한 뒤 다시 시도하세요.",
  GEMINI_FAILED: "Gemini 응답을 생성하지 못했습니다. 잠시 후 다시 시도하세요.",
});

function providerErrorMessage(value) {
  const text = String(value ?? "").trim();
  if (Object.hasOwn(PROVIDER_ERROR_MESSAGES, text)) return PROVIDER_ERROR_MESSAGES[text];
  if (text && !/^[A-Z][A-Z0-9_]+$/u.test(text)) return text;
  return "AI 응답을 생성하지 못했습니다. 설정을 확인한 뒤 다시 시도하세요.";
}

function renderPrepConnectionState(snapshot) {
  const caption = snapshot.connection?.caption ?? "CONNECTING";
  const provider = snapshot.connection?.provider ?? "IDLE";
  const wasReconnected = lastCaptionConnection !== null
    && lastCaptionConnection !== "CONNECTED"
    && caption === "CONNECTED";
  lastCaptionConnection = caption;

  if (provider === "ERROR") {
    renderStateSurface(prepStateSurface, {
      className: "nova-error-action",
      title: "AI 응답 오류",
      message: providerErrorMessage(snapshot.prepLane?.error),
      actions: [
        { label: "다시 불러오기", isPrimary: true, run: () => refresh({ force: true }) },
        { label: "설정 확인", run: openMainSettings },
      ],
    });
    return;
  }
  if (caption === "DISCONNECTED") {
    renderStateSurface(prepStateSurface, {
      className: "nova-error-action",
      title: "자막 연결이 끊겼습니다",
      message: "회의 연결과 자막 설정을 확인하세요.",
      actions: [
        { label: "다시 불러오기", isPrimary: true, run: () => refresh({ force: true }) },
        { label: "설정 확인", run: openMainSettings },
      ],
    });
    return;
  }
  if (caption === "CONNECTING") {
    renderStateSurface(prepStateSurface, {
      className: "nova-permission-state",
      title: "자막 연결 중",
      message: "연결이 완료될 때까지 기다리거나 설정을 확인하세요.",
      actions: [
        { label: "다시 불러오기", isPrimary: true, run: () => refresh({ force: true }) },
        { label: "설정 확인", run: openMainSettings },
      ],
    });
    return;
  }
  if (wasReconnected) {
    renderStateSurface(prepStateSurface, {
      className: "nova-success-state",
      title: "자막 연결이 복구되었습니다",
      message: "회의 기록과 응답 코치를 열 수 있습니다.",
      actions: [
        { label: "기록창 열기", isPrimary: true, run: () => bridge.meetingCoachOpenRecord() },
        { label: "응답창 열기", run: () => bridge.meetingCoachOpenResponse() },
      ],
    });
    return;
  }
  if (snapshot.state === "LIVE" && (snapshot.turns?.length ?? 0) === 0) {
    renderStateSurface(prepStateSurface, {
      className: "nova-permission-state",
      title: "질문 기록을 기다리고 있습니다",
      message: "NOVA 메인 창에서 자막 또는 Live Call을 시작해야 상대방 질문을 기록할 수 있습니다.",
      actions: [{ label: "NOVA에서 자막 시작", isPrimary: true, run: openCaptionSource }],
    });
    return;
  }
  renderStateSurface(prepStateSurface, null);
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message.trim() : "";
  return message && !/^[A-Z][A-Z0-9_]+$/u.test(message)
    ? message
    : "Meeting Coach 요청을 처리하지 못했습니다.";
}

function renderLiveStartError(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = safeErrorMessage(error);
  if (code === "AGENDA_REQUIRED") {
    renderStateSurface(briefStateSurface, {
      className: "nova-error-action",
      title: "Live를 시작할 수 없습니다",
      message: `${message} 안건을 한 줄 이상 입력한 뒤 다시 시작하세요.`,
      actions: [{ label: "안건 입력", isPrimary: true, run: () => goalsInput.focus() }],
    });
    return;
  }
  if (code === "SESSION_NOT_READY" || code === "FROZEN_BRIEF_NOT_FOUND") {
    renderStateSurface(briefStateSurface, {
      className: "nova-error-action",
      title: "Live Coach가 준비되지 않았습니다",
      message: `${message} 브리프를 확정한 뒤 다시 시작하세요.`,
      actions: [{ label: "브리프 확인", isPrimary: true, run: () => titleInput.focus() }],
    });
    return;
  }
  if (code.startsWith("GEMINI_")) {
    renderStateSurface(briefStateSurface, {
      className: "nova-error-action",
      title: "AI 연결을 확인해 주세요",
      message: `${message} 설정을 확인한 뒤 다시 시작하세요.`,
      actions: [{ label: "설정 확인", isPrimary: true, run: openMainSettings }],
    });
    return;
  }
  renderStateSurface(briefStateSurface, {
    className: "nova-error-action",
    title: "Live를 시작할 수 없습니다",
    message: `${message} 브리프와 설정을 확인한 뒤 다시 시작하세요.`,
    actions: [{ label: "브리프 확인", isPrimary: true, run: () => titleInput.focus() }],
  });
}

function renderBriefEmptyState(brief) {
  if (brief) {
    renderStateSurface(briefStateSurface, null);
    return;
  }
  renderStateSurface(briefStateSurface, {
    className: "nova-empty-state",
    title: "브리프를 준비해 주세요",
    message: "회의 정보와 확인할 내용을 먼저 작성하세요.",
    actions: [
      { label: "브리프 작성", isPrimary: true, run: () => titleInput.focus() },
      { label: "다시 불러오기", run: () => refresh({ force: true }) },
    ],
  });
}

function setBridgeError() {
  setStatus("연결 오류", "error");
  setInterviewState("연결 오류", "error");
  renderMessage("앱을 다시 열어 주세요");
  renderStateSurface(prepStateSurface, {
    className: "nova-error-action",
    title: "앱 연결 오류",
    message: "회의 준비 창을 다시 불러오세요.",
    actions: [{ label: "다시 불러오기", isPrimary: true, run: reloadWindow }],
  });
}

function renderMessage(text) {
  preview.replaceChildren();
  const card = document.createElement("article");
  card.className = "brief-card";
  const label = document.createElement("strong");
  label.textContent = "상태";
  const body = document.createElement("p");
  body.textContent = text;
  card.append(label, body);
  preview.append(card);
}

function renderCard(labelText, bodyText, className = "brief-card") {
  const card = document.createElement("article");
  card.className = className;
  const label = document.createElement("strong");
  label.textContent = labelText;
  const body = document.createElement("p");
  body.textContent = bodyText || "-";
  card.append(label, body);
  return card;
}

function renderConversationMessage(message, options = {}) {
  const row = document.createElement("article");
  const isUser = message?.role === "USER";
  row.className = `prep-message ${isUser ? "is-user" : "is-assistant"}${options.isStreaming ? " is-streaming" : ""}${options.isError ? " is-error" : ""}`;

  const label = document.createElement("strong");
  label.textContent = isUser ? "나" : "AI";
  const text = document.createElement("p");
  text.textContent = message?.text || options.emptyText || "";
  row.append(label, text);
  return row;
}

function renderConversation(messages, prepLane) {
  const nodes = (Array.isArray(messages) ? messages : []).map((message) => renderConversationMessage(message));
  if (prepLane?.status === "GENERATING") {
    nodes.push(renderConversationMessage(
      { role: "ASSISTANT", text: prepLane.partialText },
      { isStreaming: true, emptyText: "생각 중" },
    ));
  } else if (prepLane?.status === "ERROR") {
    nodes.push(renderConversationMessage(
      { role: "ASSISTANT", text: providerErrorMessage(prepLane.error) },
      { isError: true },
    ));
  }

  if (nodes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "conversation-empty";
    empty.textContent = "회의 정보를 말해 주세요";
    nodes.push(empty);
  }
  conversation.replaceChildren(...nodes);
  if (isConversationPinned) conversation.scrollTop = conversation.scrollHeight;
}

function readBrief() {
  const base = currentBrief ?? {};
  return {
    ...base,
    title: titleInput.value.trim(),
    counterparty: counterpartyInput.value.trim(),
    contextNotes: notesInput.value.trim(),
    agenda: goalsInput.value.split("\n").map((item) => item.trim()).filter(Boolean),
    knownUnknowns: contradictionsInput.value.split("\n")
      .map((topic) => topic.trim())
      .filter(Boolean)
      .map((topic) => ({ topic })),
    status: "DRAFT",
  };
}

function briefVersion(brief) {
  return Number.isFinite(Number(brief?.version)) ? Number(brief.version) : 0;
}

function isRealBriefUpdate(nextBrief) {
  if (!nextBrief) return false;
  if (!currentBrief) return true;
  if (nextBrief.id && currentBrief.id && nextBrief.id !== currentBrief.id) return true;
  if (nextBrief.id && !currentBrief.id) return true;
  return briefVersion(nextBrief) > briefVersion(currentBrief);
}

function shouldApplyBrief(nextBrief) {
  if (!nextBrief) return false;
  if (!isBriefDirty) return true;
  return isRealBriefUpdate(nextBrief);
}

function fillBrief(brief) {
  if (!brief) return;
  titleInput.value = brief.title ?? "";
  counterpartyInput.value = brief.counterparty ?? counterpartyInput.value;
  notesInput.value = brief.contextNotes ?? notesInput.value;
  goalsInput.value = Array.isArray(brief.agenda) ? brief.agenda.join("\n") : goalsInput.value;
  contradictionsInput.value = Array.isArray(brief.knownUnknowns)
    ? brief.knownUnknowns.map((item) => item.topic).join("\n")
    : contradictionsInput.value;
}

function renderBrief(brief) {
  currentBrief = brief;
  preview.replaceChildren(
    renderCard("회의", brief?.title ?? ""),
    renderCard("상대", brief?.counterparty ?? ""),
    renderCard("안건", Array.isArray(brief?.agenda) ? brief.agenda.join("\n") : ""),
    renderCard("확인된 사실", Array.isArray(brief?.verifiedFacts) ? brief.verifiedFacts.map((fact) => `${fact.label}: ${fact.value}`).join("\n") : ""),
    renderCard("확인 필요", Array.isArray(brief?.knownUnknowns) ? brief.knownUnknowns.map((item) => item.topic).join("\n") : "", "ack-card"),
  );
  briefState.textContent = brief?.id ? `v${brief.version ?? 1}` : "초안";
  briefState.classList.toggle("is-warn", !brief?.id);
}

function applyBriefToForm(brief) {
  fillBrief(brief);
  renderBrief(brief);
  isBriefDirty = false;
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot.seq !== "number" || snapshot.seq <= latestSeq) return;
  latestSeq = snapshot.seq;
  if (shouldApplyBrief(snapshot.brief)) {
    applyBriefToForm(snapshot.brief);
  } else {
    renderBrief(currentBrief ?? snapshot.brief ?? readBrief());
  }

  const prepLane = snapshot.prepLane ?? { status: "IDLE", partialText: "" };
  renderConversation(snapshot.prepMessages, prepLane);
  if (prepLane.status === "GENERATING") {
    setInterviewState("작성 중", "warn");
    setInterviewBusy(true);
  } else if (prepLane.status === "ERROR") {
    setInterviewState("다시 시도", "error");
    setInterviewBusy(false);
  } else {
    setInterviewState("대기");
    setInterviewBusy(false);
  }
  renderPrepConnectionState(snapshot);
  renderBriefEmptyState(snapshot.brief);
  setStatus(snapshot.state ?? "준비", snapshot.state === "LIVE" ? "live" : "idle");
}

async function refresh(options = {}) {
  if (!requireBridge()) {
    setBridgeError();
    return;
  }
  try {
    const snapshot = unwrap(await bridge.meetingCoachGetSnapshot());
    if (options.force && snapshot?.seq === latestSeq) {
      renderPrepConnectionState(snapshot);
      renderBriefEmptyState(snapshot.brief);
    } else {
      applySnapshot(snapshot);
    }
  } catch {
    setStatus("불러오기 실패", "error");
    renderStateSurface(prepStateSurface, {
      className: "nova-error-action",
      title: "회의 준비를 불러오지 못했습니다",
      message: "연결과 설정을 확인한 뒤 다시 시도하세요.",
      actions: [
        { label: "다시 불러오기", isPrimary: true, run: () => refresh({ force: true }) },
        { label: "설정 확인", run: openMainSettings },
      ],
    });
  }
}

async function saveDraft() {
  if (!requireBridge()) return setBridgeError();
  try {
    setStatus("저장 중", "live");
    const data = unwrap(await bridge.meetingCoachSaveDraft({ brief: readBrief() }));
    const brief = data?.brief ?? data;
    applyBriefToForm(brief ?? readBrief());
    setStatus("저장됨");
  } catch {
    setStatus("저장 실패", "error");
  }
}

async function freezeBrief() {
  if (!requireBridge()) return setBridgeError();
  try {
    setStatus("확정 중", "live");
    const data = unwrap(await bridge.meetingCoachFreezeBrief({ brief: readBrief() }));
    const brief = data?.brief ?? data;
    applyBriefToForm(brief ?? currentBrief ?? readBrief());
    briefState.textContent = `v${brief?.version ?? 1}`;
    briefState.classList.remove("is-warn");
    setStatus("확정됨");
  } catch {
    setStatus("확정 실패", "error");
  }
}

async function sendInterview() {
  if (!requireBridge()) return setBridgeError();
  const message = interviewInput.value.trim();
  if (!message || interviewButton.disabled) return;
  try {
    setInterviewBusy(true);
    setInterviewState("작성 중", "warn");
    setStatus("논의 중", "live");
    interviewInput.value = "";
    const data = unwrap(await bridge.meetingCoachInterview({ message }));
    if (data?.brief) applyBriefToForm(data.brief);
  } catch (error) {
    interviewInput.value = message;
    setInterviewBusy(false);
    setInterviewState("다시 시도", "error");
    setStatus("논의 실패", "error");
    renderStateSurface(prepStateSurface, {
      className: "nova-error-action",
      title: "AI 응답을 생성하지 못했습니다",
      message: providerErrorMessage(error instanceof Error ? error.message : error),
      actions: [
        { label: "다시 보내기", isPrimary: true, run: () => sendInterview() },
        { label: "설정 확인", run: openMainSettings },
      ],
    });
  }
}

document.getElementById("save-brief").addEventListener("click", () => void saveDraft());
document.getElementById("freeze-brief").addEventListener("click", () => void freezeBrief());
interviewForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendInterview();
});
interviewInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  void sendInterview();
});
conversation.addEventListener("scroll", () => {
  isConversationPinned = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight <= 48;
});
openLiveWindowsButton.addEventListener("click", async () => {
  if (!requireBridge()) return setBridgeError();
  openLiveWindowsButton.disabled = true;
  openLiveWindowsButton.setAttribute("aria-busy", "true");
  try {
    let brief = currentBrief;
    if (brief?.status !== "FROZEN") {
      const savedData = unwrap(await bridge.meetingCoachSaveDraft({ brief: readBrief() }));
      const saved = savedData?.brief ?? savedData;
      const frozenData = unwrap(await bridge.meetingCoachFreezeBrief({ brief: saved }));
      brief = frozenData?.brief ?? frozenData;
      currentBrief = brief;
      applyBriefToForm(brief);
    }
    unwrap(await bridge.meetingCoachStart({ briefId: brief.id, sourceSessionId: "pending" }));
    unwrap(await bridge.meetingCoachOpenLiveWindows());
    setStatus("Live", "live");
  } catch (error) {
    setStatus("Live 시작 실패", "error");
    renderLiveStartError(error);
  } finally {
    openLiveWindowsButton.disabled = false;
    openLiveWindowsButton.setAttribute("aria-busy", "false");
  }
});

for (const input of [titleInput, counterpartyInput, notesInput, goalsInput, contradictionsInput]) {
  input.addEventListener("input", () => {
    isBriefDirty = true;
  });
}

if (requireBridge()) bridge.onMeetingCoachSnapshot((snapshot) => applySnapshot(snapshot));
void refresh();
