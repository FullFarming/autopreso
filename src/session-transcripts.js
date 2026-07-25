import fs from "node:fs/promises";
import path from "node:path";

// Per-session transcript recorder for local caption sessions. Unlike the
// rolling 200-line subtitle history (translation-only), this store keeps the
// ORIGINAL source text with per-line timestamps, bounded per session, one JSON
// file per session under storageDir, so an AI summary can be generated from
// what was actually said.

const MAX_LINES_PER_SESSION = 20_000;
const MAX_LINE_CHARS = 2_000;
const MAX_TITLE_CHARS = 120;
const MAX_PROMPT_CHARS = 120_000;

/** @param {any} options */
export function createSessionTranscripts({
  storageDir,
  now = () => new Date(),
  log = console,
  persistDelayMs = 1000,
} = {}) {
  if (!storageDir) throw new Error("session transcripts require a storageDir");
  /** @type {any} */
  let active = null;
  let persistTimer = null;

  function sessionPath(sessionId) {
    return path.join(storageDir, `${encodeURIComponent(sessionId)}.json`);
  }

  async function writeSessionFile(session) {
    await fs.mkdir(storageDir, { recursive: true });
    const payload = {
      id: session.id,
      title: session.title,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      lines: session.lines,
      summary: session.summary ?? null,
      audioSources: session.finalizedAudio ?? [...(session.audioSources ?? [])].sort(),
    };
    const target = sessionPath(session.id);
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify(payload), { mode: 0o600 });
    await fs.rename(temp, target);
  }

  function schedulePersist() {
    if (!active) return Promise.resolve();
    if (persistDelayMs <= 0) return persistActive();
    if (!persistTimer) {
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistActive().catch((error) => {
          log.warn?.(`[session-transcripts] persist failed: ${error?.message ?? error}`);
        });
      }, persistDelayMs);
    }
    return Promise.resolve();
  }

  async function persistActive() {
    if (!active) return;
    await writeSessionFile(active);
  }

  /** @param {{ sessionId?: string, title?: string }} [args] */
  async function begin({ sessionId, title = "" } = {}) {
    if (typeof sessionId !== "string" || !sessionId) return null;
    if (active && active.id === sessionId) return metaOf(active);
    if (active) await end();
    const startedAt = now();
    active = {
      id: sessionId,
      title: normalizeLineText(title).slice(0, MAX_TITLE_CHARS),
      startedAt: startedAt.toISOString(),
      startedMs: startedAt.getTime(),
      endedAt: "",
      lines: [],
      summary: null,
      audioSources: new Set(),
      audioTail: Promise.resolve(),
    };
    await schedulePersist();
    return metaOf(active);
  }

  async function recordLine(message = {}) {
    if (!active) return null;
    const sourceText = normalizeLineText(message.sourceText);
    const translatedText = normalizeLineText(message.translatedText);
    if (!sourceText && !translatedText) return null;
    if (active.lines.length >= MAX_LINES_PER_SESSION) return null;
    const at = now();
    active.lines.push({
      at: at.toISOString(),
      elapsedMs: Math.max(0, at.getTime() - active.startedMs),
      speaker: normalizeLineText(message.speaker).slice(0, 80),
      sourceText,
      translatedText,
      sourceLanguage: normalizeLineText(message.sourceLanguage).slice(0, 16),
      targetLanguage: normalizeLineText(message.targetLanguage).slice(0, 16),
      source: message.source === "system" ? "system" : message.source === "mirror" ? "mirror" : "mic",
    });
    await schedulePersist();
    return active.lines[active.lines.length - 1];
  }

  // ── Session audio: raw PCM16 (24 kHz mono) appended per source while the
  // session runs, finalized into a playable WAV at end(). ───────────────────

  async function appendAudioChunk(source, base64Audio) {
    if (!active) return;
    const normalizedSource = source === "system" ? "system" : "mic";
    if (typeof base64Audio !== "string" || !base64Audio) return;
    let bytes;
    try {
      bytes = Buffer.from(base64Audio, "base64");
    } catch {
      return;
    }
    if (!bytes.length) return;
    active.audioSources.add(normalizedSource);
    const target = rawAudioPath(active.id, normalizedSource);
    // Serialized through a tail promise so bursts never interleave writes.
    active.audioTail = active.audioTail
      .then(async () => {
        await fs.mkdir(storageDir, { recursive: true });
        await fs.appendFile(target, bytes, { mode: 0o600 });
      })
      .catch((error) => {
        log.warn?.(`[session-transcripts] audio append failed: ${error?.message ?? error}`);
      });
    await active.audioTail;
  }

  function rawAudioPath(sessionId, source) {
    return path.join(storageDir, `${encodeURIComponent(sessionId)}.${source}.pcm`);
  }

  function wavAudioPath(sessionId, source) {
    return path.join(storageDir, `${encodeURIComponent(sessionId)}.${source}.wav`);
  }

  async function finalizeAudio(session) {
    const finalized = [];
    for (const source of [...session.audioSources ?? []].sort()) {
      try {
        const pcm = await fs.readFile(rawAudioPath(session.id, source));
        if (pcm.length > 0) {
          await fs.writeFile(wavAudioPath(session.id, source), buildWavFile(pcm, AUDIO_SAMPLE_RATE), { mode: 0o600 });
          finalized.push(source);
        }
        await fs.rm(rawAudioPath(session.id, source), { force: true });
      } catch (error) {
        log.warn?.(`[session-transcripts] audio finalize failed (${source}): ${error?.message ?? error}`);
      }
    }
    return finalized;
  }

  async function getAudioFile(sessionId, source) {
    if (typeof sessionId !== "string" || !sessionId) return null;
    if (source !== "mic" && source !== "system") return null;
    const target = wavAudioPath(sessionId, source);
    try {
      await fs.access(target);
      return target;
    } catch {
      return null;
    }
  }

  /** Archive a transcript recorded elsewhere (e.g. a Live Call meeting record
   *  fetched from the workspace) so it appears alongside local sessions.
   *  @param {{ id?: string, title?: string, startedAt?: string, endedAt?: string, lines?: any[], summary?: any }} [payload] */
  async function importSession({ id, title = "", startedAt = "", endedAt = "", lines = [], summary = null } = {}) {
    if (typeof id !== "string" || !id) return null;
    const startedMs = Date.parse(startedAt) || 0;
    const session = {
      id,
      title: normalizeLineText(title).slice(0, MAX_TITLE_CHARS),
      startedAt: typeof startedAt === "string" ? startedAt : "",
      startedMs,
      endedAt: typeof endedAt === "string" ? endedAt : "",
      lines: (Array.isArray(lines) ? lines : []).slice(0, MAX_LINES_PER_SESSION)
        .map((line) => {
          const sourceText = normalizeLineText(line?.sourceText);
          const translatedText = normalizeLineText(line?.translatedText);
          if (!sourceText && !translatedText) return null;
          const atMs = Date.parse(line?.at) || startedMs;
          return {
            at: typeof line?.at === "string" ? line.at : "",
            elapsedMs: Math.max(0, atMs - startedMs),
            speaker: normalizeLineText(line?.speaker).slice(0, 80),
            sourceText,
            translatedText,
            sourceLanguage: normalizeLineText(line?.sourceLanguage).slice(0, 16),
            targetLanguage: normalizeLineText(line?.targetLanguage).slice(0, 16),
            source: "live",
          };
        })
        .filter(Boolean),
      summary: summary && typeof summary === "object" ? summary : null,
      audioSources: new Set(),
    };
    await writeSessionFile(session);
    return metaOf(session);
  }

  async function end() {
    if (!active) return null;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    active.endedAt = now().toISOString();
    await active.audioTail;
    active.finalizedAudio = await finalizeAudio(active);
    const meta = metaOf(active);
    await persistActive();
    active = null;
    return meta;
  }

  async function list() {
    let entries;
    try {
      entries = await fs.readdir(storageDir);
    } catch {
      return [];
    }
    const sessions = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
      const session = await readSessionFile(path.join(storageDir, entry));
      if (session) sessions.push(metaOf(session));
    }
    sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return sessions;
  }

  async function get(sessionId) {
    if (active && active.id === sessionId) {
      return { meta: metaOf(active), lines: [...active.lines], summary: active.summary ?? null };
    }
    const session = await readSessionFile(sessionPath(sessionId));
    if (!session) return null;
    return { meta: metaOf(session), lines: session.lines, summary: session.summary ?? null };
  }

  /**
   * @param {string} sessionId
   * @param {(request: { system: string, prompt: string }) => Promise<{ text: string }>} generateSummaryText
   */
  async function summarize(sessionId, generateSummaryText) {
    if (typeof generateSummaryText !== "function") {
      throw new Error("요약을 생성할 AI 제공자가 설정되지 않았습니다.");
    }
    const isActive = Boolean(active && active.id === sessionId);
    const session = isActive ? active : await readSessionFile(sessionPath(sessionId));
    if (!session) throw new Error("세션 기록을 찾을 수 없습니다.");
    if (!session.lines.length) throw new Error("이 세션에는 기록된 원문이 없습니다.");
    const prompt = buildTranscriptSummaryPrompt({ title: session.title, lines: session.lines });
    const result = await generateSummaryText({ system: TRANSCRIPT_SUMMARY_SYSTEM, prompt });
    const summary = parseSummaryText(result?.text ?? "");
    session.summary = { ...summary, createdAt: now().toISOString() };
    await writeSessionFile(session);
    return session.summary;
  }

  return { begin, recordLine, end, list, get, summarize, importSession, appendAudioChunk, getAudioFile };
}

