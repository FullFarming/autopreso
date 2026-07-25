const COLOR_TOKENS = ["speaker-blue", "speaker-red", "speaker-green", "speaker-purple", "speaker-orange", "speaker-teal"];
const CHIRP_VOICES = ["Achernar", "Algenib", "Algieba", "Alnilam", "Aoede", "Autonoe"];
const AUTO_VOICE_PREFERENCES = Object.freeze({
  low: ["Algenib", "Algieba", "Alnilam", "Autonoe", "Achernar", "Aoede"],
  mid: ["Alnilam", "Autonoe", "Algenib", "Algieba", "Achernar", "Aoede"],
  high: ["Achernar", "Aoede", "Autonoe", "Alnilam", "Algieba", "Algenib"],
});

export class SpeakerRemapError extends Error {
  constructor(message = "STT_SPEAKER_REMAP_AMBIGUOUS") {
    super(message);
    this.name = "SpeakerRemapError";
    this.code = "STT_SPEAKER_REMAP_AMBIGUOUS";
  }
}

export class SpeakerRegistry {
  #byProviderLabel = new Map();

  constructor({ sessionType, outputMode, mode, voiceOutputMode, now = Date.now }) {
    const settings = normalizeSpeakerSettings({ sessionType, outputMode, mode, voiceOutputMode });
    this.sessionType = settings.sessionType;
    this.outputMode = settings.outputMode;
    this.now = now;
  }

  setMode(sessionType, outputMode = "captions") {
    const settings = normalizeSpeakerSettings({ sessionType, outputMode });
    this.sessionType = settings.sessionType;
    this.outputMode = settings.outputMode;
    const assignments = [...new Set(this.#byProviderLabel.values())];
    const replacements = new Map(assignments.map((assignment, index) => [assignment, {
      ...assignment,
      voiceName: hasAudioOutput(settings.outputMode) ? CHIRP_VOICES[index] : null,
      voiceStatus: hasAudioOutput(settings.outputMode) ? "ready" : "disabled",
    }]));
    for (const [label, assignment] of this.#byProviderLabel) this.#byProviderLabel.set(label, replacements.get(assignment));
  }

  getOrCreate(providerLabel) {
    const existing = this.#byProviderLabel.get(providerLabel);
    if (existing) {
      existing.lastSeenAt = new Date(this.now()).toISOString();
      return existing;
    }
    const index = this.list().length;
    // Named floor participants (participant:<id>) may exceed the six
    // diarization slots: they carry their own display identity, so the
    // legend grows instead of mis-attributing their captions.
    const isFloorParticipant = providerLabel.startsWith("participant:");
    if (index >= 6 && !isFloorParticipant) throw new Error("SPEAKER_LIMIT_EXCEEDED");
    const paletteIndex = index % COLOR_TOKENS.length;
    const lastSeenAt = new Date(this.now()).toISOString();
    const assignment = {
      speakerId: `speaker-${index + 1}`,
      label: `Speaker ${index + 1}`,
      colorToken: COLOR_TOKENS[paletteIndex],
      voiceName: hasAudioOutput(this.outputMode) ? CHIRP_VOICES[paletteIndex] : null,
      voiceStatus: hasAudioOutput(this.outputMode) ? "ready" : "disabled",
      lastSeenAt,
    };
    this.#byProviderLabel.set(providerLabel, assignment);
    return assignment;
  }

  assignCompatibleVoice(providerLabel, acousticRange) {
    const assignment = this.#byProviderLabel.get(providerLabel);
    if (!assignment) throw new Error("AUTO_VOICE_ASSIGNMENT_UNAVAILABLE");
    if (assignment.voiceStatus === "ready" && assignment.voiceName) return assignment;
    const preferences = AUTO_VOICE_PREFERENCES[acousticRange];
    if (!preferences) throw new Error("ACOUSTIC_RANGE_UNCERTAIN");
    const usedVoices = new Set(this.list().map((speaker) => speaker.voiceName).filter(Boolean));
    const voiceName = preferences.find((candidate) => !usedVoices.has(candidate));
    if (!voiceName) throw new Error("AUTO_VOICE_PRESET_CONFLICT");
    assignment.voiceName = voiceName;
    assignment.voiceStatus = "ready";
    return assignment;
  }

  markVoiceUnavailable(providerLabel) {
    const assignment = this.#byProviderLabel.get(providerLabel);
    if (!assignment) return;
    assignment.voiceName = null;
    assignment.voiceStatus = "unavailable";
  }

  alias(providerLabel, existingProviderLabel) {
    const assignment = this.#byProviderLabel.get(existingProviderLabel);
    if (!assignment) throw new SpeakerRemapError();
    this.#byProviderLabel.set(providerLabel, assignment);
  }

  list() {
    return [...new Set(this.#byProviderLabel.values())];
  }
}

function hasAudioOutput(outputMode) {
  return outputMode === "captions_audio" || outputMode === "audio";
}

function normalizeSpeakerSettings({ sessionType, outputMode, mode, voiceOutputMode }) {
  const normalizedSessionType = sessionType ?? (mode === "presentation" ? "presentation" : "meeting");
  const normalizedOutputMode = outputMode
    ?? (mode === "townhall" || voiceOutputMode === "fixed_voice" || voiceOutputMode === "auto_voice" ? "audio" : "captions");
  return { sessionType: normalizedSessionType, outputMode: normalizedOutputMode };
}

export function remapRolloverSpeakers(previousWords, nextWords, toleranceMilliseconds = 120) {
  const candidates = new Map();
  for (const next of nextWords) {
    for (const previous of previousWords) {
      if (normalizeWord(next.word) !== normalizeWord(previous.word)) continue;
      if (Math.abs(next.startMs - previous.startMs) > toleranceMilliseconds) continue;
      if (Math.abs(next.endMs - previous.endMs) > toleranceMilliseconds) continue;
      const labels = candidates.get(next.speakerLabel) ?? new Set();
      labels.add(previous.speakerLabel);
      candidates.set(next.speakerLabel, labels);
    }
  }
  if (candidates.size === 0) throw new SpeakerRemapError();
  const mapping = new Map();
  const claimed = new Set();
  for (const [nextLabel, previousLabels] of candidates) {
    if (previousLabels.size !== 1) throw new SpeakerRemapError();
    const [previousLabel] = previousLabels;
    if (claimed.has(previousLabel)) throw new SpeakerRemapError();
    claimed.add(previousLabel);
    mapping.set(nextLabel, previousLabel);
  }
  return mapping;
}

function normalizeWord(word) {
  return String(word).normalize("NFC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
