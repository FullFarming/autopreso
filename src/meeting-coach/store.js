import fs from "node:fs/promises";
import path from "node:path";

const STORE_FILE_MODE = 0o600;

/** @param {{directory?: string, fsImpl?: typeof fs}} [options] */
export function createMeetingCoachStore({ directory, fsImpl = fs } = {}) {
  if (!directory) throw new Error("Meeting Coach store directory is required.");
  const writeQueues = new Map();

  /** @param {string} name @param {unknown} document */
  async function writeJsonDocument(name, document) {
    const filePath = resolveStorePath(directory, name);
    const previous = writeQueues.get(filePath) ?? Promise.resolve();
    const next = previous.then(() => writeAtomicJson({ filePath, document, fsImpl }));
    writeQueues.set(filePath, next.catch(() => {}));
    return next;
  }

  /** @param {string} name */
  async function readJsonDocument(name) {
    const filePath = resolveStorePath(directory, name);
    try {
      return JSON.parse(await fsImpl.readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: false, code: "NOT_FOUND" };
      const quarantinePath = `${filePath}.quarantine-${Date.now()}`;
      await fsImpl.rename(filePath, quarantinePath);
      return { ok: false, code: "CORRUPT_JSON", quarantinePath };
    }
  }

  return { directory, writeJsonDocument, readJsonDocument };
}

/** @param {{filePath: string, document: unknown, fsImpl?: typeof fs}} options */
export async function writeAtomicJson({ filePath, document, fsImpl = fs }) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const backupPath = `${filePath}.bak`;
  await fsImpl.mkdir(directory, { recursive: true });
  const payload = `${JSON.stringify(document, null, 2)}\n`;
  const handle = await fsImpl.open(tempPath, "w", STORE_FILE_MODE);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsImpl.copyFile(filePath, backupPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fsImpl.rename(tempPath, filePath);
  const dirHandle = await fsImpl.open(directory, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
  return { filePath, backupPath };
}

/** @param {string} directory @param {unknown} name */
function resolveStorePath(directory, name) {
  const normalized = String(name ?? "").normalize("NFC").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!normalized || normalized.includes("..")) throw new Error("Invalid Meeting Coach store document name.");
  return path.join(directory, normalized.endsWith(".json") ? normalized : `${normalized}.json`);
}
