import { GEMINI_WORKLOAD_MODEL_MATRIX, redactGeminiSensitiveText } from "../caption-core/index.js";

export const GENERATE_WORKLOADS = new Set(["topic", "translation", "polish", "recap"]);
export const GEMINI_SERVER_WORKLOAD_MODELS = GEMINI_WORKLOAD_MODEL_MATRIX;
export const GEMINI_WORKLOAD_THINKING_LEVELS = Object.freeze({
  glossaryExtraction: "medium",
  topic: "low",
  translation: "low",
  polish: "low",
  recap: "medium",
});
export const WORKLOAD_OUTPUT_CODEPOINTS = Object.freeze({ topic: 2_000, translation: 4_000, polish: 4_000, recap: 16_000 });
const MAX_PROMPT_CODEPOINTS = 50_000;
const MAX_SYSTEM_INSTRUCTION_CODEPOINTS = 10_000;
const MAX_SCHEMA_CODEPOINTS = 20_000;
const MAX_SCHEMA_DEPTH = 8;
const SAFE_GENERATION_ERROR_CODES = new Set([
  "GEMINI_GLOSSARY_OUTPUT_INVALID",
  "GEMINI_OUTPUT_INVALID", "GEMINI_OUTPUT_SCHEMA_INVALID", "GEMINI_OUTPUT_TOO_LARGE", "GEMINI_OUTPUT_UNSAFE",
  "GEMINI_PROVIDER_REFUSAL", "GEMINI_PROVIDER_RATE_LIMITED", "GEMINI_RECAP_VALIDATION_FAILED", "GEMINI_USAGE_INVALID",
]);

export function validateSessionId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[<>\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error("INVALID_GEMINI_SESSION_ID");
  }
  return value;
}

export function sanitizeContents(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("INVALID_GEMINI_CONTENTS");
  let codepoints = 0;
  let rawCodepoints = 0;
  const contents = value.map((content) => {
    if (!isPlainObject(content) || !["user", "model"].includes(content.role)
      || !Array.isArray(content.parts) || content.parts.length < 1 || content.parts.length > 8) throw new Error("INVALID_GEMINI_CONTENTS");
    const parts = content.parts.map((part) => {
      if (!isPlainObject(part) || Object.keys(part).length !== 1 || typeof part.text !== "string") throw new Error("INVALID_GEMINI_CONTENTS");
      rawCodepoints += Array.from(part.text).length;
      if (rawCodepoints > MAX_PROMPT_CODEPOINTS) throw new Error("INVALID_GEMINI_CONTENTS");
      const text = redactGeminiSensitiveText(part.text).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
      codepoints += Array.from(text).length;
      return { text };
    });
    return { role: content.role, parts };
  });
  if (codepoints < 1 || codepoints > MAX_PROMPT_CODEPOINTS || rawCodepoints > MAX_PROMPT_CODEPOINTS) throw new Error("INVALID_GEMINI_CONTENTS");
  return contents;
}

