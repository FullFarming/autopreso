import { getLanguage, subscribe } from "./subtitle-i18n.js";

const HELP = {
  "caption-details": ["위치, 글자 크기, 배경 투명도와 용어집을 조절합니다. 세션을 다시 시작하지 않습니다.", "Adjust position, text size, opacity and glossary without restarting.", "位置、文字サイズ、透明度、用語集を調整します。セッションは再起動しません。"],
  "caption-display-trigger": ["자막을 표시할 화면을 선택합니다. 실행 중에도 컨트롤러에서 변경할 수 있습니다.", "Choose caption displays. You can also change them from the running controller.", "字幕を表示する画面を選びます。実行中もコントローラーで変更できます。"],
  "schedule-live-call": ["세션을 만들고 초대 화면을 엽니다. 컨트롤러에서 라이브를 시작합니다.", "Create the session and open invitations, then go live from the controller.", "セッションと招待画面を作成します。コントローラーから配信を開始します。"],
  "register-live-call": ["나중에 시작할 세션을 등록합니다. 등록된 세션에서 불러와 시작할 수 있습니다.", "Save a session for later. Load it from registered sessions when ready.", "後で開始するセッションを保存します。登録済みセッションから開始できます。"],
  "refresh-registered-sessions": ["서버에 등록된 세션 목록을 다시 불러옵니다.", "Reload registered sessions from the server.", "登録済みセッションを再読み込みします。"],
  "speaker-save": ["현재 세션에 발언자 명단과 프로필을 저장합니다. 실시간 적용 상태는 아래에 표시됩니다.", "Save this session's speaker roster. Application status appears below.", "発言者一覧を保存します。反映状態は下に表示されます。"],
  "speaker-reload": ["서버 명단을 다시 불러옵니다. 저장하지 않은 수정은 취소됩니다.", "Reload the server roster and discard unsaved changes.", "サーバーの一覧を再読み込みします。未保存の変更は破棄されます。"],
  "speaker-current": ["준비 또는 진행 중인 세션의 발언자 명단을 엽니다.", "Open the speaker roster for the prepared or active session.", "準備中または実行中の発言者一覧を開きます。"],
  "speaker-reset": ["작성 중인 명단을 지우고 새 세션 명단을 시작합니다. 저장된 서버 명단과 이전 자막 기록은 유지됩니다.", "Start a new draft. Saved rosters and past caption records stay unchanged.", "新しい一覧を作成します。保存済みの一覧と過去の字幕記録は維持されます。"],
  "speaker-select": ["현장 발언자를 지정합니다. 온라인 참여자가 발언 중이면 온라인 발언 종료 후 적용됩니다.", "Choose the onsite speaker. If an online participant is speaking, this applies afterward.", "会場の発言者を選びます。オンライン発言中の場合は終了後に反映されます。"],
  "controller-restart": ["자막 연결을 복구합니다. 표시 설정을 바꾸려면 자막 메뉴를 사용하세요.", "Recover the caption connection. Use Captions for appearance changes.", "字幕接続を復旧します。表示の変更は字幕メニューを使用してください。"],
  "controller-main-window": ["진행 중인 세션을 유지하면서 메인 화면을 엽니다.", "Show the main window without ending the current session.", "実行中のセッションを維持してメイン画面を開きます。"],
};
const copy = (values) => values[getLanguage() === "en" ? 1 : getLanguage() === "ja" ? 2 : 0];

export function calculateHelpPosition(anchor, panel, viewport) {
  return {
    left: Math.max(16, Math.min(anchor.left, viewport.width - panel.width - 16)),
    top: Math.max(16, anchor.bottom + panel.height + 8 <= viewport.height - 16 ? anchor.bottom + 8 : anchor.top - panel.height - 8),
  };
}

