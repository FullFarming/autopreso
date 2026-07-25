import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const electronEntry = path.join(rootDir, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");

await stopExistingDesktop();

const child = spawn(path.join(rootDir, "node_modules", ".bin", "electron"), ["."], {
  cwd: rootDir,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.exitCode = 1;
  else process.exitCode = code ?? 0;
});

async function stopExistingDesktop() {
  if (process.platform === "win32") return;
  let output = "";
  try {
    output = execFileSync("pgrep", ["-f", `${electronEntry} ${rootDir}`], { encoding: "utf8" });
  } catch {
    return;
  }
  const pids = output
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }

  if (pids.length > 0) await new Promise((resolve) => setTimeout(resolve, 900));
}
