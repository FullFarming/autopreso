const DEFAULT_PARTIAL_DELAY_MILLISECONDS = 40;
const DEFAULT_MAXIMUM_PENDING_PARTIALS = 12;

export const liveCaptionRelayContract = Object.freeze({
  partialDelayMilliseconds: DEFAULT_PARTIAL_DELAY_MILLISECONDS,
  maximumPendingPartials: DEFAULT_MAXIMUM_PENDING_PARTIALS,
});

export function resolveSelectedOverlayDisplay(displays, preferredDisplayId, primaryDisplay) {
  const connected = Array.isArray(displays) ? displays.filter(Boolean) : [];
  if (connected.length === 0) return null;
  const requestedDisplayId = String(preferredDisplayId ?? "");
  const exact = connected.find((display) => String(display.id) === requestedDisplayId);
  if (exact) return exact;
  const primary = connected.find((display) => String(display.id) === String(primaryDisplay?.id ?? ""));
  const resolvedPrimary = primary ?? connected[0];
  if (requestedDisplayId) return resolvedPrimary;
  // 2026-07-29 fix: an unset preference reserves the primary screen for the
  // operator. Persisted choices still win and remain untouched while unplugged.
  return connected.find((display) => String(display.id) !== String(resolvedPrimary.id)) ?? resolvedPrimary;
}

/** Every display that should carry an overlay window. In single mode that is
 *  just the selected display (resolveSelectedOverlayDisplay); with the
 *  controller's "all displays" tick on it is every connected screen, all
 *  showing the SAME captions. Deriving the whole window set from one rule keeps
 *  the toggle, hot-plug, and deselection reconciling identically instead of
 *  through separate branches that can disagree about which windows exist. */
export function resolveOverlayDisplays(displays, preferredDisplayId, primaryDisplay, allDisplays = false) {
  const connected = Array.isArray(displays) ? displays.filter(Boolean) : [];
  if (connected.length === 0) return [];
  if (allDisplays === true) return connected;
  const selected = resolveSelectedOverlayDisplay(connected, preferredDisplayId, primaryDisplay);
  return selected ? [selected] : [];
}

export function resolveControllerDisplay(displays, overlayDisplay, primaryDisplay) {
  const connected = Array.isArray(displays) ? displays.filter(Boolean) : [];
  if (connected.length === 0) return null;
  const primary = connected.find((display) => String(display.id) === String(primaryDisplay?.id ?? "")) ?? connected[0];
  if (String(overlayDisplay?.id) !== String(primary.id)) return primary;
  return connected.find((display) => String(display.id) !== String(overlayDisplay?.id)) ?? overlayDisplay ?? primary;
}

function defaultSchedule(callback, delay) {
  return setTimeout(callback, delay);
}

function defaultCancel(timer) {
  clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (timer));
}

function captionLanguage(caption) {
  return typeof caption?.language === "string" ? caption.language.trim().slice(0, 16) : "";
}

function captionSequence(caption) {
  return Number.isSafeInteger(caption?.seq) && caption.seq >= 0 ? caption.seq : null;
}

function boundedIdentityPart(value, maximum = 240) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maximum);
}

function captionIdentity(caption, language) {
  const sessionId = boundedIdentityPart(caption?.sessionId);
  const utteranceKey = boundedIdentityPart(caption?.utteranceKey);
  if (utteranceKey) return `${sessionId}\u0000${language}\u0000key:${utteranceKey}`;
  const sequence = captionSequence(caption);
  const role = caption?.speakerRole === "participant" || caption?.speaker?.isParticipant === true
    ? "participant"
    : "host";
  const speaker = boundedIdentityPart(
    caption?.speakerName ?? caption?.speaker?.name ?? caption?.speaker?.label ?? role,
    80,
  );
  return `${sessionId}\u0000${language}\u0000${sequence === null ? "unsequenced" : `seq:${sequence}`}\u0000${role}:${speaker}`;
}

