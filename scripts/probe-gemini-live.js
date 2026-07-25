// Diagnostic probe: connect to the real Gemini Live translate endpoint and log
// every server message verbatim, to determine the correct BidiGenerateContentSetup
// shape for gemini-3.5-live-translate-preview.
//
// Usage:
//   node scripts/probe-gemini-live.js --shape=current   # transcriptions inside generationConfig (adapter today)
//   node scripts/probe-gemini-live.js --shape=fixed     # transcriptions + translationConfig at setup level
//
// Reads the Gemini API key from ~/.config/realtime-noel/settings.json. Speech
// audio is synthesized locally with macOS `say` so transcription events fire.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WebSocket } from "ws";

const URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";
const MODEL = "models/gemini-3.5-live-translate-preview";

const shape = (process.argv.find((a) => a.startsWith("--shape=")) ?? "--shape=current").split("=")[1];

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "realtime-noel", "settings.json"), "utf8"));
const apiKey = settings.apiKeys?.gemini ?? "";
if (!apiKey) {
  console.error("No gemini key in settings.json");
  process.exit(1);
}

function synthesizeSpeechPcm16k(text) {
  const aiff = "/tmp/probe-gemini.aiff";
  const wav = "/tmp/probe-gemini.wav";
  execFileSync("say", ["-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const buffer = fs.readFileSync(wav);
  const dataIndex = buffer.indexOf(Buffer.from("data"));
  return buffer.subarray(dataIndex + 8);
}

const SETUP_SHAPES = {
  // transcriptions at setup level, translationConfig inside generationConfig
  v3: {
    setup: {
      model: MODEL,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: { targetLanguageCode: "ko", echoTargetLanguage: false },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  },
  // transcriptions at setup level, no translationConfig at all (does the model
  // translate by default? what does the server accept?)
  v4: {
    setup: {
      model: MODEL,
      generationConfig: { responseModalities: ["AUDIO"] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  },
};

const setupMessage = SETUP_SHAPES[shape] ?? (shape === "fixed"
  ? {
      setup: {
        model: MODEL,
        generationConfig: { responseModalities: ["AUDIO"] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: { targetLanguageCode: "ko", echoTargetLanguage: false },
      },
    }
  : {
      setup: {
        model: MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          translationConfig: { targetLanguageCode: "ko", echoTargetLanguage: false },
        },
      },
    });

console.log(`[probe] shape=${shape}`);
console.log(`[probe] setup: ${JSON.stringify(setupMessage)}`);

const pcm = synthesizeSpeechPcm16k("Hello everyone, thank you for joining the meeting today.");
console.log(`[probe] synthesized speech: ${pcm.length} bytes (${(pcm.length / 32000).toFixed(1)}s)`);

const ws = new WebSocket(`${URL}?key=${encodeURIComponent(apiKey)}`);
let sentAudio = false;

function summarize(parsed) {
  const clone = JSON.parse(JSON.stringify(parsed));
  const parts = clone?.serverContent?.modelTurn?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part?.inlineData?.data) part.inlineData.data = `<${part.inlineData.data.length} b64 chars>`;
    }
  }
  return JSON.stringify(clone);
}

ws.on("open", () => {
  console.log("[probe] socket open, sending setup");
  ws.send(JSON.stringify(setupMessage));
});

ws.on("message", (raw) => {
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    console.log(`[probe] <- (non-JSON ${raw.toString("utf8").length} chars)`);
    return;
  }
  console.log(`[probe] <- ${summarize(parsed)}`);

  if (parsed.setupComplete !== undefined && !sentAudio) {
    sentAudio = true;
    console.log("[probe] setupComplete received, streaming audio in 100ms chunks");
    const chunkBytes = 3200; // 100ms of 16kHz PCM16 mono
    let offset = 0;
    const interval = setInterval(() => {
      if (offset >= pcm.length) {
        clearInterval(interval);
        console.log("[probe] audio finished; listening 8s for transcripts");
        setTimeout(() => { console.log("[probe] done"); ws.close(); process.exit(0); }, 8000);
        return;
      }
      const chunk = pcm.subarray(offset, offset + chunkBytes);
      offset += chunkBytes;
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: chunk.toString("base64"), mimeType: "audio/pcm;rate=16000" } } }));
    }, 100);
  }
});

ws.on("error", (error) => console.log(`[probe] socket error: ${error.message}`));
ws.on("close", (code, reason) => {
  console.log(`[probe] socket closed: code=${code} reason=${reason?.toString?.("utf8") ?? ""}`);
  process.exit(0);
});

setTimeout(() => { console.log("[probe] global timeout"); process.exit(1); }, 40000);
