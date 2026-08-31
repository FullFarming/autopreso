import { createNovaTranscriptRenderer } from "/nova-transcript.js";

const bridge = window.realtimeNoelDesktop;
const feed = document.getElementById("record-feed");
const status = document.getElementById("coach-status");
const recordState = document.getElementById("record-state");
const recordUpdated = document.getElementById("record-updated");
const recordCount = document.getElementById("record-count");
const jumpLatest = document.getElementById("jump-latest");
const stateSurface = document.getElementById("record-state-surface");
const finalAnnouncer = document.getElementById("record-final-announcer");
const arrangeWindowsButton = document.getElementById("arrange-windows");

let latestSeq = -1;
let lastCaptionConnection = null;
let lastFinalTurnCount = null;

const transcriptList = document.createElement("div");
transcriptList.className = "nova-transcript-list record-transcript-list";
feed.replaceChildren(stateSurface, transcriptList);

const transcriptRenderer = createNovaTranscriptRenderer({
  container: transcriptList,
  scrollElement: feed,
  classNames: {
    row: "record-line",
    metadata: "record-meta",
    avatar: "speaker-avatar",
    source: "record-en",
    translation: "record-ko",
  },
  onLatestChange({ hasUnseenLatest }) {
    jumpLatest.hidden = !hasUnseenLatest;
  },
});

function requireBridge() {
  return Boolean(bridge?.meetingCoachGetSnapshot && bridge?.onMeetingCoachSnapshot);
}

function unwrap(result) {
  if (!result) throw new Error("NO_RESPONSE");
  if (result.ok === false) throw new Error(result.code || result.error || "MEETING_COACH_ERROR");
  return result.data;
}

function setStatus(text, tone = "idle") {
  status.textContent = text;
  status.classList.toggle("is-error", tone === "error");
  status.classList.toggle("is-live", tone === "live");
}

function setBridgeError() {
  setStatus("연결 오류", "error");
  renderStateSurface({
    className: "nova-error-action",
    title: "앱 연결 오류",
    message: "회의 기록 창을 다시 불러오세요.",
    actions: [{ label: "다시 불러오기", isPrimary: true, run: () => window.location.reload() }],
  });
  transcriptRenderer.replace([]);
}

function formatTime(value) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
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

function renderStateSurface(state) {
  if (!stateSurface) return;
  if (!state) {
    stateSurface.hidden = true;
    stateSurface.replaceChildren();
    return;
  }
  stateSurface.hidden = false;
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
  stateSurface.replaceChildren(panel);
}

async function openMainSettings() {
  await bridge.showMainWindow();
  setStatus("설정 창 열림");
}

async function openResponseWindow() {
  unwrap(await bridge.meetingCoachOpenResponse());
  setStatus("응답창 열림");
}

function renderRecordState(snapshot, turns) {
  const caption = snapshot.connection?.caption ?? "CONNECTING";
  const provider = snapshot.connection?.provider ?? "IDLE";
  const wasReconnected = lastCaptionConnection !== null
    && lastCaptionConnection !== "CONNECTED"
    && caption === "CONNECTED";
  lastCaptionConnection = caption;

  if (provider === "ERROR") {
    renderStateSurface({
      className: "nova-error-action",
      title: "AI 응답 오류",
      message: "설정을 확인한 뒤 기록 상태를 다시 불러오세요.",
      actions: [
        { label: "다시 불러오기", isPrimary: true, run: () => refresh({ force: true }) },
        { label: "설정 확인", run: openMainSettings },
      ],
    });
    return;
  }
  if (caption === "DISCONNECTED") {
    renderStateSurface({
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
    renderStateSurface({
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
    renderStateSurface({
      className: "nova-success-state",
      title: "자막 연결이 복구되었습니다",
      message: "새 기록을 기다리거나 응답 코치를 여세요.",
      actions: [{ label: "응답창 열기", isPrimary: true, run: openResponseWindow }],
    });
    return;
  }
  if (turns.length === 0) {
    renderStateSurface({
      className: "nova-empty-state",
      title: "아직 기록이 없습니다",
      message: "확정된 발화가 들어오면 영어와 한국어가 함께 표시됩니다.",
      actions: [
        { label: "응답창 열기", isPrimary: true, run: openResponseWindow },
        { label: "설정 확인", run: openMainSettings },
      ],
    });
    return;
  }
  renderStateSurface(null);
}

function adaptMeetingCoachTurn(turn, index) {
  const statusValue = String(turn?.status ?? "FINAL").toUpperCase();
  return {
    id: turn?.id ?? turn?.turnId ?? `coach-turn-${index}`,
    sourceText: turn?.english ?? turn?.sourceText ?? turn?.text ?? "",
    translatedText: turn?.korean ?? turn?.translatedText ?? "",
    speaker: turn?.speaker ?? turn?.speakerName ?? "Speaker",
    time: formatTime(turn?.endedAt ?? turn?.startedAt ?? turn?.createdAt ?? turn?.timestamp),
    type: "live-coach",
    status: statusValue === "PARTIAL" ? "partial" : "final",
  };
}

function render(snapshot) {
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  renderRecordState(snapshot, turns);
  transcriptRenderer.replace(turns.map(adaptMeetingCoachTurn));
  recordCount.textContent = `${turns.length}줄`;
  recordState.textContent = snapshot.state ?? "대기";
  recordUpdated.textContent = `seq ${snapshot.seq}`;
  const caption = snapshot.connection?.caption;
  setStatus(
    caption === "CONNECTED" ? "기록 중" : (caption === "DISCONNECTED" ? "연결 끊김" : "연결 중"),
    caption === "CONNECTED" ? "live" : (caption === "DISCONNECTED" ? "error" : "idle"),
  );
  const finalTurnCount = turns.filter((turn) => String(turn?.status ?? "FINAL").toUpperCase() !== "PARTIAL").length;
  if (lastFinalTurnCount !== null && finalTurnCount > lastFinalTurnCount && finalAnnouncer) {
    finalAnnouncer.textContent = `새 확정 기록 ${finalTurnCount - lastFinalTurnCount}개`;
  }
  lastFinalTurnCount = finalTurnCount;
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot.seq !== "number" || snapshot.seq <= latestSeq) return;
  latestSeq = snapshot.seq;
  render(snapshot);
}

async function refresh(options = {}) {
  if (!requireBridge()) {
    setBridgeError();
    return;
  }
  try {
    const snapshot = unwrap(await bridge.meetingCoachGetSnapshot());
    if (options.force && snapshot?.seq === latestSeq) render(snapshot);
    else applySnapshot(snapshot);
  } catch {
    setStatus("불러오기 실패", "error");
    renderStateSurface({
      className: "nova-error-action",
      title: "기록을 불러오지 못했습니다",
      message: "연결과 설정을 확인한 뒤 다시 시도하세요.",
      actions: [
        { label: "다시 불러오기", isPrimary: true, run: () => refresh({ force: true }) },
        { label: "설정 확인", run: openMainSettings },
      ],
    });
    transcriptRenderer.replace([]);
  }
}

jumpLatest.addEventListener("click", () => {
  transcriptRenderer.moveToLatest();
});

arrangeWindowsButton.addEventListener("click", async () => {
  if (!bridge?.meetingCoachArrangeWindows) {
    setStatus("창 정렬 불가", "error");
    return;
  }
  try {
    unwrap(await bridge.meetingCoachArrangeWindows());
    setStatus("창 정렬됨");
  } catch {
    setStatus("창 정렬 실패", "error");
  }
});

if (requireBridge()) bridge.onMeetingCoachSnapshot((snapshot) => applySnapshot(snapshot));
void refresh();
