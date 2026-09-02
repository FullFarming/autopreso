#!/usr/bin/env node
// scripts/engine-spike.mjs
// Real-API comparison of caption STT providers on ONE 16 kHz mono WAV.
// Keys: SONIOX_API_KEY from ~/.config/realtime-noel/soniox.env (or env),
//       Gemini from ~/.config/realtime-noel/settings.json apiKeys.gemini (or GEMINI_API_KEY).
// Never prints keys. Writes scratch/engine-spike-<ts>.json.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { SONIOX_CONTROL, SONIOX_ENDPOINTS, buildSonioxConfig, createSonioxFinalizeScheduler, createSonioxTokenReducer, hasSonioxContentTokens } from "../packages/caption-core/soniox-protocol.js";
import { buildGeminiTranscribeSetupMessage, handleGeminiTranscribeMessage } from "../src/gemini-live-transcribe.js";

const GEMINI_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const FRAME_BYTES = 3_200; // 100 ms @ 16 kHz mono PCM16

export function parseSpikeArgs(argv) {
  const args = { wav: null, providers: ["soniox", "gemini"], modes: ["auto", "ko", "en"], endpoint: "us", realtime: true, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--wav") args.wav = next();
    else if (flag === "--providers") args.providers = next().split(",").filter(Boolean);
    else if (flag === "--modes") args.modes = next().split(",").filter(Boolean);
    else if (flag === "--endpoint") args.endpoint = next();
    else if (flag === "--out") args.out = next();
    else if (flag === "--no-realtime") args.realtime = false;
    else throw new Error(`Unknown flag ${flag}`);
  }
  if (!args.wav) throw new Error("--wav <16kHz mono PCM16 wav> is required");
  if (!["us", "jp"].includes(args.endpoint)) throw new Error("--endpoint must be us or jp");
  return args;
}

export function readWav16kMono(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file");
  let offset = 12; let format = null; let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4); const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") format = { audioFormat: buffer.readUInt16LE(offset + 8), channels: buffer.readUInt16LE(offset + 10), sampleRate: buffer.readUInt32LE(offset + 12), bits: buffer.readUInt16LE(offset + 22) };
    if (id === "data") data = buffer.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error("WAV missing fmt/data");
  if (format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bits !== 16) {
    throw new Error(`Need PCM16 mono 16000 Hz, got format=${format.audioFormat} ch=${format.channels} rate=${format.sampleRate} bits=${format.bits}. Convert: ffmpeg -i in.wav -ac 1 -ar 16000 -sample_fmt s16 out.wav`);
  }
  return data;
}

const percentile = (values, p) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1)); return sorted[index]; };
export function summarizeMetrics(m) {
  const stats = (values) => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null });
  return { firstPartialMs: stats(m.firstPartialMs ?? []), finalLagMs: stats(m.finalLagMs ?? []), firstTranslationMs: stats(m.firstTranslationMs ?? []), finals: m.finals ?? 0, otherScriptFinals: m.otherScriptFinals ?? 0, errors: m.errors ?? [] };
}

const isOtherScript = (text) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Thai}\p{Script=Arabic}]/u.test(text) || /[àảãáạăằẳẵắặâầẩẫấậđèẻẽéẹêềểễếệìỉĩíịòỏõóọôồổỗốộơờởỡớợùủũúụưừửữứựỳỷỹýỵ]/iu.test(text);

/**
 * Reads one `NAME=value` line out of a dotenv-style file. Editors and shells
 * leave shapes a raw regex kept verbatim - a trailing CR from a CRLF file,
 * wrapping single/double quotes, whitespace around the `=` - and every one of
 * them makes the provider answer "unauthenticated", which reads as an outage.
 * Returns "" when the name is absent. Never logs the value.
 *
 * @param {unknown} text
 * @param {string} name
 * @returns {string}
 */
export function parseEnvValue(text, name) {
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf("=");
    if (separator === -1 || trimmed.slice(0, separator).trim() !== name) continue;
    const value = trimmed.slice(separator + 1).trim();
    const quote = value.slice(0, 1);
    return (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote))
      ? value.slice(1, -1).trim()
      : value;
  }
  return "";
}

