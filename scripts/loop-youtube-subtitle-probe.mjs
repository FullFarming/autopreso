// Loop test: play real YouTube audio segments through the live subtitle pipeline
// and verify the EXPECTED-language subtitle keeps being generated without stalling
// or echoing the source. Alternates two videos with a stop/start between each so
// it also exercises session teardown/rebuild.
//
// Prereqs: dev server on :3210 (npm run dev), and 24kHz mono PCM WAVs for each
// clip. Usage: node scripts/loop-youtube-subtitle-test.mjs
import fs from "node:fs";
import { WebSocket } from "ws";

const URL = "ws://localhost:3210/ws";
const CYCLES = Number(process.env.CYCLES || 2);
const STALL_MS = 5000;       // no expected-language subtitle this long while audio plays = stall
const PACE_MS = 130;         // wall time between frames (~realtime for 4096-sample frames)
const FRAME_BYTES = 8192;    // 4096 samples * 2 bytes

// clip = { name, wav, expect: target language that SHOULD be produced, audioLang }
const CLIPS = [
  { name: "VIDEO1(EN)", wav: "/tmp/v1en.wav", expect: "ko", audioLang: "en" },
  { name: "VIDEO2(KO)", wav: "/tmp/v2ko.wav", expect: "en", audioLang: "ko" },
];

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

function connect() {
  return new Promise((resolve) => { const ws = new WebSocket(URL); ws.on("open", () => resolve(ws)); });
}

async function playClip(ws, clip, t0) {
  const buf = pcm(clip.wav);
  const sessionId = `loop-${clip.name}-${Date.now()}`;
  const state = { lastExpectedAt: Date.now(), lastAudioAt: 0, expectedCount: 0, echoCount: 0,
    stalls: [], maxText: "", started: false };
  const onMsg = (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type !== "subtitle:partial" && m.type !== "subtitle:committed") return;
    const text = m.translatedText || "";
    const lang = detect(text);
    if (m.targetLanguage === clip.expect && lang === clip.expect && text.trim().length >= 2) {
      state.lastExpectedAt = Date.now();
      state.expectedCount += 1;
      if (text.length > state.maxText.length) state.maxText = text;
    }
    // echo = a subtitle in the SAME language as the audio being spoken (source verbatim)
    if (lang === clip.audioLang && m.targetLanguage === clip.audioLang) state.echoCount += 1;
  };
  ws.on("message", onMsg);
  ws.send(JSON.stringify({ type: "subtitle:start", sessionId, settings: { translationProvider: "gemini", inputMode: "mic", languagePair: { a: "en", b: "ko" } } }));
  await sleep(800); // wait for listening

  // stall watchdog
  let stalled = false;
  const watch = setInterval(() => {
    const now = Date.now();
    if (now - state.lastAudioAt < 600 && now - state.lastExpectedAt > STALL_MS) {
      const at = ((now - t0) / 1000).toFixed(1);
      state.stalls.push(at);
      if (!stalled) { console.log(`   ⚠️  STALL at ${at}s — no ${clip.expect.toUpperCase()} subtitle for >${STALL_MS / 1000}s while audio plays`); stalled = true; }
    } else { stalled = false; }
  }, 1000);

  for (let i = 0; i < buf.length; i += FRAME_BYTES) {
    state.lastAudioAt = Date.now();
    ws.send(JSON.stringify({ type: "subtitle:audio", sessionId, source: "mic", audio: buf.subarray(i, i + FRAME_BYTES).toString("base64") }));
    await sleep(PACE_MS);
  }
  await sleep(2500); // trailing flush
  clearInterval(watch);
  ws.send(JSON.stringify({ type: "subtitle:stop", sessionId }));
  ws.off("message", onMsg);
  await sleep(600); // let stop settle
  return state;
}

const t0 = Date.now();
const results = [];
for (let c = 1; c <= CYCLES; c += 1) {
  for (const clip of CLIPS) {
    console.log(`\n▶ cycle ${c}/${CYCLES} — ${clip.name}  (audio=${clip.audioLang} → expect ${clip.expect.toUpperCase()} subtitles)`);
    const ws = await connect();
    const st = await playClip(ws, clip, t0);
    ws.close();
    const ok = st.expectedCount > 0 && st.stalls.length === 0;
    console.log(`   ${ok ? "✅" : "❌"} ${clip.expect.toUpperCase()} subtitles=${st.expectedCount}, stalls=${st.stalls.length}, source-echoes=${st.echoCount}`);
    console.log(`      longest: ${JSON.stringify(st.maxText.slice(0, 70))}`);
    results.push({ cycle: c, clip: clip.name, expectedCount: st.expectedCount, stalls: st.stalls.length, echoes: st.echoCount, ok });
  }
}

console.log("\n========== LOOP TEST SUMMARY ==========");
let allOk = true;
for (const r of results) {
  if (!r.ok) allOk = false;
  console.log(`${r.ok ? "✅" : "❌"} c${r.cycle} ${r.clip.padEnd(11)} subs=${String(r.expectedCount).padStart(3)} stalls=${r.stalls} echoes=${r.echoes}`);
}
console.log(allOk ? "\n🎉 ALL SEGMENTS OK — continuous subtitles, no stalls" : "\n⚠️ SOME SEGMENTS had stalls/no-subtitle — see above");
process.exit(0);
