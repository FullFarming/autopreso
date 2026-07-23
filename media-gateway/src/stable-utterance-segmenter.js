const DEFAULT_MINIMUM_STABILITY = 0.85;
const DEFAULT_MAX_SEGMENT_MILLISECONDS = 2_400;

export class StableUtteranceSegmenter {
  #pendingWords = new Map();
  #emittedWords = new Map();

  constructor({
    minimumStability = DEFAULT_MINIMUM_STABILITY,
    maxSegmentMilliseconds = DEFAULT_MAX_SEGMENT_MILLISECONDS,
  } = {}) {
    if (!Number.isFinite(minimumStability) || minimumStability < 0 || minimumStability > 1) {
      throw new Error("INVALID_STT_STABILITY");
    }
    if (!Number.isSafeInteger(maxSegmentMilliseconds) || maxSegmentMilliseconds < 500) {
      throw new Error("INVALID_STT_SEGMENT_DURATION");
    }
    this.minimumStability = minimumStability;
    this.maxSegmentMilliseconds = maxSegmentMilliseconds;
  }

  accept(result) {
    const isFinal = Boolean(result?.isFinal);
    if (!isFinal && Number(result?.stability ?? 0) < this.minimumStability) return [];
    const alternative = result?.alternatives?.[0];
    const words = (alternative?.words ?? []).map(normalizeWord).filter((word) => word.text);
    if (isFinal && words.some((word) => !word.speakerLabel)) {
      throw new Error("STT_SPEAKER_CONTINUITY_AMBIGUOUS");
    }
    for (const word of words) this.#acceptWord(word);
    return this.#flush({ isFinal, sourceLanguage: result?.languageCode });
  }

  clear() {
    this.#pendingWords.clear();
    this.#emittedWords.clear();
  }

  #acceptWord(word) {
    const key = wordKey(word);
    const previous = this.#pendingWords.get(key) ?? this.#emittedWords.get(key);
    if (previous?.speakerLabel && word.speakerLabel && previous.speakerLabel !== word.speakerLabel) {
      throw new Error("STT_SPEAKER_CONTINUITY_AMBIGUOUS");
    }
    if (this.#emittedWords.has(key)) return;
    this.#pendingWords.set(key, {
      ...word,
      speakerLabel: word.speakerLabel || previous?.speakerLabel || "",
    });
  }

  #flush({ isFinal, sourceLanguage }) {
    const utterances = [];
    while (true) {
      const pending = [...this.#pendingWords.values()].sort(compareWords);
      if (pending.length === 0) break;
      const first = pending[0];
      if (!first.speakerLabel) {
        if (isFinal) throw new Error("STT_SPEAKER_CONTINUITY_AMBIGUOUS");
        break;
      }
      const run = [];
      for (const word of pending) {
        if (!word.speakerLabel || word.speakerLabel !== first.speakerLabel) break;
        run.push(word);
      }
      const hasSpeakerBoundary = run.length < pending.length && Boolean(pending[run.length]?.speakerLabel);
      const runDuration = run.at(-1).endMs - run[0].startMs;
      if (!isFinal && !hasSpeakerBoundary && runDuration < this.maxSegmentMilliseconds) break;

      let emitCount = run.length;
      if (runDuration > this.maxSegmentMilliseconds) {
        emitCount = 0;
        for (const word of run) {
          if (emitCount > 0 && word.endMs - run[0].startMs > this.maxSegmentMilliseconds) break;
          emitCount += 1;
        }
      }
      const emitted = run.slice(0, Math.max(1, emitCount));
      for (const word of emitted) {
        const key = wordKey(word);
        this.#pendingWords.delete(key);
        this.#emittedWords.set(key, word);
      }
      if (this.#emittedWords.size > 2_048) {
        this.#emittedWords.delete(this.#emittedWords.keys().next().value);
      }
      utterances.push({
        speakerLabel: first.speakerLabel,
        text: emitted.map((word) => word.text).join(" ").trim(),
        sourceStartOffsetMs: emitted[0].startMs,
        sourceEndOffsetMs: emitted.at(-1).endMs,
        ...(sourceLanguage ? { sourceLanguage } : {}),
      });
    }
    return utterances;
  }
}

export class StableTranscriptSegmenter {
  #committedTokens = [];
  #previousStableTokens = [];
  #lastEmittedEndMs = 0;

  constructor({ minimumStability = DEFAULT_MINIMUM_STABILITY, minimumCommonTokens = 3, onContinuityDiscard = () => {} } = {}) {
    if (!Number.isFinite(minimumStability) || minimumStability < 0 || minimumStability > 1) {
      throw new Error("INVALID_STT_STABILITY");
    }
    if (!Number.isSafeInteger(minimumCommonTokens) || minimumCommonTokens < 1) {
      throw new Error("INVALID_STT_COMMON_PREFIX");
    }
    this.minimumStability = minimumStability;
    this.minimumCommonTokens = minimumCommonTokens;
    this.onContinuityDiscard = onContinuityDiscard;
  }

