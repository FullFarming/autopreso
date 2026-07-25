// Which output languages does gpt-realtime-translate actually produce?
// Opens one translation socket per candidate code, streams the same Korean
// speech, and reports whether output transcripts arrive. Ground truth over docs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WebSocket } from "ws";

const candidates = (process.argv[2] ?? "en,ja,jpn,japanese,zh,es,fr,de").split(",");
const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "realtime-noel", "settings.json"), "utf8"));
const apiKey = settings.apiKeys.openai;

const aiff = "/tmp/probe-langs.aiff";
const wav = "/tmp/probe-langs.wav";
try {
  execFileSync("say", ["-v", "Yuna", "-o", aiff, "안녕하세요. 오늘 회의에 참석해 주셔서 감사합니다."]);
} catch {
  execFileSync("say", ["-v", "Flo (한국어(한국))", "-o", aiff, "안녕하세요. 오늘 회의에 참석해 주셔서 감사합니다."]);
}
execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", aiff, wav]);
const raw = fs.readFileSync(wav);
const pcm = raw.subarray(raw.indexOf(Buffer.from("data")) + 8);

function probeLanguage(language) {
  return new Promise((resolve) => {
    const ws = new WebSocket("wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate", undefined, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    let inputChars = 0;
    let outputChars = 0;
    let errorText = "";
    let sessionEcho = "";
    const finish = () => { try { ws.close(); } catch {} resolve({ language, inputChars, outputChars, errorText, sessionEcho }); };
    const timer = setTimeout(finish, 14_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            input: { transcription: { model: "gpt-realtime-whisper" }, noise_reduction: { type: "near_field" } },
            output: { language },
          },
        },
      }));
      let offset = 0;
      const interval = setInterval(() => {
        if (offset >= pcm.length) { clearInterval(interval); return; }
        ws.send(JSON.stringify({ type: "session.input_audio_buffer.append", audio: pcm.subarray(offset, offset + 4800).toString("base64") }));
        offset += 4800;
      }, 100);
    });
    ws.on("message", (rawMessage) => {
      let message;
      try { message = JSON.parse(rawMessage.toString("utf8")); } catch { return; }
      if (message.type === "session.updated") sessionEcho = JSON.stringify(message.session?.audio?.output ?? {});
      if (message.type === "session.input_transcript.delta") inputChars += (message.delta ?? "").length;
      if (message.type === "session.output_transcript.delta") outputChars += (message.delta ?? "").length;
      if (message.type === "error") { errorText = message.error?.message ?? "error"; clearTimeout(timer); finish(); }
    });
    ws.on("error", (error) => { errorText = error.message; clearTimeout(timer); finish(); });
    ws.on("close", () => { clearTimeout(timer); finish(); });
  });
}

for (const language of candidates) {
  const result = await probeLanguage(language);
  console.log(`[lang=${result.language}] input:${result.inputChars} output:${result.outputChars} ${result.errorText ? `ERROR: ${result.errorText}` : ""} echo:${result.sessionEcho}`);
}
process.exit(0);