async function readKeys() {
  const home = os.homedir();
  let soniox = process.env.SONIOX_API_KEY ?? "";
  try { const env = await fs.readFile(path.join(home, ".config/realtime-noel/soniox.env"), "utf8"); soniox ||= parseEnvValue(env, "SONIOX_API_KEY"); } catch {}
  let gemini = process.env.GEMINI_API_KEY ?? "";
  try { const settings = JSON.parse(await fs.readFile(path.join(home, ".config/realtime-noel/settings.json"), "utf8")); gemini ||= settings.apiKeys?.gemini ?? ""; } catch {}
  return { soniox, gemini };
}

function streamPcm(ws, pcm, { realtime, binary, wrap = null }) {
  return new Promise((resolve) => {
    let offset = 0; const startedAt = Date.now();
    const tick = () => {
      if (ws.readyState !== WebSocket.OPEN) return resolve();
      const frame = pcm.subarray(offset, offset + FRAME_BYTES); offset += FRAME_BYTES;
      if (frame.length) ws.send(binary ? frame : wrap(frame), binary ? { binary: true } : undefined);
      if (offset >= pcm.length) return resolve();
      if (!realtime) return setImmediate(tick);
      const due = startedAt + (offset / FRAME_BYTES) * 100;
      setTimeout(tick, Math.max(0, due - Date.now()));
    };
    tick();
  });
}

