#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import open from "open";
import { migrateNovaConfig } from "./nova-config.js";
import { createSettingsStore } from "./settings-store.js";

export function parseNovaCliArgs(args, env = process.env) {
  const port = Number(env.PORT || "3317");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT: 1–65535 범위의 정수를 입력해주세요.");
  const options = { host: "127.0.0.1", port, openBrowser: true, help: false };
  for (const argument of args) {
    if (argument === "--no-open") options.openBrowser = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error("Unknown argument. nova --help 명령으로 사용법을 확인해주세요.");
  }
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseNovaCliArgs(args);
  if (options.help) {
    console.log(`NOVA — 실시간 번역 자막\n\n사용법: nova [--no-open] [--help]\n\n--no-open  브라우저 자동 열기 생략\n--help     도움말\n\n127.0.0.1에만 연결합니다. PORT 환경 변수 기본값: 3317\n설정: ~/.config/nova/settings.json`);
    return;
  }
  const paths = await migrateNovaConfig();
  const settingsStore = createSettingsStore({ filePath: paths.settingsPath });
  await settingsStore.load();
  const { startServer } = await import("./server.js");
  const { url } = await startServer({
    ...options,
    settingsStore,
    transcriptsDir: paths.transcriptsDir,
  });
  console.log(`NOVA 실행 중: ${url}`);
  if (options.openBrowser) await open(url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "NOVA를 시작하지 못했습니다.");
    process.exitCode = 1;
  });
}
