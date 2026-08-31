import { createHash } from "node:crypto";

import type { MeetingSummaryConfig } from "./config";
import { recordGeminiSummaryMetric, type GeminiSummaryMetricEvent } from "./summary-observability";
import { createGeminiRestRecapGenerator as createUntypedGeminiRestRecapGenerator } from "../../../packages/gemini-server/index.js";

export interface GeminiSummaryGeneratorLimits {
  globalOutstanding: number;
  sessionOutstanding: number;
  globalRequestsPerMinute: number;
  sessionRequestsPerMinute: number;
  maximumTrackedSessions: number;
}

export interface GeminiRecapRequest<T> {
  sessionId: string;
  systemInstruction: string;
  prompt: string;
  responseJsonSchema: Record<string, unknown>;
  validate: (value: unknown) => T;
  signal: AbortSignal;
  maxOutputCodepoints?: number;
}

export interface GeminiRecapRuntime {
  generateRecap<T>(request: GeminiRecapRequest<T>): Promise<T>;
}

export interface GeminiSummaryContentRequest {
  sessionId: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface GeminiSummaryContentGenerator {
  generateContent(request: GeminiSummaryContentRequest): Promise<unknown>;
  releaseSession?(sessionId: string): void;
}

export interface GeminiSummaryGeneratorOptions {
  fetchFn?: typeof fetch;
  limits?: GeminiSummaryGeneratorLimits;
  observe?: (event: unknown) => void;
  now?: () => number;
}

interface SafeGeminiSummaryObservation extends GeminiSummaryMetricEvent {
  name: "live.summary.gemini";
}

type GeminiRestRecapFactory = (options: {
  apiKey: string;
  fetchFn?: typeof fetch;
  limits?: GeminiSummaryGeneratorLimits;
  observe?: (event: unknown) => void;
  now?: () => number;
}) => GeminiSummaryContentGenerator;

const createGeminiRestRecapGenerator = createUntypedGeminiRestRecapGenerator as unknown as GeminiRestRecapFactory;

export function createRuntimeBackedSummaryGenerator(
  runtime: GeminiRecapRuntime,
  config: MeetingSummaryConfig,
  validate: (value: unknown) => unknown,
): GeminiSummaryContentGenerator {
  return {
    async generateContent(request) {
      return runtime.generateRecap({
        sessionId: request.sessionId,
        systemInstruction: "Produce a grounded meeting record. Follow the supplied JSON schema exactly.",
        prompt: request.prompt,
        responseJsonSchema: request.schema,
        validate,
        signal: request.signal,
        maxOutputCodepoints: config.maxOutputTokens,
      });
    },
  };
}

export function createGeminiSummaryGenerator(
  config: MeetingSummaryConfig,
  options: GeminiSummaryGeneratorOptions = {},
): GeminiSummaryContentGenerator {
  return createGeminiRestRecapGenerator({
    apiKey: config.apiKey,
    fetchFn: options.fetchFn,
    limits: options.limits,
    observe: createSafeGeminiSummaryObserver(options.observe),
    now: options.now,
  });
}

function createSafeGeminiSummaryObserver(
  observe: ((event: unknown) => void) | undefined,
): (event: unknown) => void {
  return (event) => {
    if (!observe) return;
    const observation = safeGeminiSummaryObservation(event);
    if (!observation) return;
    observe(observation);
  };
}

function safeGeminiSummaryObservation(event: unknown): SafeGeminiSummaryObservation | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const record = event as Record<string, unknown>;
  if (record.workload !== "recap" || record.model !== "gemini-3.7-flash") return null;
  const usageKnown = record.usageKnown === true
    && [record.inputTokens, record.outputTokens, record.totalTokens]
      .every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return {
    name: "live.summary.gemini",
    workload: "recap",
    model: "gemini-3.7-flash",
    result: record.code === "OK" ? "ok" : "error",
    latencyMilliseconds: safeNonNegativeNumber(record.latencyMilliseconds),
    usageKnown,
    inputTokens: usageKnown ? safeNonNegativeNumber(record.inputTokens) : null,
    outputTokens: usageKnown ? safeNonNegativeNumber(record.outputTokens) : null,
    totalTokens: usageKnown ? safeNonNegativeNumber(record.totalTokens) : null,
  };
}

function safeNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

let cachedGenerator: { keyHash: string; generator: GeminiSummaryContentGenerator } | null = null;

export function getCachedGeminiSummaryGenerator(config: MeetingSummaryConfig): GeminiSummaryContentGenerator {
  const keyHash = createHash("sha256").update(config.apiKey).digest("hex");
  if (!cachedGenerator || cachedGenerator.keyHash !== keyHash) {
    cachedGenerator = {
      keyHash,
      generator: createGeminiSummaryGenerator(config, { observe: recordGeminiSummaryMetric }),
    };
  }
  return cachedGenerator.generator;
}

export function resetGeminiSummaryGeneratorCacheForTests(): void {
  cachedGenerator = null;
}

export function releaseCachedGeminiSummarySession(sessionId: string): void {
  cachedGenerator?.generator.releaseSession?.(sessionId);
}
