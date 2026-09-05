// Full-pipeline diagnostic: drives the REAL createSubtitleRealtimeManager
// (real routing/suppression/commit logic) against the REAL OpenAI realtime
// translation API, feeding locally synthesized speech. Reveals exactly where a
// language pair fails: session rejection, missing transcripts, or suppression.
//
// Usage: node scripts/probe-subtitle-pipeline.js --pair=ko/ja --speak=ko
//        node scripts/probe-subtitle-pipeline.js --pair=ko/en --speak=ko
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSubtitleRealtimeManager } from "../src/subtitle-realtime.js";

const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=")[1];
const pair = arg("pair", "ko/ja");
const speak = arg("speak", "ko");
const [a, b] = pair.split("/");

const SPEECH = {
  ko: { voice: "Yuna", fallbackVoice: "Flo (한국어(한국))", text: "안녕하세요. 오늘 회의에 참석해 주셔서 감사합니다. 임대 조건에 대해 논의하겠습니다." },
  ja: { voice: "Kyoko", fallbackVoice: "Flo (일본어(일본))", text: "こんにちは。本日は会議にご参加いただきありがとうございます。賃貸条件について説明いたします。" },
  en: { voice: "Samantha", fallbackVoice: "Flo", text: "Hello everyone, thank you for joining the meeting today. Let me walk you through the lease terms." },
};

function synthesizePcm24k({ voice, fallbackVoice, text }) {
  const aiff = "/tmp/probe-pipeline.aiff";
  const wav = "/tmp/probe-pipeline.wav";
  try {
    execFileSync("say", ["-v", voice, "-o", aiff, text]);
  } catch {
    execFileSync("say", ["-v", fallbackVoice, "-o", aiff, text]);
  }
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", aiff, wav]);
  const buffer = fs.readFileSync(wav);
  return buffer.subarray(buffer.indexOf(Buffer.from("data")) + 8);
}

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "nova", "settings.json"), "utf8"));
console.log(`[probe] pair=${pair} speak=${speak} (engine: openai)`);

const events = [];
const manager = createSubtitleRealtimeManager({
  broadcast: (message) => {
    events.push(message);
    const summary = { ...message };
    if (summary.type === "subtitle:partial") summary.translatedText = (summary.translatedText ?? "").slice(0, 60);
    console.log(`[probe] <- ${JSON.stringify(summary).slice(0, 220)}`);
  },
  settingsStore: {
    load: async () => ({
      apiKeys: settings.apiKeys,
      subtitle: { inputMode: "mic", languagePair: { a, b }, tone: "natural", glossary: "", translationDomain: "" },
    }),
  },
  // tone natural + no glossary → no polish call; raw pipeline behavior only.
  polish: async ({ translatedText }) => translatedText,
});

const pcm = synthesizePcm24k(SPEECH[speak]);
console.log(`[probe] synthesized ${speak} speech: ${(pcm.length / 48000).toFixed(1)}s`);

await manager.start({ sessionId: "probe" });
const chunkBytes = 4800; // 100ms of 24kHz PCM16
let offset = 0;
const interval = setInterval(() => {
  if (offset >= pcm.length) {
    clearInterval(interval);
    console.log("[probe] audio sent; waiting 30s for transcripts/commits");
    setTimeout(async () => {
      await manager.stop();
      const partials = events.filter((e) => e.type === "subtitle:partial").length;
      const commits = events.filter((e) => e.type === "subtitle:committed");
      const errors = events.filter((e) => e.type === "subtitle:error");
      console.log(`[probe] RESULT pair=${pair} speak=${speak}: partials=${partials} commits=${commits.length} errors=${errors.length}`);
      for (const commit of commits) console.log(`[probe]   committed [${commit.targetLanguage}] ${commit.translatedText}`);
      for (const error of errors) console.log(`[probe]   error: ${error.message}`);
      process.exit(0);
    }, 30_000);
    return;
  }
  manager.sendAudio({ sessionId: "probe", source: "mic", audio: pcm.subarray(offset, offset + chunkBytes).toString("base64") });
  offset += chunkBytes;
}, 100);

setTimeout(() => { console.log("[probe] global timeout"); process.exit(1); }, 60_000);