const AUDIO_SAMPLE_RATE = 24_000;

function buildWavFile(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function metaOf(session) {
  return {
    id: session.id,
    title: session.title ?? "",
    startedAt: session.startedAt ?? "",
    endedAt: session.endedAt ?? "",
    lineCount: session.lines?.length ?? 0,
    hasSummary: Boolean(session.summary),
    audioSources: session.finalizedAudio
      ?? (Array.isArray(session.audioSources) ? session.audioSources : [...(session.audioSources ?? [])].sort()),
  };
}

async function readSessionFile(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string" || !parsed.id) return null;
    return {
      id: parsed.id,
      title: typeof parsed.title === "string" ? parsed.title : "",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      startedMs: Date.parse(parsed.startedAt) || 0,
      endedAt: typeof parsed.endedAt === "string" ? parsed.endedAt : "",
      lines: Array.isArray(parsed.lines) ? parsed.lines : [],
      summary: parsed.summary && typeof parsed.summary === "object" ? parsed.summary : null,
      audioSources: Array.isArray(parsed.audioSources)
        ? parsed.audioSources.filter((source) => source === "mic" || source === "system")
        : [],
    };
  } catch {
    return null;
  }
}

function normalizeLineText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_LINE_CHARS);
}

const TRANSCRIPT_SUMMARY_SYSTEM = [
  "You summarize a spoken session transcript for the speaker's records.",
  "Answer in the transcript's dominant language (Korean transcripts get Korean summaries).",
  'Return JSON ONLY with this shape: {"title": string, "overview": string,',
  '"chapters": [{"heading": string, "summary": string}],',
  '"decisions": [string], "actionItems": [{"description": string, "owner": string}]}.',
  "Base every statement on the transcript; never invent content.",
].join(" ");

