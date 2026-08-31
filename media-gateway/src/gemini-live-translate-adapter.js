import { normalizeLiveLanguage } from "./config.js";

const MODEL = "gemini-3.5-live-translate-preview";
const CHUNK_BYTES = 3_200;
const MAX_TEXT_CHARACTERS = 16_000;
const MAX_AUDIO_CHUNK_BYTES = 1_048_576;
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu;
const USAGE_FIELDS = ["promptTokenCount", "responseTokenCount", "totalTokenCount", "thoughtsTokenCount", "cachedContentTokenCount"];

function limit(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("LIVE_TRANSLATE_LIMIT_INVALID");
  return value;
}
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function transcript(value, targetLanguageCode, direction) {
  if (!record(value)
    || (value.text !== undefined && typeof value.text !== "string")
    || (value.finished !== undefined && typeof value.finished !== "boolean")) throw new Error("LIVE_TRANSLATE_TRANSCRIPT_INVALID");
  const text = value.text ?? "";
  const languageCode = value.languageCode ?? null;
  if (text.length > MAX_TEXT_CHARACTERS || Buffer.byteLength(text, "utf8") > 64_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
    || /<\/?[A-Za-z][^>]*>/u.test(text)
    || (languageCode !== null && (typeof languageCode !== "string" || languageCode.length > 64 || !LANGUAGE_CODE.test(languageCode)))) {
    throw new Error("LIVE_TRANSLATE_TRANSCRIPT_INVALID");
  }
  if (direction === "output" && languageCode !== null) {
    const base = languageCode.split("-")[0].toLowerCase();
    const targetBase = targetLanguageCode.split("-")[0].toLowerCase();
    const normalized = normalizeLiveLanguage(languageCode);
    // Generic zh does not prove a Hans/Hant mismatch; an explicit variant can.
    if (base !== targetBase || (base === "zh" && languageCode.includes("-") && normalized && normalized !== targetLanguageCode)) {
      throw new Error("LIVE_TRANSLATE_TARGET_MISMATCH");
    }
  }
  // Chunk boundaries can bisect words and Unicode sequences. Preserve raw text
  // until a separately verified protocol profile defines how to assemble it.
  return { direction, text, languageCode, finished: value.finished ?? null };
}

/** Transport observations only: no sentence pairing or durable-final inference. */
export class GeminiLiveTranslateAdapter {
  constructor({
    client, targetLanguageCode, model = MODEL, echoTargetLanguage = true,
    connectTimeoutMilliseconds = 10_000, drainMilliseconds = 1_000,
    shutdownTimeoutMilliseconds = 5_000, maxPendingFrames = 64, maxPendingEvents = 64,
    maxConnectionMilliseconds = 300_000, now = Date.now,
  }) {
    if (model !== MODEL || echoTargetLanguage !== true) throw new Error("LIVE_TRANSLATE_OVERRIDE_FORBIDDEN");
    if (typeof client?.live?.connect !== "function") throw new Error("LIVE_TRANSLATE_CLIENT_UNAVAILABLE");
    const target = normalizeLiveLanguage(targetLanguageCode);
    if (!target || target !== targetLanguageCode) throw new Error("LIVE_TRANSLATE_TARGET_INVALID");
    if (typeof now !== "function") throw new Error("LIVE_TRANSLATE_CLOCK_INVALID");
    this.client = client;
    this.targetLanguageCode = target;
    this.connectTimeoutMilliseconds = limit(connectTimeoutMilliseconds, 30_000);
    this.drainMilliseconds = limit(drainMilliseconds, 10_000);
    this.shutdownTimeoutMilliseconds = limit(shutdownTimeoutMilliseconds, 10_000);
    this.maxPendingFrames = limit(maxPendingFrames, 250);
    this.maxPendingEvents = limit(maxPendingEvents, 256);
    // An application billing ceiling, not a claim about this model's lifetime.
    this.maxConnectionMilliseconds = limit(maxConnectionMilliseconds, 3_600_000);
    this.now = now;
  }