export function sanitizeGenerationConfig(value = {}) {
  if (!isPlainObject(value)) throw new Error("INVALID_GEMINI_GENERATION_CONFIG");
  const allowedKeys = new Set(["maxOutputTokens", "responseJsonSchema", "responseMimeType", "systemInstruction"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error("INVALID_GEMINI_GENERATION_CONFIG");
  const config = {};
  if (value.systemInstruction !== undefined) {
    if (typeof value.systemInstruction !== "string" || Array.from(value.systemInstruction).length < 1
      || Array.from(value.systemInstruction).length > MAX_SYSTEM_INSTRUCTION_CODEPOINTS) throw new Error("INVALID_GEMINI_GENERATION_CONFIG");
    config.systemInstruction = redactGeminiSensitiveText(value.systemInstruction).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
    if (!config.systemInstruction) throw new Error("INVALID_GEMINI_GENERATION_CONFIG");
  }
  if (value.maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 1 || value.maxOutputTokens > 8_192) throw new Error("INVALID_GEMINI_GENERATION_CONFIG");
    config.maxOutputTokens = value.maxOutputTokens;
  }
  if (value.responseMimeType !== undefined) {
    if (value.responseMimeType !== "application/json") throw new Error("INVALID_GEMINI_GENERATION_CONFIG");
    config.responseMimeType = value.responseMimeType;
  }
  if (value.responseJsonSchema !== undefined) {
    if (!isBoundedJsonSchema(value.responseJsonSchema)) throw new Error("INVALID_GEMINI_GENERATION_CONFIG");
    config.responseJsonSchema = structuredClone(value.responseJsonSchema);
  }
  return config;
}

function isBoundedJsonSchema(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { return false; }
  if (Array.from(serialized).length > MAX_SCHEMA_CODEPOINTS) return false;
  const visit = (node, depth) => {
    if (depth > MAX_SCHEMA_DEPTH) return false;
    if (Array.isArray(node)) return node.length <= 100 && node.every((child) => visit(child, depth + 1));
    if (!isPlainObject(node)) return node === null || ["string", "number", "boolean"].includes(typeof node);
    return Object.keys(node).length <= 100 && Object.values(node).every((child) => visit(child, depth + 1));
  };
  return visit(value, 0);
}

export function readStrictOutputText(response, maximumCodepoints) {
  if (hasRefusal(response)) throw new Error("GEMINI_PROVIDER_REFUSAL");
  const raw = response?.text ?? response?.candidates?.[0]?.content?.parts?.map((part) => part?.text ?? "").join("");
  if (typeof raw !== "string") throw new Error("GEMINI_OUTPUT_INVALID");
  const outputText = raw.trim();
  if (!outputText || outputText !== outputText.normalize("NFC") || /[<>\p{Cc}\p{Cf}]/u.test(outputText)
    || Array.from(outputText).length > maximumCodepoints) throw new Error("GEMINI_OUTPUT_UNSAFE");
  return outputText;
}

function hasRefusal(response) {
  if (typeof response?.promptFeedback?.blockReason === "string" && response.promptFeedback.blockReason) return true;
  const blockedReasons = new Set(["BLOCKLIST", "PROHIBITED_CONTENT", "RECITATION", "SAFETY", "SPII"]);
  return Array.isArray(response?.candidates) && response.candidates.some((candidate) => blockedReasons.has(candidate?.finishReason));
}

export function parseUsage(value) {
  if (value === undefined) return { inputTokens: 0, outputTokens: 0, totalTokens: 0, usageKnown: false };
  if (!isPlainObject(value)) throw new Error("GEMINI_USAGE_INVALID");
  const usage = { inputTokens: value.promptTokenCount ?? 0, outputTokens: value.candidatesTokenCount ?? 0, totalTokens: value.totalTokenCount ?? 0 };
  if (Object.values(usage).some((tokenCount) => !Number.isSafeInteger(tokenCount) || tokenCount < 0)) throw new Error("GEMINI_USAGE_INVALID");
  // 2026-08-31 fix: compatibility zeros do not prove that a request was free.
  const usageKnown = ["promptTokenCount", "candidatesTokenCount", "totalTokenCount"]
    .every((key) => Object.hasOwn(value, key) && Number.isSafeInteger(value[key]) && value[key] >= 0);
  return { ...usage, usageKnown };
}

export function matchesJsonSchema(value, schema) {
  if (!isPlainObject(schema)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null) return types.includes("null");
  if (types.includes("object") && isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
    if (Array.isArray(schema.required) && schema.required.some((key) => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, child]) => !properties[key] || matchesJsonSchema(child, properties[key]));
  }
  if (types.includes("array") && Array.isArray(value)) return isPlainObject(schema.items) && value.every((child) => matchesJsonSchema(child, schema.items));
  if (types.includes("string") && typeof value === "string") return true;
  if (types.includes("boolean") && typeof value === "boolean") return true;
  if (types.includes("integer") && Number.isSafeInteger(value)) return true;
  return types.includes("number") && typeof value === "number" && Number.isFinite(value);
}

export function assertSafeOutputValue(value) {
  if (typeof value === "string") {
    if (value !== value.normalize("NFC") || /[<>\p{Cc}\p{Cf}]/u.test(value)
      || Array.from(value).length > WORKLOAD_OUTPUT_CODEPOINTS.recap) throw new Error("GEMINI_OUTPUT_UNSAFE");
    return;
  }
  if (Array.isArray(value)) { for (const child of value) assertSafeOutputValue(child); return; }
  if (isPlainObject(value)) { for (const [key, child] of Object.entries(value)) { assertSafeOutputValue(key); assertSafeOutputValue(child); } return; }
  if (value !== null && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) throw new Error("GEMINI_OUTPUT_UNSAFE");
}

export function safeErrorCode(error) {
  const message = error instanceof Error ? error.message : "";
  if (error !== null && typeof error === "object" && error.status === 429) return "GEMINI_PROVIDER_RATE_LIMITED";
  return SAFE_GENERATION_ERROR_CODES.has(message) ? message : "GEMINI_PROVIDER_FAILED";
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
