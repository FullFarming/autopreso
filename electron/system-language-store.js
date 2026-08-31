import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeSystemLanguage } from "../public/system-language.js";

export function readDesktopSystemLanguage(directory) {
  const file = path.join(directory, "system-language.json");
  try {
    if (fs.statSync(file).size > 512) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizeSystemLanguage(value?.systemLanguage);
  } catch { return null; }
}

export function persistDesktopSystemLanguage(directory, language) {
  const normalized = normalizeSystemLanguage(language);
  if (!normalized) throw new Error("INVALID_SYSTEM_LANGUAGE");
  const file = path.join(directory, "system-language.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify({ systemLanguage: normalized }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    return normalized;
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* An unsuccessful write may not create a temporary file. */ }
    throw new Error("SYSTEM_LANGUAGE_SAVE_FAILED");
  }
}
