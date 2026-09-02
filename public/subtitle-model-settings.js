// Engine IDs come from the server's shared catalog; opening this UI makes no
// provider calls. Every selection is written through PUT /api/settings, which
// re-validates it against the same catalog — this module is convenience, never
// the authority.
import { t } from "./subtitle-i18n.js";

const ROLE_FIELDS = { stt: "engineStt", translation: "engineTranslation", summary: "engineSummary" };
const LANGUAGE_MODE_FIELD = "engineLanguageMode";
const ALL_FIELDS = [...Object.values(ROLE_FIELDS), LANGUAGE_MODE_FIELD];
const LANGUAGE_MODES = ["auto", "ko", "en"];
const ID_PATTERN = /^[a-z0-9.-]{1,80}$/u;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const optionValue = (entry) => `${entry.provider}:${entry.model}`;
const roleKey = (selection) => `${selection?.provider}:${selection?.model}`;

/**
 * Fails closed: one malformed entry rejects the whole payload rather than
 * rendering a partial picker whose options do not match what the server
 * accepts. Labels are rendered as text, but `<` and control characters are
 * still refused so a compromised catalog cannot smuggle markup into the UI.
 */
export function normalizeCaptionEngineCatalog(value) {
  if (!isRecord(value) || !isRecord(value.defaults)) return null;
  const result = {};
  for (const role of Object.keys(ROLE_FIELDS)) {
    const entries = value[role];
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 16) return null;
    const seen = new Set();
    result[role] = [];
    for (const entry of entries) {
      if (!isRecord(entry) || !ID_PATTERN.test(entry.provider ?? "") || !ID_PATTERN.test(entry.model ?? "")
        || typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > 120
        || /[<>\p{Cc}\p{Cf}]/u.test(entry.label) || typeof entry.available !== "boolean"
        || !Array.isArray(entry.languageModes) || seen.has(optionValue(entry))) return null;
      seen.add(optionValue(entry));
      result[role].push({
        provider: entry.provider,
        model: entry.model,
        label: entry.label,
        available: entry.available,
        languageModes: entry.languageModes.filter((mode) => LANGUAGE_MODES.includes(mode)),
        requiresSttProvider: typeof entry.requiresSttProvider === "string" ? entry.requiresSttProvider : null,
        // Some engines only work at one caption-language count (Soniox's
        // two-way translation needs exactly a pair). The number comes from the
        // catalog so this module never hard-codes a provider name.
        requiredLanguageCount: Number.isInteger(entry.requiredLanguageCount) && entry.requiredLanguageCount > 0
          ? entry.requiredLanguageCount
          : null,
      });
    }
  }
  const defaults = {};
  for (const role of Object.keys(ROLE_FIELDS)) {
    const fallback = value.defaults[role];
    const entry = isRecord(fallback) ? result[role].find((option) => optionValue(option) === roleKey(fallback)) : null;
    if (!entry) return null;
    defaults[role] = role === "stt"
      ? { provider: entry.provider, model: entry.model, languageMode: entry.languageModes.includes(fallback.languageMode) ? fallback.languageMode : "auto" }
      : { provider: entry.provider, model: entry.model };
  }
  result.defaults = defaults;
  return result;
}