/** @param {{ title?: string, lines: any[] }} args */
export function buildTranscriptSummaryPrompt({ title = "", lines }) {
  const header = title ? `세션 제목: ${title}\n` : "";
  const formatted = [];
  let used = header.length;
  for (const line of lines) {
    const stamp = formatElapsed(line.elapsedMs);
    const speakerPrefix = line.speaker ? `${line.speaker}: ` : "";
    const text = line.sourceText || line.translatedText || "";
    const rendered = line.sourceText && line.translatedText
      ? `[${stamp}] ${speakerPrefix}${line.sourceText} → ${line.translatedText}`
      : `[${stamp}] ${speakerPrefix}${text}`;
    if (used + rendered.length + 1 > MAX_PROMPT_CHARS) {
      formatted.push("[…transcript truncated…]");
      break;
    }
    formatted.push(rendered);
    used += rendered.length + 1;
  }
  return `${header}시간순 발화 기록:\n${formatted.join("\n")}`;
}

function formatElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/** @param {string} text */
export function parseSummaryText(text) {
  const raw = String(text ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("요약 응답을 해석하지 못했습니다.");
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error("요약 응답을 해석하지 못했습니다.");
  }
  return {
    title: typeof parsed.title === "string" ? parsed.title : "",
    overview: typeof parsed.overview === "string" ? parsed.overview : "",
    chapters: Array.isArray(parsed.chapters)
      ? parsed.chapters
        .filter((chapter) => chapter && typeof chapter === "object")
        .map((chapter) => ({
          heading: typeof chapter.heading === "string" ? chapter.heading : "",
          summary: typeof chapter.summary === "string" ? chapter.summary : "",
        }))
      : [],
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions.filter((item) => typeof item === "string") : [],
    actionItems: Array.isArray(parsed.actionItems)
      ? parsed.actionItems
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          description: typeof item.description === "string" ? item.description : "",
          owner: typeof item.owner === "string" ? item.owner : "",
        }))
      : [],
  };
}