  async open({ onTranscript, onBoundary = () => {}, onUsage = () => {}, onError = () => {}, signal } = {}) {
    if ([onTranscript, onBoundary, onUsage, onError].some((callback) => typeof callback !== "function")) throw new Error("LIVE_TRANSLATE_CALLBACK_INVALID");
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error("LIVE_TRANSLATE_SIGNAL_INVALID");
    if (signal?.aborted) throw new Error("LIVE_TRANSLATE_ABORTED");
    const controller = new AbortController();
    const targetLanguageCode = this.targetLanguageCode;
    let provider = null;
    let terminalError = null;
    let isClosing = false;
    let isClosed = false;
    let acceptMessages = true;
    let didCloseProvider = false;
    let providerCloseTask = null;
    let closePromise = null;
    let writeTail = Promise.resolve();
    let eventTail = Promise.resolve();
    let pendingFrames = 0;
    let pendingEvents = 0;
    let pendingEventBytes = 0;
    let sequence = 0;
    let inputTail = Buffer.alloc(0);
    let didEndInput = false;
    let inputAudioBytes = 0;
    let outputAudioBytes = 0;
    let providerUsage = null;
    let lifetimeTimer;
    let connectTimer;
    let rejectFailure;
    const timers = new Set();
    const failure = new Promise((_, reject) => { rejectFailure = reject; });
    void failure.catch(() => {});
    const usage = () => ({
      inputAudioMilliseconds: inputAudioBytes / 32,
      outputAudioMilliseconds: outputAudioBytes / 48,
      providerUsage: providerUsage === null ? null : { ...providerUsage },
    });
    const closeProvider = () => {
      if (providerCloseTask) return providerCloseTask;
      if (!provider || didCloseProvider) return Promise.resolve();
      didCloseProvider = true;
      try { providerCloseTask = Promise.resolve(provider.close()); }
      catch { providerCloseTask = Promise.reject(new Error("LIVE_TRANSLATE_CLOSE_FAILED")); }
      void providerCloseTask.catch(() => { terminalError ??= new Error("LIVE_TRANSLATE_CLOSE_FAILED"); });
      return providerCloseTask;
    };
    const cleanTimers = () => {
      clearTimeout(connectTimer);
      clearTimeout(lifetimeTimer);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
    const dispose = () => {
      isClosed = true;
      acceptMessages = false;
      cleanTimers();
      inputTail.fill(0);
      inputTail = Buffer.alloc(0);
      signal?.removeEventListener("abort", externalAbort);
      closeProvider();
      controller.abort();
    };
    const fail = (code) => {
      if (terminalError || isClosed) return;
      terminalError = new Error(code);
      rejectFailure(terminalError);
      dispose();
      try { void Promise.resolve(onError(terminalError)).catch(() => {}); } catch { /* Error observers cannot reopen a failed connection. */ }
    };
    const externalAbort = () => fail("LIVE_TRANSLATE_ABORTED");
    signal?.addEventListener("abort", externalAbort, { once: true });
    const enqueueEvent = (callback, event) => {
      const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (pendingEvents >= this.maxPendingEvents || pendingEventBytes + bytes > 256_000) {
        fail("LIVE_TRANSLATE_EVENT_BACKPRESSURE");
        return;
      }
      pendingEvents += 1;
      pendingEventBytes += bytes;
      eventTail = eventTail.then(async () => {
        if (isClosed) return;
        const timer = setTimeout(() => fail("LIVE_TRANSLATE_CONSUMER_TIMEOUT"), this.shutdownTimeoutMilliseconds);
        timers.add(timer);
        try { await Promise.race([Promise.resolve().then(() => callback(event)), failure]); }
        finally { clearTimeout(timer); timers.delete(timer); }
      }).catch(() => fail("LIVE_TRANSLATE_CONSUMER_FAILED")).finally(() => {
        pendingEvents -= 1;
        pendingEventBytes -= bytes;
      });
    };
    const onMessage = (message) => {
      if (!acceptMessages || isClosed) return;
      try {
        if (!record(message)) throw new Error("LIVE_TRANSLATE_MESSAGE_INVALID");
        if (message.error !== undefined) { fail("LIVE_TRANSLATE_PROVIDER_FAILED"); return; }
        const content = message.serverContent;
        if (content !== undefined && !record(content)) throw new Error("LIVE_TRANSLATE_MESSAGE_INVALID");
        for (const [field, direction] of [["inputTranscription", "input"], ["outputTranscription", "output"]]) {
          if (content?.[field] === undefined) continue;
          const observation = transcript(content[field], targetLanguageCode, direction);
          const receivedAt = this.now();
          if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) throw new Error("LIVE_TRANSLATE_CLOCK_INVALID");
          enqueueEvent(onTranscript, { ...observation, targetLanguageCode, sequence: ++sequence, receivedAt });
          if (isClosed) return;
        }
        const boundary = {};
        for (const key of ["generationComplete", "turnComplete", "interrupted"]) {
          if (content?.[key] === undefined) continue;
          if (typeof content[key] !== "boolean") throw new Error("LIVE_TRANSLATE_MESSAGE_INVALID");
          boundary[key] = content[key];
        }
        if (message.goAway !== undefined) {
          if (!record(message.goAway)) throw new Error("LIVE_TRANSLATE_MESSAGE_INVALID");
          boundary.goAway = true;
        }
        if (Object.keys(boundary).length) enqueueEvent(onBoundary, { ...boundary, targetLanguageCode });
        const parts = content?.modelTurn?.parts ?? [];
        if (!Array.isArray(parts) || parts.length > 64) throw new Error("LIVE_TRANSLATE_AUDIO_INVALID");
        for (const part of parts) {
          if (!part?.inlineData) continue;
          const { data, mimeType } = part.inlineData;
          if (mimeType !== "audio/pcm;rate=24000" || typeof data !== "string"
            || data.length > Math.ceil(MAX_AUDIO_CHUNK_BYTES / 3) * 4
            || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) throw new Error("LIVE_TRANSLATE_AUDIO_INVALID");
          const bytes = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
          if (bytes % 2 !== 0 || bytes > MAX_AUDIO_CHUNK_BYTES) throw new Error("LIVE_TRANSLATE_AUDIO_INVALID");
          outputAudioBytes += bytes;
          if (outputAudioBytes / 48 > this.maxConnectionMilliseconds) throw new Error("LIVE_TRANSLATE_AUDIO_LIMIT");
        }
        if (message.usageMetadata !== undefined) {
          if (!record(message.usageMetadata)) throw new Error("LIVE_TRANSLATE_USAGE_INVALID");
          const parsedUsage = {};
          for (const key of USAGE_FIELDS) {
            if (message.usageMetadata[key] === undefined) continue;
            const value = message.usageMetadata[key];
            if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) throw new Error("LIVE_TRANSLATE_USAGE_INVALID");
            parsedUsage[key] = value;
          }
          providerUsage = Object.keys(parsedUsage).length ? parsedUsage : null;
          enqueueEvent(onUsage, usage());
        }
      } catch (error) {
        fail(error instanceof Error && /^LIVE_TRANSLATE_[A-Z_]+$/u.test(error.message) ? error.message : "LIVE_TRANSLATE_MESSAGE_INVALID");
      }
    };
    connectTimer = setTimeout(() => fail("LIVE_TRANSLATE_CONNECT_TIMEOUT"), this.connectTimeoutMilliseconds);
    try {
      const connection = Promise.resolve(this.client.live.connect({
        model: MODEL,
        config: {
          responseModalities: ["AUDIO"], inputAudioTranscription: {}, outputAudioTranscription: {},
          translationConfig: { targetLanguageCode, echoTargetLanguage: true }, abortSignal: controller.signal,
        },
        signal: controller.signal,
        callbacks: {
          onmessage: onMessage,
          onerror: () => fail("LIVE_TRANSLATE_PROVIDER_FAILED"),
          onclose: () => { if (!isClosing) fail("LIVE_TRANSLATE_PROVIDER_CLOSED"); },
        },
      })).then((value) => {
        provider = value;
        if (typeof provider?.sendRealtimeInput !== "function" || typeof provider?.close !== "function") throw new Error("LIVE_TRANSLATE_CLIENT_INVALID");
        if (isClosed) closeProvider();
        return value;
      });
      await Promise.race([connection, failure]);
      if (terminalError) throw terminalError;
    } catch {
      fail("LIVE_TRANSLATE_CONNECT_FAILED");
      throw terminalError;
    } finally { clearTimeout(connectTimer); }
    lifetimeTimer = setTimeout(() => fail("LIVE_TRANSLATE_CONNECTION_LIMIT"), this.maxConnectionMilliseconds);
    lifetimeTimer.unref?.();
    const assertActive = () => { if (terminalError) throw terminalError; if (isClosed) throw new Error("LIVE_TRANSLATE_CLOSED"); };
    const flushAudio = async (frame, pad = false) => {
      assertActive();
      const combined = inputTail.length ? Buffer.concat([inputTail, frame]) : frame;
      const size = pad ? Math.ceil(combined.length / CHUNK_BYTES) * CHUNK_BYTES : combined.length - combined.length % CHUNK_BYTES;
      inputTail = pad ? Buffer.alloc(0) : Buffer.from(combined.subarray(size));
      const payload = pad && size > combined.length ? Buffer.concat([combined, Buffer.alloc(size - combined.length)]) : combined;
      for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
        assertActive();
        if ((inputAudioBytes + CHUNK_BYTES) / 32 > this.maxConnectionMilliseconds) { fail("LIVE_TRANSLATE_AUDIO_LIMIT"); throw terminalError; }
        await Promise.race([Promise.resolve(provider.sendRealtimeInput({ audio: { data: payload.subarray(offset, offset + CHUNK_BYTES).toString("base64"), mimeType: "audio/pcm;rate=16000" } })), failure]);
        inputAudioBytes += CHUNK_BYTES;
      }
    };
    const enqueueWrite = (operation) => {
      if (terminalError) return Promise.reject(terminalError);
      if (isClosing || isClosed) return Promise.reject(new Error("LIVE_TRANSLATE_CLOSED"));
      if (pendingFrames >= this.maxPendingFrames) { fail("LIVE_TRANSLATE_AUDIO_BACKPRESSURE"); return Promise.reject(terminalError); }
      pendingFrames += 1;
      const work = writeTail.then(async () => {
        try { assertActive(); await operation(); assertActive(); }
        catch { fail("LIVE_TRANSLATE_WRITE_FAILED"); throw terminalError ?? new Error("LIVE_TRANSLATE_CLOSED"); }
      });
      writeTail = work.catch(() => {});
      return work.finally(() => { pendingFrames -= 1; });
    };
    const endInput = async () => {
      if (didEndInput) return;
      await flushAudio(Buffer.alloc(0), true);
      assertActive();
      didEndInput = true;
      await Promise.race([Promise.resolve(provider.sendRealtimeInput({ audioStreamEnd: true })), failure]);
    };
    return Object.freeze({
      exactSourceCorrespondence: false,
      transcriptTextSemantics: "unverified",
      targetLanguageCode,
      sendAudio(frame) {
        if (!(frame instanceof Uint8Array) || frame.byteLength !== 1_280) return Promise.reject(new Error("LIVE_TRANSLATE_AUDIO_REQUEST_INVALID"));
        const copy = Buffer.from(frame);
        return enqueueWrite(async () => { didEndInput = false; await flushAudio(copy); });
      },
      audioStreamEnd() { return enqueueWrite(endInput); },
      getUsage: usage,
      assertDrained() { if (terminalError) throw terminalError; },
      abort() { fail("LIVE_TRANSLATE_ABORTED"); },
      close: () => {
        if (closePromise) return closePromise;
        isClosing = true;
        closePromise = (async () => {
          let deadline;
          let transportClosed = false;
          try {
            await Promise.race([(async () => {
              if (!isClosed) {
                try {
                await writeTail;
                assertActive();
                await endInput();
                await Promise.race([new Promise((resolve) => { const timer = setTimeout(resolve, this.drainMilliseconds); timers.add(timer); }), failure]);
                acceptMessages = false;
                await eventTail;
                } catch { /* Preserve the existing terminal failure while awaiting physical closure. */ }
                finally { dispose(); }
              }
              await closeProvider();
              transportClosed = true;
            })(), new Promise((_, reject) => {
              deadline = setTimeout(() => reject(new Error("LIVE_TRANSLATE_DRAIN_TIMEOUT")), this.shutdownTimeoutMilliseconds);
            })]);
          } catch {
            fail("LIVE_TRANSLATE_DRAIN_TIMEOUT");
            terminalError ??= new Error("LIVE_TRANSLATE_DRAIN_TIMEOUT");
            rejectFailure(terminalError);
            dispose();
          } finally {
            clearTimeout(deadline);
          }
          return { transportClosed, protocolCompletionVerified: false, errorCode: terminalError?.message ?? null, ...usage() };
        })();
        return closePromise;
      },
    });
  }
}
