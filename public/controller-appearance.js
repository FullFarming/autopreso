export function applyControllerAppearance(settings, message) {
  if (message.command === "font-size" && Number.isFinite(message.fontSize)) {
    const translationFontSize = Math.max(18, Math.min(72, message.fontSize));
    return { ...settings, translationFontSize, sourceFontSize: Math.max(14, translationFontSize - 2) };
  }
  if (message.command === "opacity" && Number.isFinite(message.opacity)) return { ...settings, opacity: Math.max(0, Math.min(1, message.opacity)) };
  if (message.command === "position" && ["top-center", "middle-center", "bottom-center"].includes(message.position)) {
    return { ...settings, position: message.position, subtitlePositions: Object.fromEntries((settings.translationLanguages ?? ["en", "ko"]).map((language) => [language, message.position])) };
  }
  return null;
}

export function createLatestAppearanceSender(send, delay = 60) {
  const pending = new Map();
  let timer = null;
  function flush(preview = true) {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const message of pending.values()) send({ ...message, preview });
    pending.clear();
  }
  return {
    input(message) { pending.set(message.command, message); if (!timer) timer = setTimeout(() => flush(true), delay); },
    commit(message) { pending.delete(message.command); send({ ...message, preview: false }); },
    flush: () => flush(false),
    close() { if (timer) clearTimeout(timer); timer = null; pending.clear(); },
  };
}

export function captureAppearanceEdits(settings, message) {
  if (message.command === "font-size") return { translationFontSize: settings.translationFontSize, sourceFontSize: settings.sourceFontSize };
  if (message.command === "opacity") return { opacity: settings.opacity };
  if (message.command === "position") return { position: settings.position, subtitlePositions: settings.subtitlePositions };
  return {};
}

export function acknowledgeAppearance(incoming, edits) {
  const remaining = Object.fromEntries(Object.entries(edits).filter(([key, value]) => JSON.stringify(incoming[key]) !== JSON.stringify(value)));
  return { settings: { ...incoming, ...remaining }, edits: remaining };
}
