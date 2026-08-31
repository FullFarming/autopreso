import { SYSTEM_LANGUAGES, SYSTEM_LANGUAGE_LABELS, SYSTEM_LANGUAGE_STORAGE_KEY, normalizeSystemLanguage } from "./system-language.js";
import { changeLanguage, getLanguage, readStoredLanguage, setLanguage, subscribe, t } from "./subtitle-i18n.js";

function readLocalLanguageSnapshot() {
  try { return globalThis.localStorage?.getItem(SYSTEM_LANGUAGE_STORAGE_KEY) ?? null; }
  catch { return undefined; }
}

export function mountSystemLanguageButton(container, { onOpenChange = (isOpen = false) => {} } = {}) {
  const document = container.ownerDocument;
  const window = document.defaultView;
  let isLanguageReady = false;
  let hasUserSelection = false;
  let isDestroyed = false;
  let lastLocalLanguageSnapshot = readLocalLanguageSnapshot();
  let isSaveFailed = false;
  let saveRevision = 0;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "system-language-trigger";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", `${container.id}-menu`);

  function icon(name) {
    const element = document.createElement("span");
    element.className = `system-language-icon system-language-icon-${name}`;
    element.setAttribute("aria-hidden", "true");
    return element;
  }

  const currentLabel = document.createElement("span");
  trigger.append(icon("globe"), currentLabel, icon("chevron"));
  const menu = document.createElement("div");
  menu.id = `${container.id}-menu`;
  menu.className = "system-language-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const status = document.createElement("p");
  status.id = `${container.id}-status`;
  status.className = "system-language-status";
  status.setAttribute("role", "status");
  status.hidden = true;

  function renderStatus() {
    status.textContent = isSaveFailed ? t("lang.saveFailed") : "";
    status.hidden = !isSaveFailed || !menu.hidden;
    if (status.hidden) trigger.removeAttribute("aria-describedby");
    else trigger.setAttribute("aria-describedby", status.id);
  }

  function publishLanguageToMainProcess() {
    if (!isLanguageReady || isDestroyed) return;
    const setter = window?.realtimeNoelDesktop?.setUiLanguage;
    if (typeof setter !== "function") return;
    const language = getLanguage();
    const revision = ++saveRevision;
    isSaveFailed = false;
    renderStatus();
    function finishSave(result) {
      if (isDestroyed || revision !== saveRevision) return;
      isSaveFailed = normalizeSystemLanguage(result) !== language;
      renderStatus();
      if (isSaveFailed) console.warn("SYSTEM_LANGUAGE_MENU_SYNC_FAILED");
    }
    try {
      void Promise.resolve(setter(language)).then(finishSave, () => finishSave(null));
    } catch {
      finishSave(null);
    }
  }

  const choices = SYSTEM_LANGUAGES.map((language) => {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "system-language-choice";
    choice.tabIndex = -1;
    choice.setAttribute("role", "menuitemradio");
    choice.setAttribute("lang", language);
    const label = document.createElement("span");
    label.textContent = SYSTEM_LANGUAGE_LABELS[language];
    choice.append(label, icon("check"));
    choice.addEventListener("click", () => {
      if (isDestroyed) return;
      hasUserSelection = true;
      changeLanguage(language);
      lastLocalLanguageSnapshot = readLocalLanguageSnapshot();
      publishLanguageToMainProcess();
      close(true);
    });
    return choice;
  });
  menu.append(...choices);
  container.replaceChildren(trigger, menu, status);

  function render() {
    const language = getLanguage();
    currentLabel.textContent = SYSTEM_LANGUAGE_LABELS[language];
    currentLabel.setAttribute("lang", language);
    trigger.setAttribute("aria-label", `${t("lang.group")}: ${SYSTEM_LANGUAGE_LABELS[language]}`);
    menu.setAttribute("aria-label", t("lang.group"));
    choices.forEach((choice, index) => choice.setAttribute("aria-checked", String(SYSTEM_LANGUAGES[index] === language)));
    renderStatus();
  }

  function open() {
    if (!menu.hidden) return;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    renderStatus();
    onOpenChange(true);
    choices[SYSTEM_LANGUAGES.indexOf(getLanguage())]?.focus();
  }

  function close(restoreFocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    renderStatus();
    onOpenChange(false);
    if (restoreFocus) trigger.focus();
  }

  function onTriggerClick() { if (menu.hidden) open(); else close(true); }
  function onTriggerKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    }
  }
  function onMenuKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    const index = choices.indexOf(document.activeElement);
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % choices.length;
    if (event.key === "ArrowUp") next = (index + choices.length - 1) % choices.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = choices.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    choices[next].focus();
  }
  function onOutsidePointer(event) { if (!container.contains(event.target)) close(); }
  function onFocusOut(event) { if (!container.contains(event.relatedTarget)) close(); }
  function onWindowBlur() { close(); }

  trigger.addEventListener("click", onTriggerClick);
  trigger.addEventListener("keydown", onTriggerKeyDown);
  menu.addEventListener("keydown", onMenuKeyDown);
  container.addEventListener("focusout", onFocusOut);
  document.addEventListener("pointerdown", onOutsidePointer);
  window?.addEventListener("blur", onWindowBlur);
  const unsubscribe = subscribe(() => {
    if (!isLanguageReady) hasUserSelection = true;
    render();
  });
  render();

  function adoptUnobservedStorageChange() {
    const latestSnapshot = readLocalLanguageSnapshot();
    if (latestSnapshot === undefined || latestSnapshot === lastLocalLanguageSnapshot) return;
    // 2026-08-31 fix: Storage writes are visible before their queued events.
    // A stale desktop read must not replace a newer choice from another window.
    lastLocalLanguageSnapshot = latestSnapshot;
    hasUserSelection = true;
    setLanguage(readStoredLanguage());
  }

  async function restoreDesktopLanguage() {
    const getter = window?.realtimeNoelDesktop?.getUiLanguage;
    if (typeof getter === "function") {
      try {
        const stored = normalizeSystemLanguage(await getter());
        if (isDestroyed) return;
        adoptUnobservedStorageChange();
        if (stored && !hasUserSelection) changeLanguage(stored);
      } catch {
        // 2026-08-31 fix: A failed read must not replace a durable preference
        // with this window's default. Explicit later choices can still save.
        if (isDestroyed) return;
        adoptUnobservedStorageChange();
        isLanguageReady = true;
        console.warn("SYSTEM_LANGUAGE_RESTORE_FAILED");
        if (hasUserSelection) publishLanguageToMainProcess();
        return;
      }
    }
    isLanguageReady = true;
    publishLanguageToMainProcess();
  }
  const ready = restoreDesktopLanguage();

  return {
    ready,
    destroy() {
      isDestroyed = true;
      close();
      unsubscribe();
      trigger.removeEventListener("click", onTriggerClick);
      trigger.removeEventListener("keydown", onTriggerKeyDown);
      menu.removeEventListener("keydown", onMenuKeyDown);
      container.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onOutsidePointer);
      window?.removeEventListener("blur", onWindowBlur);
      container.replaceChildren();
    },
  };
}
