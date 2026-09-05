const bridge = window.realtimeNoelDesktop;
const status = document.getElementById("coach-status");
const readyState = document.getElementById("ready-state");
const latestQuestion = document.getElementById("latest-question");
const latestQuestionKo = document.getElementById("latest-question-ko");
const evidenceSummary = document.getElementById("evidence-summary");
const sourceList = document.getElementById("source-list");
const automaticState = document.getElementById("automatic-state");
const manualState = document.getElementById("manual-state");
const automaticList = document.getElementById("automatic-list");
const manualList = document.getElementById("manual-list");
const arrangeWindowsButton = document.getElementById("arrange-windows");
const suggestionActions = document.getElementById("suggestion-actions");
const useSuggestionButton = document.getElementById("use-suggestion");
const copySuggestionButton = document.getElementById("copy-suggestion");
const composer = document.getElementById("coach-composer");
const form = document.getElementById("composer-form");
const chips = [...document.querySelectorAll(".coach-chip")];

let latestSeq = -1;
let lastReadyManual = null;
let latestBrief = null;
let activeCoachSessionId = null;
let activeSuggestion = null;
let usedSuggestionKey = null;
let usedSourceTurnIds = new Set();

function requireBridge() {
  return Boolean(
    bridge?.meetingCoachGetSnapshot
      && bridge?.meetingCoachAnswerTurn
      && bridge?.meetingCoachManualAction
      && bridge?.meetingCoachUseRecommendation
      && bridge?.onMeetingCoachSnapshot,
  );
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

function setBadge(element, text, tone = "idle") {
  element.textContent = text;
  element.classList.toggle("is-error", tone === "error");
  element.classList.toggle("is-warn", tone === "warn");
  element.classList.toggle("is-stale", tone === "stale");
}

function setBridgeError() {
  setStatus("연결 오류", "error");
  setBadge(automaticState, "연결 오류", "error");
  setBadge(manualState, "연결 오류", "error");
  automaticList.replaceChildren(renderAnswerCard({ text: "Electron bridge 연결 오류" }));
  manualList.replaceChildren(renderAnswerCard({ text: "Electron bridge 연결 오류" }));
  suggestionActions.hidden = true;
}

function normalizeText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  return result.text ?? result.answer ?? result.english ?? result.translation ?? "";
}

function normalizeKorean(result) {
  if (!result || typeof result === "string") return "";
  return result.korean ?? result.textKo ?? result.translationKo ?? "";
}

function renderSources(sources, brief) {
  sourceList.replaceChildren();
  const factLabels = new Map((brief?.verifiedFacts ?? []).map((fact) => [fact.id, `${fact.label}: ${fact.value}`]));
  for (const source of Array.isArray(sources) ? sources : []) {
    const item = document.createElement("li");
    item.textContent = typeof source === "string"
      ? (factLabels.get(source) ?? source)
      : source.label ?? source.title ?? factLabels.get(source.id) ?? source.id ?? "source";
    sourceList.append(item);
  }
}

function renderAnswerCard(result, options = {}) {
  const card = document.createElement("article");
  card.className = "answer-card";
  const label = document.createElement("strong");
  label.textContent = options.label ?? "답변";
  const answer = document.createElement("p");
  answer.className = "answer-text";
  answer.textContent = normalizeText(result) || options.emptyText || "대기 중";
  const korean = document.createElement("p");
  korean.textContent = normalizeKorean(result);
  const meta = document.createElement("p");
  meta.className = options.stale ? "empty-state" : "";
  meta.textContent = options.stale ? "stale" : options.meta ?? "";
  card.append(label, answer, korean, meta);
  return card;
}

function renderEmptyState(text) {
  const empty = document.createElement("p");
  empty.className = "coach-empty-state";
  empty.textContent = text;
  return empty;
}

function renderLoadingCard() {
  const card = document.createElement("article");
  card.className = "answer-card answer-loading";
  card.setAttribute("aria-label", "답변 생성 중");
  const label = document.createElement("strong");
  label.textContent = "답변 생성 중";
  const dots = document.createElement("span");
  dots.className = "loading-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement("span");
    dot.className = "loading-dot";
    dots.append(dot);
  }
  card.append(label, dots);
  return card;
}

function laneTone(statusValue) {
  if (statusValue === "ERROR") return "error";
  if (statusValue === "STALE") return "stale";
  if (statusValue === "READY_VERIFY" || statusValue === "GENERATING") return "warn";
  return "idle";
}

