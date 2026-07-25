import { execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { WebSocket } from "ws";
const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "realtime-noel", "settings.json"), "utf8"));
const raw = fs.readFileSync("/tmp/probe-pipeline.wav");
const pcm = raw.subarray(raw.indexOf(Buffer.from("data")) + 8);
async function run(label, sessionPatch) {
  return new Promise((resolve) => {
    const ws = new WebSocket("wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate", undefined, { headers: { Authorization: `Bearer ${settings.apiKeys.openai}` } });
    const t0 = Date.now(); let firstOut = null; let audioDone = null; let err = "";
    const finish = () => { try { ws.close(); } catch {} resolve(); };
    setTimeout(() => { console.log(`[${label}] first-ja-delta: ${firstOut ? firstOut - audioDone + "ms after audio end" : "NONE"} ${err}`); finish(); }, 25000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.update", session: { ...(sessionPatch.top ?? {}), audio: { input: { transcription: { model: "gpt-realtime-whisper" }, noise_reduction: { type: "near_field" } }, output: { language: "ja" } } } }));
      let off = 0;
      const iv = setInterval(() => {
        if (off >= pcm.length) { clearInterval(iv); audioDone = Date.now(); return; }
        ws.send(JSON.stringify({ type: "session.input_audio_buffer.append", audio: pcm.subarray(off, off + 4800).toString("base64") })); off += 4800;
      }, 100);
    });
    ws.on("message", (m) => {
      let msg; try { msg = JSON.parse(m.toString()); } catch { return; }
      if (msg.type === "session.output_transcript.delta" && !firstOut) firstOut = Date.now();
      if (msg.type === "error") err = "ERR: " + (msg.error?.message ?? "");
    });
  });
}
await run("top-vad", { top: { turn_detection: { type: "server_vad", silence_duration_ms: 250 } } });
process.exit(0);
