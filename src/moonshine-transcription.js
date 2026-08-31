import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 24000;
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_PACKAGE_SCOPE = `@${["auto", "preso"].join("")}`;
const LEGACY_BINARY_NAME = `${["auto", "preso"].join("")}-moonshine`;
const SIDECAR_PACKAGES_BY_PLATFORM = new Map([
  ["darwin:arm64", [
    { packageName: "@realtime-noel/moonshine-darwin-arm64", binaryName: "realtime-noel-moonshine" },
    { packageName: `${LEGACY_PACKAGE_SCOPE}/moonshine-darwin-arm64`, binaryName: LEGACY_BINARY_NAME },
  ]],
  ["darwin:x64", [
    { packageName: "@realtime-noel/moonshine-darwin-x64", binaryName: "realtime-noel-moonshine" },
    { packageName: `${LEGACY_PACKAGE_SCOPE}/moonshine-darwin-x64`, binaryName: LEGACY_BINARY_NAME },
  ]],
]);

export function moonshinePlatformPackageName(platform = process.platform, arch = process.arch) {
  const packages = SIDECAR_PACKAGES_BY_PLATFORM.get(`${platform}:${arch}`);
  if (!packages) {
    throw new Error("Moonshine local transcription is currently available for macOS arm64 and x64.");
  }
  return packages[0].packageName;
}

export function resolveMoonshineSidecarPath({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  requireResolve = require.resolve,
  localPackageRoot = path.join(SOURCE_DIR, "..", "packages"),
  fileExists = existsSync,
} = {}) {
  if (env.REALTIME_NOEL_MOONSHINE_BIN) return env.REALTIME_NOEL_MOONSHINE_BIN;

  const packages = SIDECAR_PACKAGES_BY_PLATFORM.get(`${platform}:${arch}`);
  if (!packages) {
    moonshinePlatformPackageName(platform, arch);
  }
  for (const candidate of packages) {
    try {
      const packageJsonPath = requireResolve(`${candidate.packageName}/package.json`);
      return path.join(path.dirname(packageJsonPath), "bin", candidate.binaryName);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  const localBinary = resolveLocalSidecarBinary(localPackageRoot, packages[0], fileExists);
  if (localBinary) return localBinary;
  throw new Error(`Cannot find Moonshine sidecar package for ${platform}/${arch}.`);
}

function resolveLocalSidecarBinary(localPackageRoot, candidate, fileExists) {
  if (!localPackageRoot) return null;
  const packageDir = candidate.packageName.split("/").pop();
  const binaryPath = path.join(localPackageRoot, packageDir, "bin", candidate.binaryName);
  const unpackedBinaryPath = binaryPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  if (fileExists(unpackedBinaryPath)) return unpackedBinaryPath;
  if (fileExists(binaryPath)) return binaryPath;
  return null;
}

export function createMoonshineTranscription({
  sendTranscript,
  queueTranscript,
  options,
  spawnProcess = spawn,
  resolveSidecarPath = () => resolveMoonshineSidecarPath(),
}) {
  let child = null;
  let stdoutBuffer = "";
  let readyPromise = null;
  let resolveReady = null;
  let rejectReady = null;

  function ensureChild() {
    if (child) return child;

    const binary = resolveSidecarPath();
    readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    child = spawnProcess(binary, ["--model", options.moonshineModel, "--language", "en"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        handleSidecarLine(line, { sendTranscript, queueTranscript, onReady: resolveReady });
      }
    });

    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) sendTranscript({ type: "error", message });
    });

    child.on("error", (error) => {
      sendTranscript({ type: "error", message: error.message });
      rejectReady?.(error);
    });

    child.on("close", (code) => {
      rejectReady?.(new Error(`Moonshine sidecar exited before it was ready${code === null ? "" : ` (code ${code})`}.`));
      child = null;
      readyPromise = null;
      resolveReady = null;
      rejectReady = null;
    });

    return child;
  }

  return {
    ready: async () => {
      ensureChild();
      await readyPromise;
    },
    sendAudio: (audio) => {
      if (!audio) return;
      let process;
      try {
        process = ensureChild();
      } catch (error) {
        sendTranscript({ type: "error", message: error.message });
        return;
      }
      process.stdin.write(`${JSON.stringify({ type: "audio", encoding: "pcm16le", sampleRate: SAMPLE_RATE, audio })}\n`);
    },
    stop: () => {
      if (!child) return;
      child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
    },
    close: () => {
      if (!child) return;
      child.stdin.end();
      child.kill();
      child = null;
    },
  };
}

function handleSidecarLine(line, { sendTranscript, queueTranscript, onReady }) {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendTranscript({ type: "error", message: `Invalid Moonshine sidecar message: ${line}` });
    return;
  }

  if (message.type === "ready") {
    onReady?.();
    return;
  }

  if (message.type === "transcript:partial") {
    sendTranscript({ type: "transcript:partial", text: message.text ?? "" });
  }

  if (message.type === "transcript:committed") {
    const text = message.text ?? "";
    sendTranscript({ type: "transcript:committed", text });
    queueTranscript(text);
  }

  if (message.type === "error") {
    sendTranscript({ type: "error", message: message.message ?? "Moonshine transcription error" });
  }
}