function renderAutomaticLane(lane) {
  const statusValue = lane?.status ?? "IDLE";
  const isStale = lane?.sourceTurnId && currentQuestionId() && lane.sourceTurnId !== currentQuestionId();
  if (statusValue === "IDLE" || statusValue === "STALE" || isStale) {
    activeSuggestion = null;
    suggestionActions.hidden = true;
    automaticList.classList.remove?.("is-used");
    setBadge(automaticState, "대기");
    automaticList.replaceChildren(renderEmptyState("다음 질문 대기"));
    return;
  }
  if (statusValue === "GENERATING") {
    activeSuggestion = null;
    suggestionActions.hidden = true;
    automaticList.classList.remove?.("is-used");
    setBadge(automaticState, "생성 중", "warn");
    automaticList.replaceChildren(lane.partialText
      ? renderAnswerCard({ text: lane.partialText }, { label: "추천 답변" })
      : renderLoadingCard());
    return;
  }
  if (statusValue === "ERROR") {
    activeSuggestion = null;
    suggestionActions.hidden = true;
    automaticList.classList.remove?.("is-used");
    setBadge(automaticState, "다시 시도", "error");
    automaticList.replaceChildren(renderAnswerCard(
      { text: lane.error || "답변을 다시 생성해 주세요" },
      { label: "상태" },
    ));
    return;
  }
  const suggestionKey = lane.sourceTurnId ?? lane.requestId ?? currentQuestionId();
  activeSuggestion = { key: suggestionKey, sourceTurnId: lane.sourceTurnId ?? currentQuestionId(), text: normalizeText(lane.result) };
  suggestionActions.hidden = false;
  const isUsed = Boolean((usedSuggestionKey && usedSuggestionKey === suggestionKey) || usedSourceTurnIds.has(activeSuggestion.sourceTurnId));
  automaticList.classList.toggle("is-used", isUsed);
  useSuggestionButton.disabled = isUsed;
  useSuggestionButton.textContent = isUsed ? "사용 중" : "이 답변 사용";
  setBadge(automaticState, statusValue === "READY_VERIFY" ? "확인 필요" : "준비됨", laneTone(statusValue));
  automaticList.replaceChildren(renderAnswerCard(lane.result, {
    label: "추천 답변",
    meta: lane?.error ?? "",
  }));
}

function renderManualLane(lane) {
  const statusValue = lane?.status ?? "IDLE";
  if (statusValue === "GENERATING") {
    setBadge(manualState, "생성 중", "warn");
    manualList.replaceChildren(lane.partialText
      ? renderAnswerCard({ text: lane.partialText }, { label: "직접 요청" })
      : renderLoadingCard());
    return;
  }
  if (statusValue === "ERROR") {
    setBadge(manualState, "다시 시도", "error");
    manualList.replaceChildren(renderAnswerCard(
      { text: lane.error || "요청을 다시 보내 주세요" },
      { label: "상태" },
    ));
    return;
  }
  const isReady = statusValue === "READY_GROUNDED" || statusValue === "READY_VERIFY";
  const result = isReady ? lane.result : lastReadyManual;
  setBadge(manualState, result ? "준비됨" : "대기", laneTone(statusValue));
  manualList.replaceChildren(result
    ? renderAnswerCard(result, { label: "직접 요청" })
    : renderEmptyState("요청 대기"));
}

function currentQuestionId() {
  return latestQuestion.dataset.turnId || "";
}

function renderQuestion(question) {
  latestQuestion.dataset.turnId = question?.turnId ?? question?.id ?? "";
  latestQuestion.textContent = question?.english ?? question?.sourceText ?? question?.text ?? "질문 대기 중";
  latestQuestionKo.textContent = question?.korean ?? question?.translatedText ?? "한국어 대기 중";
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot.seq !== "number" || snapshot.seq <= latestSeq) return;
  latestSeq = snapshot.seq;
  latestBrief = snapshot.brief ?? latestBrief;
  usedSourceTurnIds = new Set((snapshot.usedRecommendations ?? []).map((recommendation) => recommendation.sourceTurnId).filter(Boolean));
  const question = snapshot.currentQuestion;
  const previousQuestionId = currentQuestionId();
  const nextQuestionId = question?.turnId ?? question?.id ?? "";
  const isSuggestionReplaced = Boolean(usedSuggestionKey)
    && (snapshot.autoLane?.status === "IDLE" || nextQuestionId !== previousQuestionId);
  automaticList.classList.toggle("is-replacing", isSuggestionReplaced);
  if (isSuggestionReplaced) usedSuggestionKey = null;
  renderQuestion(question);

  const nextCoachSessionId = snapshot.coachSessionId ?? null;
  const hasCoachSessionChanged = activeCoachSessionId !== null
    && nextCoachSessionId !== null
    && activeCoachSessionId !== nextCoachSessionId;
  if (nextCoachSessionId !== null) activeCoachSessionId = nextCoachSessionId;
  const isCoachEnded = snapshot.state === "ENDED";
  const isManualLaneClean = snapshot.manualLane?.status === "IDLE" && !snapshot.manualLane?.result;
  if (hasCoachSessionChanged || isCoachEnded || isManualLaneClean) {
    lastReadyManual = null;
  }

  const manualLane = isCoachEnded ? { status: "IDLE" } : snapshot.manualLane;
  if (manualLane?.status === "READY_GROUNDED" || manualLane?.status === "READY_VERIFY") {
    lastReadyManual = manualLane.result;
  }

  renderAutomaticLane(snapshot.autoLane);
  renderManualLane(manualLane);

  const isAutoReady = snapshot.autoLane?.status === "READY_GROUNDED" || snapshot.autoLane?.status === "READY_VERIFY";
  const activeResult = isAutoReady ? snapshot.autoLane.result : (manualLane?.result ?? lastReadyManual);
  evidenceSummary.textContent = snapshot.autoLane?.status === "READY_VERIFY"
    ? "확인 필요"
    : (snapshot.autoLane?.status === "READY_GROUNDED" ? "브리프 근거 확인" : "확인 대기");
  renderSources(activeResult?.evidenceRefs ?? activeResult?.sources ?? activeResult?.citations, latestBrief);
  if (snapshot.autoLane?.status === "GENERATING") {
    setBadge(readyState, "답변 생성 중", "warn");
  } else if (isAutoReady) {
    setBadge(readyState, "추천 준비", snapshot.autoLane.status === "READY_VERIFY" ? "warn" : "idle");
  } else {
    setBadge(readyState, "다음 질문 대기");
  }
  setStatus(snapshot.state ?? "대기", snapshot.connection?.caption === "CONNECTED" ? "live" : "idle");
}

