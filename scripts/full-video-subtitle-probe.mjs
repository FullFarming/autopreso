// Full-length single-video test: stream the ENTIRE English video audio through the
// live subtitle pipeline and record a timeline of every subtitle + debug event so
// we can locate the "English-only / KO↔EN flip" bugs the user sees mid-video.
//
// Prereqs: dev server on :3210 started with SUBTITLE_DEBUG=1, and /tmp/v1en_full.wav
// (24kHz mono PCM). Usage: node scripts/full-video-subtitle-test.mjs
import fs from "node:fs";
import { WebSocket } from "ws";

const URL = "ws://localhost:3210/ws";
const WAV = process.env.WAV || "/tmp/v1en_full.wav";
const EXPECT = process.env.EXPECT || "ko";       // English audio => expect Korean subtitles
const AUDIO_LANG = process.env.AUDIO_LANG || "en";
const PACE_MS = Number(process.env.PACE_MS || 130);
const FRAME_BYTES = 8192;
const STALL_MS = 6000;
const EVENTS_PATH = "/tmp/full-test-events.jsonl";

function pcm(wav) {
  const b = fs.readFileSync(wav);
  let o = 12, s = -1, l = 0;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4); const sz = b.readUInt32LE(o + 4);
    if (id === "data") { s = o + 8; l = sz; break; }
    o += 8 + sz + (sz % 2);
  }
  return b.subarray(s, s + l);
}
const detect = (t) => {
  const ko = (t.match(/[가-힣]/g) || []).length, en = (t.match(/[A-Za-z]/g) || []).length;
  if (ko > 0 && ko >= en) return "ko"; if (en > 0) return "en"; return "?";
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const buf = pcm(WAV);
const totalSec = (buf.length / 2 / 24000);
console.log(`▶ FULL test: ${WAV}  audio=${AUDIO_LANG} expect=${EXPECT.toUpperCase()}  len=${totalSec.toFixed(0)}s  pace=${PACE_MS}ms`);

const ws = new WebSocket(URL);
await new Promise((r) => ws.on("open", r));
const sessionId = `full-${Date.now()}`;
const t0 = Date.now();
const out = fs.createWriteStream(EVENTS_PATH);
const el = () => ((Date.now() - t0) / 1000).toFixed(1);

const state = {
  lastExpectedAt: Date.now(), lastAudioAt: 0,
  expectedCount: 0, echoCount: 0, koPassthroughEn: 0, enTargetOut: 0,
  issues: [],            // { t, kind, detail }
  lastDebugInput: {},    // per channel last input text
};

function note(kind, detail) {
  const t = el();
  state.issues.push({ t, kind, detail });
  console.log(`  ⚠️ [${t}s] ${kind}: ${detail}`);
}

ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === "subtitle:debug") {
    if (m.kind === "input") state.lastDebugInput[m.channel] = m.text;
    out.write(JSON.stringify({ t: el(), ...m }) + "\n");
    return;
  }
  if (m.type !== "subtitle:partial" && m.type !== "subtitle:committed") return;
  const text = (m.translatedText || "").trim();
  if (!text) return;
  const lang = detect(text);
  out.write(JSON.stringify({ t: el(), type: m.type, target: m.targetLanguage, src: m.sourceLanguage, lang, text }) + "\n");

  if (m.targetLanguage === EXPECT && lang === EXPECT && text.length >= 2) {
    state.lastExpectedAt = Date.now();
    state.expectedCount += 1;
  }
  // BUG A: a subtitle in the AUDIO language shown as its own target lane = English-only echo
  if (lang === AUDIO_LANG && m.targetLanguage === AUDIO_LANG) { state.echoCount += 1; if (state.echoCount % 8 === 1) note("EN-ECHO", text.slice(0, 50)); }
  // BUG B: the EXPECT(ko) lane emitting source-language(en) text = "원문 그대로" passthrough
  if (m.targetLanguage === EXPECT && lang === AUDIO_LANG) { state.koPassthroughEn += 1; if (state.koPassthroughEn % 8 === 1) note("KO-LANE-EN-TEXT", text.slice(0, 50)); }
  // BUG C: any output on the audio-language target lane (the flip) — count distinct bursts
  if (m.targetLanguage === AUDIO_LANG && m.type === "subtitle:committed") state.enTargetOut += 1;
});

ws.send(JSON.stringify({ type: "subtitle:start", sessionId, settings: { translationProvider: "gemini", inputMode: "mic", languagePair: { a: "en", b: "ko" } } }));
await sleep(900);

let stalled = false;
const watch = setInterval(() => {
  const now = Date.now();
  if (now - state.lastAudioAt < 700 && now - state.lastExpectedAt > STALL_MS) {
    if (!stalled) { note("KO-STALL", `no Korean subtitle for >${STALL_MS / 1000}s (last EN input: ${(state.lastDebugInput[EXPECT] || "").slice(-40)})`); stalled = true; }
  } else if (now - state.lastExpectedAt < 2000) { stalled = false; }
}, 1000);

let lastLog = 0;
for (let i = 0; i < buf.length; i += FRAME_BYTES) {
  state.lastAudioAt = Date.now();
  ws.send(JSON.stringify({ type: "subtitle:audio", sessionId, source: "mic", audio: buf.subarray(i, i + FRAME_BYTES).toString("base64") }));
  const sec = Math.floor((i / 2 / 24000));
  if (sec - lastLog >= 30) { lastLog = sec; console.log(`  … ${sec}s/${totalSec.toFixed(0)}s  koSubs=${state.expectedCount} enEcho=${state.echoCount} koLaneEn=${state.koPassthroughEn} enTarget=${state.enTargetOut} issues=${state.issues.length}`); }
  await sleep(PACE_MS);
}
await sleep(3000);
clearInterval(watch);
ws.send(JSON.stringify({ type: "subtitle:stop", sessionId }));
await sleep(700);
out.end();

console.log("\n========== FULL VIDEO SUMMARY ==========");
console.log(`KO subtitles emitted : ${state.expectedCount}`);
console.log(`EN-echo bursts       : ${state.echoCount}  (English shown on EN lane)`);
console.log(`KO-lane-EN passthrough: ${state.koPassthroughEn}  (Korean lane showed English)`);
console.log(`EN-target commits    : ${state.enTargetOut}  (flip: output on English lane)`);
console.log(`Total issue events   : ${state.issues.length}`);
const byKind = {};
for (const it of state.issues) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
console.log("By kind:", JSON.stringify(byKind));
if (state.issues.length) {
  console.log("\nFirst issue windows:");
  for (const it of state.issues.slice(0, 25)) console.log(`  [${it.t}s] ${it.kind}: ${it.detail}`);
}
const clean = state.echoCount === 0 && state.koPassthroughEn === 0 && state.issues.filter((i) => i.kind === "KO-STALL").length === 0;
console.log(clean ? "\n🎉 CLEAN END-TO-END — continuous Korean, no English-only / flip" : "\n⚠️ BUGS FOUND — see windows above; events at " + EVENTS_PATH);
ws.close();
process.exit(0);