export function mountCaptionEngineSettings({ form, getSettings, save, onSaved, onError, translate = t }) {
  let catalog = null;
  let isPending = false;
  let hasSaveError = false;
  const status = form.querySelector("[data-caption-engine-status]");
  const field = (name) => form.elements[name];

  function currentEngine() {
    const engine = getSettings()?.engine;
    const candidate = isRecord(engine) && isRecord(engine.stt) && isRecord(engine.translation) && isRecord(engine.summary)
      ? engine : catalog?.defaults;
    return candidate ?? null;
  }
  // null when no caption languages are known: an engine that demands an exact
  // count is then unavailable rather than optimistically offered.
  function translationLanguageCount() {
    const languages = getSettings()?.translationLanguages;
    return Array.isArray(languages) ? languages.length : null;
  }
  function selectedEntry(role) {
    const value = field(ROLE_FIELDS[role])?.value ?? "";
    return catalog?.[role].find((entry) => optionValue(entry) === value) ?? null;
  }
  function entryFor(role, selection) {
    return catalog?.[role].find((entry) => optionValue(entry) === roleKey(selection)) ?? null;
  }
  function fillOptions(select, entries, isBlocked) {
    if (!select) return;
    select.replaceChildren(...entries.map((entry) => {
      const option = select.ownerDocument.createElement("option");
      option.value = optionValue(entry);
      option.textContent = entry.label;
      option.disabled = !entry.available || (isBlocked?.(entry) ?? false);
      return option;
    }));
  }
  function refresh() {
    const engine = catalog ? currentEngine() : null;
    if (!catalog || !engine) {
      for (const name of ALL_FIELDS) {
        const select = field(name);
        if (!select) continue;
        select.replaceChildren();
        select.disabled = true;
      }
      if (status) status.textContent = translate("engine.unavailable");
      return;
    }
    // While a save is in flight the form is frozen exactly as the user left it:
    // repainting it from the not-yet-saved engine would both flicker the pick
    // back and leave the option lists describing the previous selection.
    if (isPending) {
      for (const name of ALL_FIELDS) {
        const select = field(name);
        if (select) select.disabled = true;
      }
      if (status) status.textContent = translate("engine.saving");
      return;
    }
    // A saved engine can name an entry this catalog no longer offers (a
    // retired model, a build with a different catalog). Painting it anyway
    // leaves a real <select> at value "" — every later change then compares
    // equal to nothing and silently saves nothing — so fall back to the
    // catalog default for that role. Nothing is written until the user picks.
    const resolved = {};
    for (const role of ["stt", "summary"]) {
      resolved[role] = entryFor(role, engine[role]) ?? entryFor(role, catalog.defaults[role]) ?? catalog[role][0];
    }
    // The STT choice decides which input-language modes exist and whether a
    // combined STT+translation engine may be offered at all; the caption
    // languages decide it too, for an engine that requires an exact count.
    const sttEntry = resolved.stt;
    const isTranslationBlocked = (entry) =>
      (Boolean(entry.requiresSttProvider) && entry.requiresSttProvider !== sttEntry.provider)
      || (entry.requiredLanguageCount !== null && entry.requiredLanguageCount !== translationLanguageCount());
    // A saved translation the current context can no longer support (the
    // caption-language count changed under it) repaints as the catalog default
    // rather than sitting on a disabled option no later change can move.
    // Nothing is written until the user picks.
    const savedTranslation = entryFor("translation", engine.translation);
    resolved.translation = (savedTranslation && !isTranslationBlocked(savedTranslation) ? savedTranslation : null)
      ?? entryFor("translation", catalog.defaults.translation) ?? catalog.translation[0];
    fillOptions(field(ROLE_FIELDS.stt), catalog.stt);
    fillOptions(field(ROLE_FIELDS.summary), catalog.summary);
    fillOptions(field(ROLE_FIELDS.translation), catalog.translation, isTranslationBlocked);
    for (const [role, name] of Object.entries(ROLE_FIELDS)) {
      const select = field(name);
      if (!select) continue;
      select.value = optionValue(resolved[role]);
      select.disabled = false;
    }
    const modeSelect = field(LANGUAGE_MODE_FIELD);
    if (modeSelect) {
      modeSelect.replaceChildren(...sttEntry.languageModes.map((mode) => {
        const option = modeSelect.ownerDocument.createElement("option");
        option.value = mode;
        option.textContent = translate(`engine.mode.${mode}`);
        return option;
      }));
      modeSelect.value = sttEntry.languageModes.includes(engine.stt.languageMode) ? engine.stt.languageMode : "auto";
      modeSelect.disabled = sttEntry.languageModes.length <= 1;
    }
    if (status) status.textContent = translate(hasSaveError ? "engine.saveFailed" : "engine.appliesNow");
  }
  async function commit() {
    if (!catalog || isPending) return;
    const stt = selectedEntry("stt");
    const summary = selectedEntry("summary");
    let translation = selectedEntry("translation");
    // A combined engine is only valid alongside its own STT and at the caption
    // language count it requires; switching either away from it must fall back
    // instead of submitting a pair the server rejects.
    if ((translation?.requiresSttProvider && translation.requiresSttProvider !== stt?.provider)
      || (translation?.requiredLanguageCount !== null && translation?.requiredLanguageCount !== undefined
        && translation.requiredLanguageCount !== translationLanguageCount())) {
      translation = entryFor("translation", catalog.defaults.translation);
    }
    if (!stt || !translation || !summary) { refresh(); return; }
    const modeSelect = field(LANGUAGE_MODE_FIELD);
    const languageMode = modeSelect && stt.languageModes.includes(modeSelect.value) ? modeSelect.value : "auto";
    const engine = {
      stt: { provider: stt.provider, model: stt.model, languageMode },
      translation: { provider: translation.provider, model: translation.model },
      summary: { provider: summary.provider, model: summary.model },
    };
    if (JSON.stringify(engine) === JSON.stringify(currentEngine())) { refresh(); return; }
    isPending = true;
    hasSaveError = false;
    refresh();
    try {
      await save({ engine });
      onSaved({ engine });
    } catch (error) {
      hasSaveError = true;
      onError(error);
    } finally {
      isPending = false;
      refresh();
    }
  }
  for (const name of ALL_FIELDS) {
    // The shared settings form also autosaves changes; the engine has exactly
    // one owner, so its own events never reach that handler.
    field(name)?.addEventListener("change", (event) => { event.stopPropagation(); void commit(); });
  }
  return {
    refresh,
    isSaving: () => isPending,
    setCatalog(value) {
      catalog = normalizeCaptionEngineCatalog(value);
      refresh();
    },
  };
}
