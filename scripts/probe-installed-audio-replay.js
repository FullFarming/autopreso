import assert from "node:assert/strict";

import WebSocket from "ws";

const DEBUG_TARGETS_URL = "http://127.0.0.1:9223/json/list";
const PROBE_STREAM_ID = "codex-installed-audio-replay-probe";

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      const waiter = this.waiters.get(message.method)?.shift();
      waiter?.(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
      const wrapped = (params) => {
        clearTimeout(timeout);
        resolve(params);
      };
      const waiters = this.waiters.get(method) ?? [];
      waiters.push(wrapped);
      this.waiters.set(method, waiters);
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression, options = {}) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    includeCommandLineAPI: true,
    ...options,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}

async function main() {
  const targetsResponse = await fetch(DEBUG_TARGETS_URL);
  if (!targetsResponse.ok) throw new Error(`DevTools target discovery failed: HTTP ${targetsResponse.status}`);
  const targets = await targetsResponse.json();
  const target = targets.find((candidate) => String(candidate.url ?? "").includes("/subtitle.html"));
  if (!target?.webSocketDebuggerUrl) throw new Error("Installed subtitle.html renderer target was not found on port 9223.");

  const client = new CdpClient(target.webSocketDebuggerUrl);
  let isInstrumented = false;
  await client.open();
  try {
    await Promise.all([client.send("Runtime.enable"), client.send("Debugger.enable")]);
    const prototype = await client.send("Runtime.evaluate", { expression: "WebSocket.prototype" });
    if (!prototype.result?.objectId) throw new Error("WebSocket prototype was not available in the renderer.");
    const queried = await client.send("Runtime.queryObjects", { prototypeObjectId: prototype.result.objectId });
    const properties = await client.send("Runtime.getProperties", { objectId: queried.objects.objectId, ownProperties: true });
    let listener = null;
    for (const property of properties.result ?? []) {
      if (!/^\d+$/u.test(property.name) || !property.value?.objectId) continue;
      await client.send("Runtime.callFunctionOn", {
        objectId: property.value.objectId,
        functionDeclaration: "function () { globalThis.__codexProbeCandidate = this; }",
      });
      const candidateListener = await client.send("Runtime.evaluate", {
        expression: "(getEventListeners(globalThis.__codexProbeCandidate).message ?? [])[0]?.listener",
        includeCommandLineAPI: true,
      });
      if (!candidateListener.result?.objectId) continue;
      await client.send("Runtime.evaluate", { expression: "globalThis.__codexProbeSocket = globalThis.__codexProbeCandidate" });
      listener = candidateListener;
      break;
    }
    await client.send("Runtime.evaluate", { expression: "delete globalThis.__codexProbeCandidate" });
    if (!listener?.result?.objectId) {
      throw new Error("Dashboard WebSocket message listener was not found.");
    }

    const { breakpointId } = await client.send("Debugger.setBreakpointOnFunctionCall", { objectId: listener.result.objectId });
    const pausedPromise = client.waitFor("Debugger.paused");
    const setupDispatch = client.send("Runtime.evaluate", {
      expression: `globalThis.__codexProbeSocket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "__codex_probe_setup" }) }))`,
    });
    const paused = await pausedPromise;
    const dashboardFrame = paused.callFrames.find((frame) => String(frame.url ?? "").includes("subtitle-dashboard.js")) ?? paused.callFrames[0];
    if (!dashboardFrame?.callFrameId) throw new Error("Dashboard listener call frame was not available.");

    const setup = await client.send("Debugger.evaluateOnCallFrame", {
      callFrameId: dashboardFrame.callFrameId,
      expression: `(() => {
        if (state.running) throw new Error("PROBE_REQUIRES_IDLE_RENDERER");
        const original = {
          running: state.running,
          sessionId: state.sessionId,
          settings: { ...state.settings },
          playerVolume: subtitleAudioPlayer.volume,
          sourceStart: AudioBufferSourceNode.prototype.start,
        };
        globalThis.__codexProbeStartCount = 0;
        AudioBufferSourceNode.prototype.start = function (...args) {
          globalThis.__codexProbeStartCount += 1;
          return original.sourceStart.apply(this, args);
        };
        translatedAudioGuard.reset();
        state.running = true;
        state.sessionId = "codex-installed-probe";
        state.settings = { ...state.settings, outputMode: "audio", audioLanguage: "ko", audioVolume: 0 };
        globalThis.__codexProbeRestore = async () => {
          AudioBufferSourceNode.prototype.start = original.sourceStart;
          subtitleAudioPlayer.clear();
          translatedAudioGuard.reset();
          state.running = original.running;
          state.sessionId = original.sessionId;
          state.settings = original.settings;
          subtitleAudioPlayer.setVolume(original.playerVolume);
          await subtitleAudioPlayer.close();
          delete globalThis.__codexProbeSocket;
          delete globalThis.__codexProbeStartCount;
          delete globalThis.__codexProbeRestore;
        };
        void subtitleAudioPlayer.resume(0);
        return { outputMode: state.settings.outputMode, audioLanguage: state.settings.audioLanguage };
      })()`,
      returnByValue: true,
    });
    if (setup.exceptionDetails) throw new Error(setup.exceptionDetails.exception?.description ?? setup.exceptionDetails.text);
    isInstrumented = true;
    await client.send("Debugger.removeBreakpoint", { breakpointId });
    await client.send("Debugger.resume");
    await setupDispatch;
    await new Promise((resolve) => setTimeout(resolve, 250));

    const firstPcm = Buffer.alloc(4, 0).toString("base64");
    const secondPcm = Buffer.from([1, 0, 0, 0]).toString("base64");
    const result = await evaluate(client, `(() => {
      const socket = globalThis.__codexProbeSocket;
      const dispatch = (seq, audio) => socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "subtitle:translated-audio",
          streamId: ${JSON.stringify(PROBE_STREAM_ID)},
          seq,
          source: "mic",
          targetLanguage: "ko",
          sampleRate: 24000,
          mimeType: "audio/pcm;rate=24000",
          audio,
        }),
      }));
      for (let index = 0; index < 100; index += 1) dispatch(1, ${JSON.stringify(firstPcm)});
      const afterSameSequence = globalThis.__codexProbeStartCount;
      for (let seq = 2; seq <= 101; seq += 1) dispatch(seq, ${JSON.stringify(firstPcm)});
      const afterIncreasingSequence = globalThis.__codexProbeStartCount;
      dispatch(102, ${JSON.stringify(secondPcm)});
      return {
        afterSameSequence,
        afterIncreasingSequence,
        afterDifferentPcm: globalThis.__codexProbeStartCount,
      };
    })()`);

    assert.deepEqual(result, {
      afterSameSequence: 1,
      afterIncreasingSequence: 1,
      afterDifferentPcm: 2,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, target: target.url, ...result })}\n`);
  } finally {
    if (isInstrumented) {
      await evaluate(client, "globalThis.__codexProbeRestore?.()").catch(() => undefined);
    }
    client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
