import { execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { WebSocket } from "ws";
const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "realtime-noel", "settings.json"), "utf8"));
try { execFileSync("say", ["-v", "Yuna", "-o", "/tmp/g.aiff", "안녕하세요. 오늘 회의에 참석해 주셔서 감사합니다. 임대 조건에 대해 논의하겠습니다."]); } catch { execFileSync("say", ["-v", "Flo (한국어(한국))", "-o", "/tmp/g.aiff", "안녕하세요. 오늘 회의에 참석해 주셔서 감사합니다."]); }
execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", "/tmp/g.aiff", "/tmp/g.wav"]);
const raw = fs.readFileSync("/tmp/g.wav"); const pcm = raw.subarray(raw.indexOf(Buffer.from("data")) + 8);
const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(settings.apiKeys.gemini)}`);
let audioDone = null, firstOut = null, outText = "";
ws.on("open", () => ws.send(JSON.stringify({ setup: { model: "models/gemini-3.5-live-translate-preview", generationConfig: { responseModalities: ["AUDIO"], translationConfig: { targetLanguageCode: "ja", echoTargetLanguage: false } }, inputAudioTranscription: {}, outputAudioTranscription: {} } })));
ws.on("message", (m) => {
  let msg; try { msg = JSON.parse(m.toString("utf8")); } catch { return; }
  if (msg.setupComplete !== undefined) {
    let off = 0;
    const iv = setInterval(() => {
      if (off >= pcm.length) { clearInterval(iv); audioDone = Date.now(); setTimeout(() => { console.log(`[gemini ko->ja] first-delta: ${firstOut ? (firstOut - audioDone) + "ms vs audio-end" : "NONE"} | output: ${outText.slice(0, 60)}`); process.exit(0); }, 15000); return; }
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcm.subarray(off, off + 3200).toString("base64"), mimeType: "audio/pcm;rate=16000" } } })); off += 3200;
    }, 100);
  }
  const out = msg.serverContent?.outputTranscription?.text;
  if (out) { if (!firstOut) firstOut = Date.now(); outText += out; }
});
ws.on("close", (code, reason) => console.log(`[gemini] closed ${code}: ${reason?.toString?.() ?? ""}`));
setTimeout(() => { console.log("[gemini] timeout"); process.exit(1); }, 50000);
