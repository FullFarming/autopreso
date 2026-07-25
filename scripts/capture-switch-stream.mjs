// Capture the EXACT subtitle message stream the frontend receives during a
// language switch: stream Korean audio (KO→EN) then, in the SAME session,
// English audio (EN→KO), simulating a speaker switching mid-talk. Records every
// subtitle:partial/committed/debug message with a timestamp to a JSONL file so we
// can both diagnose the server stream and replay it into the overlay.
import fs from "node:fs";
import { WebSocket } from "ws";

const PORT = process.env.PORT || 3211;
const URL = `ws://localhost:${PORT}/ws`;
const PACE_MS = 170;            // ~realtime
const FRAME_BYTES = 8192;
const KO_SECS = Number(process.env.KO_SECS || 28);  // seconds of Korean audio
const EN_SECS = Number(process.env.EN_SECS || 22);  // then seconds of English audio
const OUT = "/tmp/switch-events.jsonl";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const koPcm = pcm("/tmp/v2ko.wav").subarray(0, KO_SECS * 24000 * 2);
const enPcm = pcm("/tmp/v1en.wav").subarray(0, EN_SECS * 24000 * 2);

const ws = new WebSocket(URL);
await new Promise((r) => ws.on("open", r));
const sessionId = `switch-${Date.now()}`;
const out = fs.createWriteStream(OUT);
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(2);

ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (["subtitle:partial", "subtitle:committed", "subtitle:debug"].includes(m.type)) {
    out.write(JSON.stringify({ t: el(), ...m }) + "\n");
  }
});

ws.send(JSON.stringify({ type: "subtitle:start", sessionId, settings: { translationProvider: "gemini", inputMode: "mic", languagePair: { a: "en", b: "ko" } } }));
await sleep(900);

async function stream(buf, label) {
  console.log(`[${el()}s] streaming ${label} (${(buf.length / 2 / 24000).toFixed(0)}s)`);
  out.write(JSON.stringify({ t: el(), marker: `START_${label}` }) + "\n");
  for (let i = 0; i < buf.length; i += FRAME_BYTES) {
    ws.send(JSON.stringify({ type: "subtitle:audio", sessionId, source: "mic", audio: buf.subarray(i, i + FRAME_BYTES).toString("base64") }));
    await sleep(PACE_MS);
  }
}
await stream(koPcm, "KOREAN");          // KO→EN
out.write(JSON.stringify({ t: el(), marker: "SWITCH_TO_ENGLISH" }) + "\n");
console.log(`[${el()}s] ==== SWITCH: now streaming ENGLISH ====`);
await stream(enPcm, "ENGLISH");         // EN→KO
await sleep(3500);
ws.send(JSON.stringify({ type: "subtitle:stop", sessionId }));
await sleep(600);
out.end();
console.log(`[${el()}s] done — events at ${OUT}`);
ws.close();
process.exit(0);