export function createCaptionDisplaySelection(bridge, onChange = (_state) => {}) {
  let revision = 0;
  let state = { displays: [], busy: false, error: "" };
  function getState() { return { ...state, displays: state.displays.map(display => ({ ...display })) }; }
  function update(patch) { state = { ...state, ...patch }; onChange(getState()); }
  function accept(value) {
    revision++;
    const displays = (Array.isArray(value?.displays) ? value.displays : [])
      .filter(display => display && ["string", "number"].includes(typeof display.id) && typeof display.label === "string" && display.isConnected !== false)
      .map(display => ({ ...display, id: String(display.id), isSelected: display.isSelected === true || (display.isSelected === undefined && (value.allDisplays === true || String(value.selectedDisplayId) === String(display.id))) }));
    update({ displays, error: "" });
  }
  async function refresh() {
    if (state.busy) return;
    const requestedRevision = ++revision;
    const value = await bridge.listOverlayDisplays();
    if (requestedRevision === revision) accept(value);
  }
  async function select(id, selected) {
    if (state.busy) throw new Error("화면 선택을 저장 중입니다.");
    if (!state.displays.some(display => display.id === id)) throw new Error("연결된 화면을 선택해 주세요.");
    const ids = state.displays.filter(display => display.id === id ? selected : display.isSelected).map(display => display.id);
    revision++;
    update({ busy: true });
    try { accept(await bridge.selectOverlayDisplays(ids)); }
    catch (error) { update({ error: copy(["화면 선택을 저장하지 못했습니다. 다시 선택해 주세요.", "Could not save displays. Please try again.", "画面を保存できませんでした。再度選択してください。"] ) }); throw error; }
    finally { update({ busy: false }); }
  }
  return { getState, refresh, select, accept };
}

