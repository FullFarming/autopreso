const WEBAPP_ORIGIN = "https://realtime-noel-web.vercel.app";
const form = document.querySelector("#viewer-form");
const displayNameInput = document.querySelector("#display-name");
const codeInput = document.querySelector("#code");
const languageSelect = document.querySelector("#language");
const error = document.querySelector("#form-error");
const viewerShell = document.querySelector("#viewer-shell");
const viewerFrame = document.querySelector("#viewer-frame");
const changeButton = document.querySelector("#change-session");
const outputState = document.querySelector("#viewer-output-state");
let pendingReadyHandler = null;

window.addEventListener("message", (event) => {
  if (event.source !== viewerFrame.contentWindow || event.origin !== WEBAPP_ORIGIN) return;
  if (event.data?.type !== "realtime-noel-viewer-state") return;
  const outputMode = event.data.outputMode;
  const isMeeting = event.data.sessionType === "meeting";
  const deliveryMethod = isMeeting
    ? outputMode === "captions" ? "화자 구분 자막 · 발화 종료 후 표시" : "화자 구분 · 발화 종료 후 출력"
    : outputMode === "captions" ? "빠른 실시간 자막" : "안정적인 AI 음성 · 단일 발표자 최적화";
  outputState.textContent = outputMode === "audio"
    ? `${deliveryMethod} · 재생 필요`
    : outputMode === "captions_audio" ? `자막 + ${deliveryMethod} · 재생 필요` : deliveryMethod;
});

const saved = await chrome.storage.local.get(["viewerLanguage", "viewerDisplayName"]);
if (typeof saved.viewerLanguage === "string") languageSelect.value = saved.viewerLanguage;
if (typeof saved.viewerDisplayName === "string") displayNameInput.value = saved.viewerDisplayName;

displayNameInput.addEventListener("input", () => {
  error.textContent = "";
});

codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
  error.textContent = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const displayName = displayNameInput.value.normalize("NFC").trim();
  if (displayName.length < 1 || displayName.length > 40) {
    error.textContent = "표시할 이름을 1자 이상 40자 이하로 입력하세요.";
    displayNameInput.focus();
    return;
  }
  if (codeInput.value.length !== 6) {
    error.textContent = "6자리 인증번호를 입력하세요.";
    return;
  }
  const language = languageSelect.value;
  await chrome.storage.local.set({ viewerLanguage: language, viewerDisplayName: displayName });
  const target = new URL("/watch", WEBAPP_ORIGIN);
  target.searchParams.set("surface", "chrome-side-panel");
  const admissionCode = codeInput.value;
  if (pendingReadyHandler) window.removeEventListener("message", pendingReadyHandler);
  const sendJoin = (messageEvent) => {
    if (messageEvent.source !== viewerFrame.contentWindow || messageEvent.origin !== WEBAPP_ORIGIN) return;
    if (messageEvent.data?.type !== "realtime-noel-viewer-ready") return;
    viewerFrame.contentWindow?.postMessage({
      type: "realtime-noel-viewer-join",
      code: admissionCode,
      language,
      displayName,
    }, WEBAPP_ORIGIN);
    window.removeEventListener("message", sendJoin);
    pendingReadyHandler = null;
  };
  pendingReadyHandler = sendJoin;
  window.addEventListener("message", sendJoin);
  viewerFrame.src = target.toString();
  form.hidden = true;
  viewerShell.hidden = false;
  codeInput.value = "";
});

changeButton.addEventListener("click", () => {
  if (pendingReadyHandler) window.removeEventListener("message", pendingReadyHandler);
  pendingReadyHandler = null;
  viewerFrame.src = "about:blank";
  outputState.textContent = "연결 상태 확인 중";
  viewerShell.hidden = true;
  form.hidden = false;
  codeInput.focus();
});
