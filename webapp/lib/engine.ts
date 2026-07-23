// Session engine: owns audio captures and the (source × targetLanguage)
// translation channel matrix — up to 6 sockets for three targets with both
// inputs active. Port of the manager/client layering in
// autopreso/src/subtitle-realtime.js adapted to browser capture.

import {
  createPcmCapture,
  getMicStream,
  getTabAudioStream,
  stopStream,
  type AudioCapture,
} from "./audio";
import { createTranslationChannel, type TranslationChannel } from "./channelCore";
import { createGeminiTransport } from "./geminiChannel";
import {
  createOpenAITranslationWebRtc,
  type OpenAITranslationWebRtcSession,
} from "./openaiTranslationWebRtc";
import { normalizeLanguageCode, type LanguageCode } from "./languageDetect";
import type { AudioSource, EngineEvent, EngineKind, InputMode, LanguagePairId, PolishFn, ToneKind } from "./types";

export interface EngineConfig {
  inputMode: InputMode;
  languagePair: LanguagePairId;
  /** both | a2b | b2a — single-direction halves realtime audio cost. */
  direction?: "both" | "a2b" | "b2a";
  /** Meeting mode: explicit target set (up to 3) overriding the pair. */
  targetLanguages?: LanguageCode[];
  engine: EngineKind;
  tone: ToneKind;
  glossary: string;
  domain: string;
  /** Show + transcribe the source line. Off lets single-direction sessions
   *  skip the transcription model (cost). */
  showSource?: boolean;
  /** Drop near-silent audio so dead air isn't billed (no word clipping). */
  silenceGate?: boolean;
  emit: (event: EngineEvent) => void;
}

export function targetsForConfig(config: Pick<EngineConfig, "targetLanguages" | "languagePair" | "direction">): LanguageCode[] {
  if (config.targetLanguages?.length) {
    const targets = config.targetLanguages
      .map(normalizeLanguageCode)
      .filter((language): language is Exclude<ReturnType<typeof normalizeLanguageCode>, ""> => Boolean(language));
    return Array.from(new Set(targets)).slice(0, 3);
  }
  const [a, b] = languagesForPair(config.languagePair);
  if (config.direction === "a2b") return [b];
  if (config.direction === "b2a") return [a];
  return [a, b];
}

export interface TranslationEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Warm pause: stop sending audio to the realtime sockets (so no audio-input
   *  tokens are billed) while keeping the sockets open for instant resume. */
  pause(): void;
  resume(): void;
  isPaused(): boolean;
}

export function languagesForPair(pair: LanguagePairId): [LanguageCode, LanguageCode] {
  if (pair === "ko-ja") return ["ko", "ja"];
  if (pair === "en-ja") return ["en", "ja"];
  return ["ko", "en"];
}

function sourcesForInputMode(inputMode: InputMode): AudioSource[] {
  if (inputMode === "mic") return ["mic"];
  if (inputMode === "tab") return ["tab"];
  return ["mic", "tab"];
}

// Client-side gate mirrors the server's: natural tone with no glossary/domain
// never round-trips through /api/polish, keeping commits instant.
export function createPolisher(config: Pick<EngineConfig, "tone" | "glossary" | "domain">): PolishFn {
  return async ({ translatedText, sourceText, targetLanguage, tone, glossary, domain }) => {
    if (tone !== "business" && !glossary.trim() && !domain.trim()) return translatedText;
    try {
      const response = await fetch("/api/polish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ translatedText, sourceText, targetLanguage, tone, glossary, domain }),
      });
      if (!response.ok) return translatedText;
      const data: unknown = await response.json().catch(() => null);
      const polished = data && typeof data === "object" && "translatedText" in data
        ? Reflect.get(data, "translatedText")
        : "";
      return String(polished ?? "").trim() || translatedText;
    } catch {
      return translatedText;
    }
  };
}