async function runSoniox({ key, pcm, mode, endpoint, realtime }) {
  const metrics = { firstPartialMs: [], finalLagMs: [], firstTranslationMs: [], finals: 0, otherScriptFinals: 0, errors: [], transcript: [], translations: [] };
  const ws = new WebSocket(SONIOX_ENDPOINTS[endpoint]);
  const t0 = Date.now(); let audioStartedAt = 0; let segmentFirstPartialAt = null; let segmentFirstTranslationAt = null; let audioEndAt = null;
  // Same contract as the desktop transport: continuous speech never yields <end>,
  // so ask for <fin> after 1.2 s without new tokens (or a 15 s segment).
  let finalizesSent = 0;
  const scheduler = createSonioxFinalizeScheduler({ onFinalize() { if (ws.readyState !== WebSocket.OPEN) return; ws.send(SONIOX_CONTROL.finalize); finalizesSent += 1; } });
  const reducer = createSonioxTokenReducer({
    onSourcePartial() { if (segmentFirstPartialAt === null) segmentFirstPartialAt = Date.now(); },
    onSourceFinal(e) { metrics.finals += 1; if (isOtherScript(e.text)) metrics.otherScriptFinals += 1; metrics.transcript.push({ text: e.text, language: e.language, endMs: e.endMs }); if (segmentFirstPartialAt !== null && e.startMs !== null) metrics.firstPartialMs.push(segmentFirstPartialAt - (audioStartedAt + e.startMs)); if (e.endMs !== null) metrics.finalLagMs.push(Date.now() - (audioStartedAt + e.endMs)); },
    onTranslationPartial(e) { if (segmentFirstTranslationAt === null) segmentFirstTranslationAt = Date.now(); },
    onTranslationFinal(e) { metrics.translations.push({ text: e.text, language: e.language, sourceLanguage: e.sourceLanguage }); if (segmentFirstPartialAt !== null && segmentFirstTranslationAt !== null) metrics.firstTranslationMs.push(segmentFirstTranslationAt - segmentFirstPartialAt); },
    onBoundary() { scheduler.noteBoundary(); segmentFirstPartialAt = null; segmentFirstTranslationAt = null; },
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify(buildSonioxConfig({ apiKey: key, languageMode: mode, languages: ["en", "ko"], translation: true, clientReferenceId: `spike-${mode}` })));
  const finished = new Promise((resolve) => {
    ws.on("message", (raw) => { const msg = JSON.parse(raw.toString("utf8")); if (msg.error_type) { metrics.errors.push({ type: msg.error_type, requestId: msg.request_id ?? null }); return; } reducer.apply(msg); if (hasSonioxContentTokens(msg) && reducer.hasPendingFinalText()) scheduler.noteTokens({ hasPendingFinalText: true, atMs: Date.now() }); if (msg.finished) resolve(); });
    ws.on("close", resolve);
  });
  audioStartedAt = Date.now();
  await streamPcm(ws, pcm, { realtime, binary: true });
  audioEndAt = Date.now();
  ws.send(""); // end of audio: an EMPTY TEXT frame - the empty binary frame never finished (8 s timeout)
  await Promise.race([finished, new Promise((r) => setTimeout(r, 8_000))]);
  scheduler.dispose();
  ws.close();
  return { provider: "soniox", mode, endpoint, connectMs: audioStartedAt - t0, audioMs: Math.round(pcm.length / 32), drainMs: Date.now() - audioEndAt, finalizesSent, ...summarizeMetrics(metrics), transcript: metrics.transcript, translations: metrics.translations };
}

async function runGemini({ key, pcm, realtime }) {
  const metrics = { firstPartialMs: [], finalLagMs: [], finals: 0, otherScriptFinals: 0, errors: [], transcript: [] };
  const ws = new WebSocket(`${GEMINI_URL}?key=${encodeURIComponent(key)}`);
  const t0 = Date.now(); let audioStartedAt = 0; let sawPartialSinceFinal = null;
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(buildGeminiTranscribeSetupMessage({}));
  await new Promise((resolve) => { const onMsg = (raw) => { if (JSON.parse(raw.toString("utf8")).setupComplete !== undefined) { ws.off("message", onMsg); resolve(); } }; ws.on("message", onMsg); });
  ws.on("message", (raw) => handleGeminiTranscribeMessage(raw, {
    onInterim() { if (sawPartialSinceFinal === null) sawPartialSinceFinal = Date.now() - audioStartedAt; },
    onFinal(e) { metrics.finals += 1; if (isOtherScript(e.text)) metrics.otherScriptFinals += 1; metrics.transcript.push({ text: e.text, language: e.languageCode ?? null, atMs: Date.now() - audioStartedAt }); if (sawPartialSinceFinal !== null) metrics.firstPartialMs.push(sawPartialSinceFinal); sawPartialSinceFinal = null; },
    onServerGoAway() { metrics.errors.push({ type: "goAway" }); },
    broadcast(event) { if (event?.type === "subtitle:error") metrics.errors.push({ type: event.code }); },
  }));
  audioStartedAt = Date.now();
  await streamPcm(ws, pcm, { realtime, binary: false, wrap: (frame) => JSON.stringify({ realtimeInput: { audio: { data: frame.toString("base64"), mimeType: "audio/pcm;rate=16000" } } }) });
  ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  await new Promise((r) => setTimeout(r, 4_000));
  ws.close();
  return { provider: "gemini", mode: "auto", endpoint: null, connectMs: audioStartedAt - t0, audioMs: Math.round(pcm.length / 32), ...summarizeMetrics(metrics), transcript: metrics.transcript };
}

async function main() {
  const args = parseSpikeArgs(process.argv.slice(2));
  const keys = await readKeys();
  const pcm = readWav16kMono(await fs.readFile(args.wav));
  const results = [];
  for (const provider of args.providers) {
    if (provider === "soniox") {
      if (!keys.soniox) throw new Error("SONIOX_API_KEY missing (env or ~/.config/realtime-noel/soniox.env)");
      for (const mode of args.modes) results.push(await runSoniox({ key: keys.soniox, pcm, mode, endpoint: args.endpoint, realtime: args.realtime }));
    } else if (provider === "gemini") {
      if (!keys.gemini) throw new Error("Gemini API key missing (settings.json apiKeys.gemini or GEMINI_API_KEY)");
      results.push(await runGemini({ key: keys.gemini, pcm, realtime: args.realtime }));
    }
  }
  const out = args.out ?? path.join(process.cwd(), "scratch", `engine-spike-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify({ wav: path.basename(args.wav), results }, null, 2));
  for (const r of results) {
    console.log(`${r.provider}/${r.mode}${r.endpoint ? `@${r.endpoint}` : ""}: connect ${r.connectMs}ms, finals ${r.finals}, other-script finals ${r.otherScriptFinals}, first partial p50 ${r.firstPartialMs.p50}ms, final lag p50 ${r.finalLagMs.p50}ms${r.firstTranslationMs ? `, first translation p50 ${r.firstTranslationMs.p50}ms` : ""}${"finalizesSent" in r ? `, finalizes sent ${r.finalizesSent}` : ""}, errors ${r.errors.length}`);
  }
  console.log(`written ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