async function refresh() {
  if (!requireBridge()) {
    setBridgeError();
    return;
  }
  try {
    applySnapshot(unwrap(await bridge.meetingCoachGetSnapshot()));
  } catch {
    setStatus("불러오기 실패", "error");
  }
}

function selectedAction() {
  const selected = chips.find((chip) => chip.getAttribute("aria-pressed") === "true");
  return selected?.dataset.action ?? "DRAFT";
}

function normalizeAction(action) {
  if (action === "translate") return "TRANSLATE";
  if (action === "shorter") return "SHORTEN";
  if (action === "polite") return "POLITE";
  return "DRAFT";
}

async function submitManual(event) {
  event.preventDefault();
  if (!requireBridge()) return setBridgeError();
  const text = composer.value.trim();
  const action = normalizeAction(selectedAction());
  if (!text && !lastReadyManual) return;
  try {
    setStatus("생성 중", "live");
    unwrap(await bridge.meetingCoachManualAction({ action, text }));
    composer.value = "";
  } catch {
    setStatus("요청 실패", "error");
  }
}

chips.forEach((chip) => {
  chip.addEventListener("click", () => {
    const next = chip.getAttribute("aria-pressed") !== "true";
    chips.forEach((item) => item.setAttribute("aria-pressed", "false"));
    chip.setAttribute("aria-pressed", String(next));
  });
});

arrangeWindowsButton?.addEventListener("click", async () => {
  if (!bridge?.meetingCoachArrangeWindows) {
    setStatus("창 정렬을 사용할 수 없습니다", "error");
    return;
  }
  try {
    unwrap(await bridge.meetingCoachArrangeWindows());
    setStatus("창을 정렬했습니다");
  } catch {
    setStatus("창 정렬 실패", "error");
  }
});

document.getElementById("regenerate-answer").addEventListener("click", async () => {
  if (!requireBridge()) return setBridgeError();
  const turnId = currentQuestionId();
  if (!turnId) return;
  try {
    unwrap(await bridge.meetingCoachAnswerTurn({ turnId }));
    setStatus("요청됨", "live");
  } catch {
    setStatus("요청 실패", "error");
  }
});

useSuggestionButton.addEventListener("click", async () => {
  if (!activeSuggestion?.text || !activeSuggestion.sourceTurnId || useSuggestionButton.disabled) return;
  useSuggestionButton.disabled = true;
  try {
    const used = unwrap(await bridge.meetingCoachUseRecommendation({ sourceTurnId: activeSuggestion.sourceTurnId }));
    usedSuggestionKey = used?.sourceTurnId ?? activeSuggestion.sourceTurnId;
    usedSourceTurnIds = new Set([...usedSourceTurnIds, usedSuggestionKey]);
    automaticList.classList.add?.("is-used");
    useSuggestionButton.textContent = "사용 중";
    setBadge(automaticState, "사용 중");
  } catch {
    useSuggestionButton.disabled = false;
    useSuggestionButton.textContent = "이 답변 사용";
    automaticList.classList.remove?.("is-used");
    setBadge(automaticState, "사용 실패", "error");
  }
});

copySuggestionButton.addEventListener("click", async () => {
  if (!activeSuggestion?.text) return;
  try {
    await navigator.clipboard.writeText(activeSuggestion.text);
    setStatus("복사됨");
  } catch {
    setStatus("복사 실패", "error");
  }
});

form.addEventListener("submit", (event) => void submitManual(event));
composer.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  form.requestSubmit();
});

if (requireBridge()) bridge.onMeetingCoachSnapshot((snapshot) => applySnapshot(snapshot));
void refresh();