function positionPanel(panel, trigger) {
  const position = calculateHelpPosition(trigger.getBoundingClientRect(), panel.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
  panel.style.left = `${position.left}px`; panel.style.top = `${position.top}px`;
}

export function mountCaptionDisplayPicker(bridge) {
  const trigger = document.getElementById("caption-display-trigger");
  const panel = document.getElementById("caption-display-panel");
  const list = document.getElementById("caption-display-options");
  const status = document.getElementById("caption-display-status");
  if (!(trigger instanceof HTMLButtonElement) || !panel || !list || !status) return;
  if (!bridge?.listOverlayDisplays || !bridge?.selectOverlayDisplays) {
    trigger.disabled = true; status.textContent = copy(["데스크톱 앱에서 선택할 수 있습니다.", "Available in the desktop app.", "デスクトップアプリで選択できます。"]); return;
  }
  function render(state) {
    const selected = state.displays.filter(display => display.isSelected);
    trigger.textContent = selected.length ? selected.map(display => display.label).join(" · ") : copy(["표시 안 함", "No display", "表示なし"]);
    trigger.title = trigger.textContent;
    const activeIds = new Set(state.displays.map(display => display.id));
    for (const label of list.querySelectorAll("label")) if (!activeIds.has(label.dataset.displayId)) label.remove();
    for (const display of state.displays) {
      let label = [...list.querySelectorAll("label")].find(item => item.dataset.displayId === display.id);
      if (!label) {
        label = document.createElement("label"); label.dataset.displayId = display.id;
        const input = document.createElement("input"); input.type = "checkbox";
        label.append(input, document.createElement("span"));
        input.addEventListener("click", event => { if (model.getState().busy) event.preventDefault(); });
        input.addEventListener("input", event => event.stopPropagation());
        input.addEventListener("change", event => { event.stopPropagation(); void model.select(display.id, input.checked).catch(() => {}); });
        list.append(label);
      }
      const input = label.querySelector("input");
      input.checked = display.isSelected;
      input.setAttribute("aria-disabled", String(state.busy));
      const caption = label.querySelector("span");
      if (caption.textContent !== display.label) caption.textContent = display.label;
    }
    status.textContent = state.error || (state.busy ? copy(["저장 중", "Saving", "保存中"]) : "");
    if (!state.displays.length) status.textContent = copy(["연결된 화면이 없습니다.", "No connected displays.", "接続された画面がありません。"]);
  }
  const model = createCaptionDisplaySelection(bridge, render);
  trigger.addEventListener("click", () => {
    if (panel.matches(":popover-open")) panel.hidePopover();
    else { panel.showPopover(); positionPanel(panel, trigger); }
  });
  window.addEventListener("resize", () => { if (panel.matches(":popover-open")) positionPanel(panel, trigger); });
  panel.addEventListener("toggle", () => trigger.setAttribute("aria-expanded", String(panel.matches(":popover-open"))));
  const refresh = () => { void model.refresh().catch(() => { status.textContent = copy(["화면을 불러오지 못했습니다.", "Could not load displays.", "画面を読み込めませんでした。"]); }); };
  panel.querySelector("[data-refresh-displays]")?.addEventListener("click", refresh);
  const unsubscribe = bridge.onOverlayDisplaysChanged?.(value => model.accept(value));
  window.addEventListener("pagehide", () => unsubscribe?.(), { once: true });
  subscribe(() => render(model.getState()));
  refresh();
}

export function initSubtitleControls() {
  const helpEntries = [];
  let nextHelpId = 0;
  function addHelp(control, key) {
    if (!HELP[key] || control.dataset.novaHelpReady) return;
    control.dataset.novaHelpReady = "true";
    const pair = document.createElement("span"); pair.className = "nova-action-pair";
    control.before(pair); pair.append(control);
    const help = document.createElement("button"); help.type = "button"; help.textContent = "?"; help.className = "nova-help-button";
    const panel = document.createElement("div"); panel.className = "nova-help-popover"; panel.id = `nova-help-${++nextHelpId}`;
    panel.setAttribute("popover", "auto"); panel.setAttribute("role", "tooltip");
    help.setAttribute("aria-describedby", panel.id); help.setAttribute("aria-controls", panel.id); help.setAttribute("aria-expanded", "false");
    helpEntries.push({ control, help, panel, key }); pair.append(help); document.body.append(panel);
    const show = () => { if (!panel.matches(":popover-open")) panel.showPopover(); positionPanel(panel, help); };
    help.addEventListener("click", () => { if (panel.matches(":popover-open")) panel.hidePopover(); else show(); });
    help.addEventListener("focus", () => { if (help.matches(":focus-visible")) show(); });
    help.addEventListener("keydown", event => { if (event.key === "Escape" && panel.matches(":popover-open")) { event.preventDefault(); event.stopPropagation(); panel.hidePopover(); help.focus(); } });
    panel.addEventListener("toggle", () => help.setAttribute("aria-expanded", String(panel.matches(":popover-open"))));
  }
  function refreshHelpCopy() {
    for (const { control, help, panel, key } of helpEntries) {
      const nextCopy = copy(HELP[key]);
      if (panel.textContent !== nextCopy) panel.textContent = nextCopy;
      help.setAttribute("aria-label", `${control.textContent.trim()} ${copy(["도움말", "help", "ヘルプ"])}`);
    }
  }
  function enhance() {
    for (let index = helpEntries.length - 1; index >= 0; index--) {
      if (!helpEntries[index].control.isConnected) { helpEntries[index].panel.remove(); helpEntries.splice(index, 1); }
    }
    const selectors = [
      ".subtitle-dashboard .cfg-section button", ".subtitle-dashboard .live-handoff button", ".subtitle-dashboard .workspace-footer button",
      ".subtitle-dashboard .records-cal-nav button", ".subtitle-dashboard .records-cal-view button", ".subtitle-dashboard .glossary-management button",
      ".subtitle-dashboard select", '.subtitle-dashboard input:is([type="text"],[type="search"],[type="number"],[type="date"],[type="time"],[type="password"])',
      ".speaker-roster button", ".speaker-editor button", ".speaker-editor input", ".speaker-editor select",
      ".glossary-detail-dialog button", ".glossary-detail-dialog input", ".glossary-detail-dialog select", ".glossary-select-panel button",
      ".refined-controller button:not(.speaker-choice)", ".refined-controller select",
    ];
    for (const control of document.querySelectorAll(selectors.join(","))) {
      if (!control.matches('input[type="checkbox"],input[type="radio"],input[type="range"],[role="switch"],.speaker-choice,.nova-help-button')) control.classList.add("nova-control");
    }
    for (const key of Object.keys(HELP)) {
      const control = document.getElementById(key);
      if (control?.tagName === "BUTTON") addHelp(control, key);
    }
    for (const control of document.querySelectorAll("[data-nova-help]")) addHelp(control, control.getAttribute("data-nova-help"));
    refreshHelpCopy();
  }
  enhance();
  const observer = new MutationObserver(enhance);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", () => {
    for (const { panel, help } of helpEntries) if (panel.matches(":popover-open")) positionPanel(panel, help);
  });
  subscribe(refreshHelpCopy);
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
}
