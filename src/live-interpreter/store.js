import fs from "node:fs/promises";
import path from "node:path";

import { sanitizeCommittedTranscriptRecord } from "./domain.js";

const STORE_FILE_MODE = 0o600;
const STORE_FILE_NAME = "transcripts.json";

/** @param {{directory?: string, maxRecords?: number, fsImpl?: typeof fs, nowMilliseconds?: () => number}} options */
export function createLiveInterpreterStore({
  directory,
  maxRecords = 2_000,
  fsImpl = fs,
  nowMilliseconds = () => Date.now(),
} = {}) {
  if (!directory) throw new Error("Live Interpreter store directory is required.");
  const filePath = path.join(directory, STORE_FILE_NAME);
  const retainedRecords = Math.max(1, Math.min(10_000, Number(maxRecords) || 2_000));
  let writeQueue = Promise.resolve();

  async function readRecords() {
    try {
      const parsed = JSON.parse(await fsImpl.readFile(filePath, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Invalid transcript store.");
      return parsed.map((item) => sanitizeCommittedTranscriptRecord(item)).slice(-retainedRecords);
    } catch (error) {
      if (isFileSystemError(error) && error.code === "ENOENT") return [];
      const quarantinePath = `${filePath}.quarantine-${nowMilliseconds()}`;
      await fsImpl.rename(filePath, quarantinePath);
      return [];
    }
  }

  /** @param {unknown} record */
  async function appendRecord(record) {
    const sanitized = sanitizeCommittedTranscriptRecord(record);
    const operation = writeQueue.then(async () => {
      const current = await readRecords();
      const next = [...current, sanitized].slice(-retainedRecords);
      await writeAtomicJson({ filePath, value: next, fsImpl });
      return sanitized;
    });
    writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  return Object.freeze({ directory, readRecords, appendRecord });
}

/** @param {{filePath: string, value: unknown, fsImpl?: typeof fs}} options */
export async function writeAtomicJson({ filePath, value, fsImpl = fs }) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fsImpl.mkdir(directory, { recursive: true });
  const handle = await fsImpl.open(tempPath, "w", STORE_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsImpl.rename(tempPath, filePath);
  const directoryHandle = await fsImpl.open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

/** @param {unknown} error @returns {error is NodeJS.ErrnoException} */
function isFileSystemError(error) {
  return error instanceof Error && "code" in error;
}
