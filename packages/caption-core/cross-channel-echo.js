const DEFAULT_WINDOW_MILLISECONDS = 6_000;
const MINIMUM_SOURCE_CHARACTERS = 4;
const MINIMUM_COMPARISON_CHARACTERS = 6;

export const crossChannelEchoContract = Object.freeze({
  windowMilliseconds: DEFAULT_WINDOW_MILLISECONDS,
  minimumSourceCharacters: MINIMUM_SOURCE_CHARACTERS,
  minimumComparisonCharacters: MINIMUM_COMPARISON_CHARACTERS,
});

export function normalizeCrossChannelText(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9가-힣ぁ-んァ-ヶ一-龯]/g, "");
}

export function createCrossChannelEchoDeduper({
  now: nowFn = () => Date.now(),
  windowMilliseconds = DEFAULT_WINDOW_MILLISECONDS,
} = {}) {
  const recentSources = new Map();
  const channels = new Map();

  function registerChannel(channelKey, hooks = {}) {
    channels.set(channelKey, hooks);
  }

  function unregisterChannel(channelKey) {
    channels.delete(channelKey);
    recentSources.delete(channelKey);
  }

  function recordSource(channelKey, text) {
    const normalized = normalizeCrossChannelText(text);
    if (normalized.length < MINIMUM_SOURCE_CHARACTERS) return;
    storeSource(channelKey, normalized);
  }

  function observeSource(channelKey, text) {
    const normalizedText = normalizeCrossChannelText(text);
    if (normalizedText.length < MINIMUM_SOURCE_CHARACTERS) {
      return { normalizedText, isDuplicate: false };
    }
    const isDuplicate = matchesAnotherRecentSource(channelKey, normalizedText);
    storeSource(channelKey, normalizedText);
    return { normalizedText, isDuplicate };
  }

  function storeSource(channelKey, normalized) {
    recentSources.set(channelKey, { normalized, at: nowFn() });
    for (const [key, hooks] of channels) {
      if (key === channelKey) continue;
      const lastPartial = normalizeCrossChannelText(hooks.getLastPartial?.() ?? "");
      if (
        lastPartial.length >= MINIMUM_COMPARISON_CHARACTERS
        && (normalized.includes(lastPartial) || lastPartial.includes(normalized))
      ) hooks.clearEcho?.();
    }
  }

  function outputEchoesAnotherSource(channelKey, outputText) {
    const output = normalizeCrossChannelText(outputText);
    if (output.length < MINIMUM_COMPARISON_CHARACTERS) return false;
    return matchesAnotherRecentSource(channelKey, output);
  }

  function matchesAnotherRecentSource(channelKey, normalizedText) {
    if (normalizedText.length < MINIMUM_COMPARISON_CHARACTERS) return false;
    const currentTime = nowFn();
    for (const [key, source] of recentSources) {
      if (
        key === channelKey
        || currentTime - source.at > windowMilliseconds
        || source.normalized.length < MINIMUM_COMPARISON_CHARACTERS
      ) continue;
      if (source.normalized.includes(normalizedText) || normalizedText.includes(source.normalized)) return true;
    }
    return false;
  }

  function reset(channelKey) {
    if (channelKey === undefined) {
      recentSources.clear();
      return;
    }
    recentSources.delete(channelKey);
  }

  return {
    normalize: normalizeCrossChannelText,
    observeSource,
    outputEchoesAnotherSource,
    recordSource,
    registerChannel,
    reset,
    unregisterChannel,
  };
}