  accept(result) {
    const isFinal = Boolean(result?.isFinal);
    if (!isFinal && Number(result?.stability ?? 0) < this.minimumStability) return [];
    const transcript = String(result?.alternatives?.[0]?.transcript ?? "").normalize("NFC").trim();
    if (!transcript) return [];
    const tokens = transcriptTokens(transcript, result?.languageCode);
    if (!isPrefix(this.#committedTokens, tokens)) {
      if (isFinal) {
        this.onContinuityDiscard();
        this.#committedTokens = [];
        this.#previousStableTokens = [];
        this.#lastEmittedEndMs = Math.max(this.#lastEmittedEndMs, resultEndMilliseconds(result));
        return [];
      }
      this.#previousStableTokens = [];
      return [];
    }

    let emitThrough = this.#committedTokens.length;
    if (isFinal) {
      emitThrough = tokens.length;
    } else if (this.#previousStableTokens.length > 0) {
      const commonLength = commonPrefixLength(this.#previousStableTokens, tokens);
      const candidate = tokens.slice(this.#committedTokens.length, commonLength);
      const sentenceBoundary = lastSentenceBoundary(candidate);
      if (sentenceBoundary > 0) emitThrough = this.#committedTokens.length + sentenceBoundary;
      else if (lexicalTokenCount(candidate) >= this.minimumCommonTokens) {
        // The provider commonly adds punctuation to the trailing token at finalization.
        emitThrough = this.#committedTokens.length + trailingLexicalTokenIndex(candidate);
      }
    }
    this.#previousStableTokens = tokens;
    if (emitThrough <= this.#committedTokens.length) {
      if (isFinal) {
        this.#committedTokens = [];
        this.#previousStableTokens = [];
      }
      return [];
    }

    const emittedTokens = tokens.slice(this.#committedTokens.length, emitThrough);
    const sourceEndOffsetMs = Math.max(this.#lastEmittedEndMs, resultEndMilliseconds(result));
    const utterance = {
      speakerLabel: "1",
      text: emittedTokens.join("").trim(),
      sourceStartOffsetMs: this.#lastEmittedEndMs,
      sourceEndOffsetMs,
      ...(result?.languageCode ? { sourceLanguage: result.languageCode } : {}),
    };
    this.#committedTokens = tokens.slice(0, emitThrough);
    this.#lastEmittedEndMs = sourceEndOffsetMs;
    if (isFinal) {
      this.#committedTokens = [];
      this.#previousStableTokens = [];
    }
    return [utterance];
  }

  clear() {
    this.#committedTokens = [];
    this.#previousStableTokens = [];
    this.#lastEmittedEndMs = 0;
  }
}

function normalizeWord(word) {
  return {
    text: String(word?.word ?? "").normalize("NFC").trim(),
    startMs: durationMilliseconds(word?.startOffset ?? word?.startTime),
    endMs: durationMilliseconds(word?.endOffset ?? word?.endTime),
    speakerLabel: String(word?.speakerLabel ?? word?.speakerTag ?? "").trim(),
  };
}

function durationMilliseconds(duration) {
  return Number(duration?.seconds ?? 0) * 1_000 + Number(duration?.nanos ?? 0) / 1_000_000;
}

function wordKey(word) {
  return `${word.startMs}:${word.endMs}`;
}

function compareWords(left, right) {
  return left.startMs - right.startMs || left.endMs - right.endMs;
}

function isPrefix(prefix, value) {
  return prefix.length <= value.length && prefix.every((token, index) => token === value[index]);
}

function commonPrefixLength(left, right) {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

function lastSentenceBoundary(tokens) {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (/[.!?。！？]/u.test(tokens[index])) return index + 1;
  }
  return 0;
}

function transcriptTokens(transcript, language) {
  const locale = typeof language === "string" && language ? language : undefined;
  let segmenter;
  try {
    segmenter = new Intl.Segmenter(locale, { granularity: "word" });
  } catch {
    segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  }
  return [...segmenter.segment(transcript)].map((part) => part.segment);
}

function lexicalTokenCount(tokens) {
  return tokens.filter((token) => /[\p{L}\p{M}\p{N}]/u.test(token)).length;
}

function trailingLexicalTokenIndex(tokens) {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (/[\p{L}\p{M}\p{N}]/u.test(tokens[index])) return index;
  }
  return 0;
}

function resultEndMilliseconds(result) {
  return durationMilliseconds(result?.resultEndTime ?? result?.resultEndOffset);
}