export function createTranslationEngine(config: EngineConfig): TranslationEngine {
  const channels: TranslationChannel[] = [];
  const channelsBySource = new Map<AudioSource, TranslationChannel[]>();
  const openAiSessions: OpenAITranslationWebRtcSession[] = [];
  const captures: AudioCapture[] = [];
  const streams: MediaStream[] = [];
  let started = false;
  let stopped = false;
  let paused = false;

  const polish = createPolisher(config);

  function buildChannels(source: AudioSource, targets: LanguageCode[]) {
    const list: TranslationChannel[] = [];
    for (const targetLanguage of targets) {
      const transport = createGeminiTransport({ targetLanguage });
      const channel = createTranslationChannel({
        source,
        targetLanguage,
        transport,
        settings: { tone: config.tone, glossary: config.glossary, domain: config.domain },
        broadcast: (event) => {
          if (stopped) return;
          config.emit(event);
        },
        polish,
        crossLanguageOnly: false,
        // Gemini's translate model never sends turnComplete, so commit hinges
        // on the quiet-flush — shorten it so finalized lines aren't ~1.2s late.
        commitQuietMs: 600,
      });
      list.push(channel);
      channels.push(channel);
    }
    channelsBySource.set(source, list);
  }

  return {
    async start() {
      if (started) return;
      started = true;
      const targets = targetsForConfig(config);
      const sources = sourcesForInputMode(config.inputMode);
      config.emit({ type: "status", status: "connecting" });

      // Acquire media first so a permission denial fails the whole start
      // before any socket opens.
      const acquired: Array<{ source: AudioSource; stream: MediaStream }> = [];
      try {
        for (const source of sources) {
          const stream = source === "mic" ? await getMicStream() : await getTabAudioStream();
          acquired.push({ source, stream });
          streams.push(stream);
        }
      } catch (error) {
        for (const stream of streams) stopStream(stream);
        streams.length = 0;
        started = false;
        throw error;
      }

      try {
        for (const { source, stream } of acquired) {
          for (const track of stream.getAudioTracks()) {
            track.addEventListener("ended", () => {
              if (!stopped) {
                config.emit({
                  type: "error",
                  message: source === "tab" ? "탭 오디오 공유가 중지되었습니다." : "마이크 입력이 중지되었습니다.",
                  code: "TRACK_ENDED",
                });
              }
            });
          }
          if (config.engine === "openai") {
            const sessions = targets.map((targetLanguage) => createOpenAITranslationWebRtc({
              source,
              targetLanguage,
              stream,
              emit: (event) => {
                if (!stopped) config.emit(event);
              },
              polish,
              tone: config.tone,
              glossary: config.glossary,
              domain: config.domain,
            }));
            for (const session of sessions) session.allowPlayback();
            openAiSessions.push(...sessions);
            await Promise.all(sessions.map((session) => session.start()));
            continue;
          }

          buildChannels(source, targets);
          const sourceChannels = channelsBySource.get(source) ?? [];
          for (const channel of sourceChannels) channel.open();
          const capture = createPcmCapture({
            stream,
            silenceGate: config.silenceGate ?? true,
            onLevel: (value) => {
              if (!stopped) config.emit({ type: "level", source, value: paused ? 0 : value });
            },
            onChunk: (base64) => {
              // Warm pause: drop frames so no audio-input tokens are billed.
              if (paused || stopped) return;
              for (const channel of sourceChannels) channel.sendAudio(base64);
            },
          });
          captures.push(capture);
        }
      } catch (error) {
        await Promise.all(openAiSessions.map((session) => session.close().catch(() => undefined)));
        openAiSessions.length = 0;
        for (const stream of streams) stopStream(stream);
        streams.length = 0;
        started = false;
        throw error;
      }
      config.emit({ type: "status", status: "listening" });
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      for (const capture of captures) capture.stop();
      for (const stream of streams) stopStream(stream);
      await Promise.all([
        ...channels.map((channel) => channel.close({ graceful: true }).catch(() => undefined)),
        ...openAiSessions.map((session) => session.close().catch(() => undefined)),
      ]);
      channels.length = 0;
      openAiSessions.length = 0;
      channelsBySource.clear();
      config.emit({ type: "status", status: "idle" });
    },

    pause() {
      if (stopped || paused) return;
      paused = true;
      for (const channel of channels) channel.resetAudioInput();
      // Mute mic tracks too so the local capture goes quiet (tab audio can't be
      // muted, but frame-gating already stops it from reaching the sockets).
      for (const stream of streams) {
        for (const track of stream.getAudioTracks()) track.enabled = false;
      }
      config.emit({ type: "status", status: "paused" });
    },

    resume() {
      if (stopped || !paused) return;
      paused = false;
      for (const stream of streams) {
        for (const track of stream.getAudioTracks()) track.enabled = true;
      }
      config.emit({ type: "status", status: "listening" });
    },

    isPaused() {
      return paused;
    },
  };
}

// ---------------------------------------------------------------------------
// Meeting-mode push-to-talk engine: one mic, N target-language channels whose
// set follows room presence. Channels stay open across PTT presses (no
// reconnect latency); the mic track is muted between presses and the capture
// keeps streaming ~1.2s of trailing silence after release so server VAD can
// finalize the utterance and the 1200ms quiet-flush commit can fire.
// ---------------------------------------------------------------------------

const PTT_RELEASE_TAIL_MS = 1200;

export interface MeetingEngineConfig {
  tone: ToneKind;
  glossary: string;
  domain: string;
  /** ja targets auto-route to Gemini like the main app; others use this. */
  defaultEngine: EngineKind;
  emit: (event: EngineEvent) => void;
}

export interface MeetingSpeechEngine {
  /** Reconcile channels with the room's distinct participant languages. */
  setTargets(targets: LanguageCode[]): void;
  startTalking(): Promise<void>;
  stopTalking(): void;
  destroy(): Promise<void>;
}

export function engineForTarget(targetLanguage: LanguageCode, defaultEngine: EngineKind): EngineKind {
  return targetLanguage === "ja" ? "gemini" : defaultEngine;
}