/**
 * Coalesces only replaceable partials at the Electron IPC boundary. Finals are
 * delivered immediately and retained as a bounded reconnect snapshot.
 * @param {{
 *   send: (caption: Record<string, unknown>) => void,
 *   schedule?: (callback: () => void, delay: number) => unknown,
 *   cancel?: (timer: unknown) => void,
 *   partialDelayMilliseconds?: number,
 *   maximumPendingPartials?: number,
 *   lastFinalSeqByLanguage?: Map<string, number>,
 *   finalSnapshotByLanguage?: Map<string, Record<string, unknown>>,
 * }} options
 */
export function createLiveCaptionIpcRelay({
  send,
  schedule = defaultSchedule,
  cancel = defaultCancel,
  partialDelayMilliseconds = DEFAULT_PARTIAL_DELAY_MILLISECONDS,
  maximumPendingPartials = DEFAULT_MAXIMUM_PENDING_PARTIALS,
  lastFinalSeqByLanguage = new Map(),
  finalSnapshotByLanguage = new Map(),
}) {
  if (typeof send !== "function") throw new Error("LIVE_CAPTION_RELAY_SEND_REQUIRED");
  if (!Number.isSafeInteger(partialDelayMilliseconds) || partialDelayMilliseconds < 0) {
    throw new Error("INVALID_LIVE_CAPTION_PARTIAL_DELAY");
  }
  if (!Number.isSafeInteger(maximumPendingPartials) || maximumPendingPartials < 1) {
    throw new Error("INVALID_LIVE_CAPTION_PENDING_LIMIT");
  }
  /** @type {Map<string, {caption: Record<string, unknown>, timer: unknown}>} */
  const pendingPartials = new Map();
  let isClosed = false;

  function removePending(identity) {
    const pending = pendingPartials.get(identity);
    if (!pending) return;
    cancel(pending.timer);
    pendingPartials.delete(identity);
  }

  function flushPartial(identity) {
    const pending = pendingPartials.get(identity);
    if (!pending) return;
    pendingPartials.delete(identity);
    if (isClosed) return;
    const language = captionLanguage(pending.caption);
    const finalSequence = lastFinalSeqByLanguage.get(language);
    const partialSequence = captionSequence(pending.caption);
    if (partialSequence !== null && finalSequence !== undefined && partialSequence <= finalSequence) return;
    send(pending.caption);
  }

  function enqueuePartial(language, identity, caption) {
    const sequence = captionSequence(caption);
    const finalSequence = lastFinalSeqByLanguage.get(language);
    if (sequence !== null && finalSequence !== undefined && sequence <= finalSequence) return false;
    const existing = pendingPartials.get(identity);
    if (existing) {
      existing.caption = caption;
      return true;
    }
    if (pendingPartials.size >= maximumPendingPartials) {
      removePending(pendingPartials.keys().next().value);
    }
    const timer = schedule(() => flushPartial(identity), partialDelayMilliseconds);
    const pending = { caption, timer };
    pendingPartials.set(identity, pending);
    return true;
  }

  function deliverFinal(language, identity, caption) {
    const sequence = captionSequence(caption);
    const lastSequence = lastFinalSeqByLanguage.get(language);
    if (sequence !== null && lastSequence !== undefined && sequence <= lastSequence) return false;
    const pending = pendingPartials.get(identity);
    const pendingSequence = captionSequence(pending?.caption);
    if (pending && (sequence === null || pendingSequence === null || pendingSequence <= sequence)) {
      removePending(identity);
    }
    if (sequence !== null) lastFinalSeqByLanguage.set(language, sequence);
    finalSnapshotByLanguage.set(language, caption);
    send(caption);
    return true;
  }

  return {
    push(caption) {
      if (isClosed || !caption || typeof caption !== "object") return false;
      const language = captionLanguage(caption);
      if (!language) return false;
      const identity = captionIdentity(caption, language);
      return caption.isFinal === true
        ? deliverFinal(language, identity, caption)
        : enqueuePartial(language, identity, caption);
    },
    close() {
      if (isClosed) return;
      isClosed = true;
      for (const identity of [...pendingPartials.keys()]) removePending(identity);
    },
    snapshot() {
      return [...finalSnapshotByLanguage.values()];
    },
  };
}