export function createMeetingSpeechEngine(config: MeetingEngineConfig): MeetingSpeechEngine {
  const channels = new Map<LanguageCode, TranslationChannel>();
  const openAiSessions = new Map<LanguageCode, OpenAITranslationWebRtcSession>();
  const requestedTargets = new Set<LanguageCode>();
  const polish = createPolisher(config);
  let micStream: MediaStream | null = null;
  let capture: AudioCapture | null = null;
  let tailTimer: ReturnType<typeof setTimeout> | null = null;
  let talking = false;
  let destroyed = false;

  function buildChannel(targetLanguage: LanguageCode): TranslationChannel {
    const transport = createGeminiTransport({ targetLanguage });
    return createTranslationChannel({
      source: "mic",
      targetLanguage,
      transport,
      settings: { tone: config.tone, glossary: config.glossary, domain: config.domain },
      broadcast: (event) => {
        if (destroyed) return;
        config.emit(event);
      },
      polish,
      commitQuietMs: 600,
    });
  }

  async function ensureOpenAiSession(targetLanguage: LanguageCode): Promise<void> {
    if (!micStream || destroyed || openAiSessions.has(targetLanguage)) return;
    const session = createOpenAITranslationWebRtc({
      source: "mic",
      targetLanguage,
      stream: micStream,
      emit: (event) => {
        if (!destroyed) config.emit(event);
      },
      polish,
      tone: config.tone,
      glossary: config.glossary,
      domain: config.domain,
    });
    session.allowPlayback();
    openAiSessions.set(targetLanguage, session);
    try {
      await session.start();
    } catch (error) {
      openAiSessions.delete(targetLanguage);
      await session.close().catch(() => undefined);
      throw error;
    }
  }

  async function reconcileOpenAiSessions(): Promise<void> {
    const starts: Promise<void>[] = [];
    for (const language of requestedTargets) {
      if (engineForTarget(language, config.defaultEngine) === "openai") {
        starts.push(ensureOpenAiSession(language));
      }
    }
    await Promise.all(starts);
  }

  function stopCapture() {
    capture?.stop();
    capture = null;
    for (const channel of channels.values()) channel.resetAudioInput();
  }

  function clearTailTimer() {
    if (tailTimer) clearTimeout(tailTimer);
    tailTimer = null;
  }

  return {
    setTargets(targets: LanguageCode[]) {
      if (destroyed) return;
      const next = new Set(targets.slice(0, 3));
      requestedTargets.clear();
      for (const language of next) requestedTargets.add(language);
      for (const [language, channel] of channels) {
        if (!next.has(language) || engineForTarget(language, config.defaultEngine) !== "gemini") {
          channels.delete(language);
          void channel.close({ graceful: true }).catch(() => undefined);
        }
      }
      for (const [language, session] of openAiSessions) {
        if (!next.has(language) || engineForTarget(language, config.defaultEngine) !== "openai") {
          openAiSessions.delete(language);
          void session.close().catch(() => undefined);
        }
      }
      for (const language of next) {
        if (engineForTarget(language, config.defaultEngine) === "gemini" && !channels.has(language)) {
          const channel = buildChannel(language);
          channels.set(language, channel);
          channel.open();
        }
      }
      void reconcileOpenAiSessions().catch(() => {
        if (!destroyed) {
          config.emit({ type: "error", message: "OpenAI 실시간 번역 연결에 실패했습니다.", code: "OPENAI_TRANSLATION_CONNECT_FAILED" });
        }
      });
    },

    async startTalking() {
      if (destroyed || talking) return;
      clearTailTimer();
      if (!micStream) {
        micStream = await getMicStream();
      }
      await reconcileOpenAiSessions();
      for (const track of micStream.getAudioTracks()) track.enabled = true;
      talking = true;
      for (const channel of channels.values()) channel.open();
      if (!capture) {
        capture = createPcmCapture({
          stream: micStream,
          onLevel: (value) => {
            if (!destroyed) config.emit({ type: "level", source: "mic", value });
          },
          onChunk: (base64) => {
            for (const channel of channels.values()) channel.sendAudio(base64);
          },
        });
      }
      config.emit({ type: "status", status: "listening" });
    },

    stopTalking() {
      if (destroyed || !talking) return;
      talking = false;
      // Mute (don't stop) so the capture streams real silence — VAD needs the
      // trailing quiet to finalize; the mic permission also stays warm.
      if (micStream) {
        for (const track of micStream.getAudioTracks()) track.enabled = false;
      }
      clearTailTimer();
      tailTimer = setTimeout(() => {
        tailTimer = null;
        stopCapture();
      }, PTT_RELEASE_TAIL_MS);
      config.emit({ type: "status", status: "translating" });
    },

    async destroy() {
      if (destroyed) return;
      destroyed = true;
      talking = false;
      clearTailTimer();
      stopCapture();
      stopStream(micStream);
      micStream = null;
      const closing = Array.from(channels.values());
      const closingOpenAi = Array.from(openAiSessions.values());
      channels.clear();
      openAiSessions.clear();
      requestedTargets.clear();
      await Promise.all([
        ...closing.map((channel) => channel.close({ graceful: true }).catch(() => undefined)),
        ...closingOpenAi.map((session) => session.close().catch(() => undefined)),
      ]);
    },
  };
}
