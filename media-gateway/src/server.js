import { pathToFileURL } from "node:url";

import { createGeminiCaptionConfig, geminiCaptionConfigFingerprint, GEMINI_WORKLOAD_MODEL_MATRIX } from "../../packages/caption-core/index.js";
import { createGeminiServerRuntime } from "../../packages/gemini-server/index.js";
import { createCaptionPolisher } from "./caption-polish.js";
import { buildDefaultDomainInstruction } from "./glossary-packs.js";
import { readGatewayEnvironment } from "./config.js";
import { createGatewayServer } from "./gateway-server.js";
import { installGatewayShutdown } from "./gateway-shutdown.js";
import { createGoogleLiveClient } from "./google-live-client.js";
import {
  GeminiLiveTranscriptionAdapter,
  GeminiTextTranslateAdapter,
} from "./google-provider-adapters.js";
import { LiveMediaPipeline } from "./live-media-pipeline.js";
import { createLiveTopicDetector } from "./live-topic-detector.js";
import {
  SupabaseFloorController,
  SupabaseHostAuthorizer,
  SupabaseLivePublisher,
  SupabasePinnedGlossaryLoader,
  SupabaseViewerAuthorizer,
  SupabaseMediaDemandStore,
} from "./supabase-adapters.js";

export function listenMediaGateway(server, config) {
  return new Promise((resolve) => server.listen(config.port, config.host, resolve));
}

/** Gemini admission budget sized for the densest supported Live Call: one
 *  committed final on a three-language session holds up to four concurrent
 *  workload calls (two lane translations + selective polish + topic), and
 *  clause-level segmentation can commit ~20 finals a minute. The library
 *  defaults (2 outstanding / 30 per minute) were sized for one-shot REST
 *  workloads and made dense sessions throw GEMINI_SESSION_BUDGET_EXHAUSTED,
 *  publishing verbatim source text on translated lanes. */
export const GATEWAY_GEMINI_LIMITS = Object.freeze({
  globalOutstanding: 16,
  sessionOutstanding: 6,
  globalRequestsPerMinute: 360,
  sessionRequestsPerMinute: 120,
  maximumTrackedSessions: 10_000,
});

export function createMediaGatewayRuntimeLoader({
  config,
  getGateway,
  importGoogleGenAI = () => import("@google/genai"),
} = {}) {
  if (!config || typeof getGateway !== "function") throw new Error("INVALID_GATEWAY_RUNTIME_LOADER");
  let flight = null;
  let loadedRuntime = null;
  let topicGenerate = null;

  const load = async () => {
    if (!flight) {
      flight = importGoogleGenAI().then(({ GoogleGenAI }) => {
        const geminiRuntime = createGeminiServerRuntime({
          GoogleGenAI,
          apiKey: config.geminiApiKey,
          limits: GATEWAY_GEMINI_LIMITS,
          observe(event) {
            const gateway = getGateway();
            if (gateway) observeGeminiRuntimeMetrics(gateway.metrics, event);
          },
        });
        loadedRuntime = {
          geminiRuntime,
          liveClient: createGoogleLiveClient({ apiKey: config.geminiApiKey }),
        };
        return loadedRuntime;
      }).catch((error) => {
        flight = null;
        throw error;
      });
    }
    return flight;
  };

  return Object.freeze({
    load,
    async generateTopic(request, context) {
      const { geminiRuntime } = await load();
      if (!topicGenerate) topicGenerate = createGeminiTopicGenerate({ runtime: geminiRuntime });
      return topicGenerate(request, context);
    },
    async releaseSession(sessionId) {
      loadedRuntime?.geminiRuntime.releaseSession(sessionId);
    },
  });
}

export function createCaptionPolishPolicyResolver({
  defaultPolicy = "selective",
  policyWeights = { off: 0, selective: 10_000, full: 0 },
} = {}) {
  const policies = new Set(["off", "selective", "full"]);
  if (!policies.has(defaultPolicy)) throw new Error("INVALID_CAPTION_POLISH_POLICY");
  const weights = Object.fromEntries([...policies].map((policy) => [policy, policyWeights?.[policy]]));
  if (Object.values(weights).some((value) => !Number.isInteger(value) || value < 0 || value > 10_000)
    || Object.values(weights).reduce((sum, value) => sum + value, 0) > 10_000) {
    throw new Error("INVALID_CAPTION_POLISH_CANARY");
  }
  return (sessionId) => {
    let hash = 2_166_136_261;
    for (const character of String(sessionId)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    const bucket = hash % 10_000;
    let upperBound = 0;
    for (const policy of ["off", "selective", "full"]) {
      upperBound += weights[policy];
      if (bucket < upperBound) return policy;
    }
    return defaultPolicy;
  };
}

export function createGeminiTopicGenerate({ runtime }) {
  if (typeof runtime?.generateContent !== "function") {
    throw new Error("INVALID_TOPIC_PROVIDER");
  }
  return async (request, { signal, sessionId } = {}) => {
    const input = parseTopicProviderRequest(request);
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new Error("INVALID_TOPIC_PROVIDER_REQUEST");
    }
    const response = await runtime.generateContent({
      sessionId,
      workload: "topic",
      contents: [{ role: "user", parts: [{ text: input.user }] }],
      config: {
        systemInstruction: input.system,
        responseMimeType: "application/json",
        responseJsonSchema: input.schema,
        maxOutputTokens: 512,
      },
      signal,
    });
    return { outputText: response.outputText };
  };
}

function parseTopicProviderRequest(request) {
  if (!isPlainObject(request)
    || Object.keys(request).sort().join("\u0000") !== ["input", "store", "text"].join("\u0000")
    || request.store !== false
    || !Array.isArray(request.input)
    || request.input.length !== 2
    || request.input[0]?.role !== "system"
    || typeof request.input[0]?.content !== "string"
    || request.input[1]?.role !== "user"
    || typeof request.input[1]?.content !== "string"
    || !isPlainObject(request.text)
    || !isPlainObject(request.text.format)
    || request.text.format.type !== "json_schema"
    || request.text.format.name !== "live_topic_decision"
    || request.text.format.strict !== true
    || !isPlainObject(request.text.format.schema)
    || request.text.format.schema.type !== "object"
    || request.text.format.schema.additionalProperties !== false) {
    throw new Error("INVALID_TOPIC_PROVIDER_REQUEST");
  }
  return {
    system: request.input[0].content,
    user: request.input[1].content,
    schema: request.text.format.schema,
  };
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

const GEMINI_METRIC_POLICY = Object.freeze({
  topic: Object.freeze({ model: "gemini-3.7-flash", modelMetric: "flash_37" }),
  translation: Object.freeze({ model: "gemini-3.7-flash", modelMetric: "flash_37" }),
  polish: Object.freeze({ model: "gemini-3.7-flash", modelMetric: "flash_37" }),
  recap: Object.freeze({ model: "gemini-3.7-flash", modelMetric: "flash_37" }),
});
const GEMINI_RESULT_METRICS = Object.freeze({
  OK: "ok",
  GEMINI_OUTPUT_INVALID: "output_invalid",
  GEMINI_OUTPUT_SCHEMA_INVALID: "schema_invalid",
  GEMINI_OUTPUT_TOO_LARGE: "output_too_large",
  GEMINI_OUTPUT_UNSAFE: "output_unsafe",
  GEMINI_PROVIDER_FAILED: "provider_failed",
  GEMINI_PROVIDER_RATE_LIMITED: "rate_limited",
  GEMINI_PROVIDER_REFUSAL: "refusal",
  GEMINI_RECAP_VALIDATION_FAILED: "recap_invalid",
  GEMINI_USAGE_INVALID: "usage_invalid",
});

export function observeGeminiRuntimeMetrics(metrics, event) {
  const policy = GEMINI_METRIC_POLICY[event?.workload];
  const resultMetric = GEMINI_RESULT_METRICS[event?.code];
  if (!policy || event?.model !== policy.model || !resultMetric
    || !Number.isFinite(event?.latencyMilliseconds) || event.latencyMilliseconds < 0
    || [event?.inputTokens, event?.outputTokens, event?.totalTokens]
      .some((value) => !Number.isSafeInteger(value) || value < 0)) return;
  const prefix = `gemini_${event.workload}`;
  metrics.increment(`${prefix}_model_${policy.modelMetric}_total`);
  metrics.increment(`${prefix}_result_${resultMetric}_total`);
  metrics.observe(`${prefix}_latency_ms`, event.latencyMilliseconds);
  if (event.usageKnown !== true) {
    metrics.increment(`${prefix}_usage_unknown_total`);
    return;
  }
  metrics.observe(`${prefix}_input_tokens`, event.inputTokens);
  metrics.observe(`${prefix}_output_tokens`, event.outputTokens);
  metrics.observe(`${prefix}_total_tokens`, event.totalTokens);
}

export async function startMediaGateway(config = readGatewayEnvironment(), {
  importGoogleGenAI,
  listen = listenMediaGateway,
} = {}) {
  let gateway;
  const runtimeLoader = createMediaGatewayRuntimeLoader({
    config,
    getGateway: () => gateway,
    ...(importGoogleGenAI ? { importGoogleGenAI } : {}),
  });
  const viewerAuthorizer = new SupabaseViewerAuthorizer(config);
  const hostAuthorizer = new SupabaseHostAuthorizer(config);
  const pinnedGlossaryLoader = new SupabasePinnedGlossaryLoader(config);
  const topicDetector = createLiveTopicDetector({
    generate: (request, context) => runtimeLoader.generateTopic(request, context),
  });
  const publisher = new SupabaseLivePublisher({
    ...config,
    topicDetector,
    observeTopicFailure() { gateway?.metrics.increment("topic_side_effect_failures_total"); },
    eventFanout(sessionId, language, event) { return gateway.broadcastEvent(sessionId, language, event); },
    sourceEventFanout(event, context) { return gateway.broadcastSourceEvent(event, context); },
  });
  const floorController = new SupabaseFloorController(config);
  const resolveCaptionPolishPolicy = createCaptionPolishPolicyResolver({
    defaultPolicy: "selective",
    policyWeights: config.captionPolishPolicyWeights,
  });
  gateway = createGatewayServer({
    gatewaySecret: config.gatewaySecret,
    viewerSecret: config.viewerSecret,
    hostAuthorizer,
    viewerAuthorizer,
    floorController,
    releaseGeminiSession: (sessionId) => runtimeLoader.releaseSession(sessionId),
    hostReconnectGraceMilliseconds: config.hostReconnectGraceMilliseconds,
    mediaDemandStore: config.participantDemandEnabled ? new SupabaseMediaDemandStore(config) : null,
    fetchFloorParticipant: (sessionId, participantId) => floorController.getParticipant(sessionId, participantId),
    replayUtterances: (sessionId, language, afterSeq, limit, options) => publisher.fetchUtterancesAfter(sessionId, language, afterSeq, limit, options),
    async pipelineFactory(message, previousPipeline, onHostEvent, options = {}) {
      // Per-language caption seq survives host reconnects and process
      // restarts. Durable-failure recovery is stricter: the failed final has
      // already consumed an in-memory seq but its commit outcome is unknown,
      // so only the reconciled durable max may seed the replacement.
      const [{ geminiRuntime, liveClient }, initialSequences, compiledGlossary] = await Promise.all([
        runtimeLoader.load(),
        resolvePipelineInitialSequences({
          publisher,
          message,
          previousPipeline,
          recoveryReason: options.recoveryReason,
          requireDurableSeed: options.requireDurableSeed,
          signal: options.signal,
        }),
        pinnedGlossaryLoader.load(message.sessionId, { signal: options.signal }),
      ]);
      const captionPolishPolicy = resolveCaptionPolishPolicy(message.sessionId);
      const captionConfig = createGeminiCaptionConfig({
        ...(message.captionConfig ?? {
          glossaryText: message.glossaryText,
          glossaryPack: message.glossaryPack,
          domainText: message.domainText,
          translationTone: message.translationTone,
          languages: message.languages,
          outputMode: message.outputMode,
        }),
        captionPolishPolicy,
      });
      return new LiveMediaPipeline({
        sessionId: message.sessionId,
        sessionType: message.sessionType,
        outputMode: message.outputMode,
        maxViewers: message.maxViewers,
        glossaryPack: message.glossaryPack,
        glossaryText: message.glossaryText,
        compiledGlossary,
        translationTone: message.translationTone,
        domainText: message.domainText,
        captionConfig,
        captionConfigFingerprint: geminiCaptionConfigFingerprint(captionConfig),
        languages: message.languages,
        captionPolishPolicy,
        speakerRegistry: previousPipeline?.speakers,
        initialSequences,
        getSubscriberCount: (language) => gateway.subscriberCount(message.sessionId, language),
        observeLatency: (name, value) => gateway.metrics.observe(name, value),
        onHostEvent,
        onFatalError: options.onFatalError,
        dependencies: {
          // One host audio stream is transcribed once. Translation starts from
          // committed text, so captions-only Live Call never asks Gemini Live
          // to synthesize paid audio that the product does not deliver.
          speechToText: new GeminiLiveTranscriptionAdapter({
            client: liveClient,
            model: GEMINI_WORKLOAD_MODEL_MATRIX.transcription,
            languageCodes: config.sttLanguageCodes,
            compiledGlossary,
          }),
          // Finals use Gemini Flash, with no alternate translation engine.
          textTranslate: new GeminiTextTranslateAdapter({
            client: geminiRuntime.createSessionClient(message.sessionId, "translation"),
            model: GEMINI_WORKLOAD_MODEL_MATRIX.translation,
          }),
          // Keep the desktop caption finalizer's six-second quality budget.
          // This optional selective pass runs only on committed text and never
          // requests or publishes translated audio.
          captionPolish: createCaptionPolisher({
            client: geminiRuntime.createSessionClient(message.sessionId, "polish"),
            model: GEMINI_WORKLOAD_MODEL_MATRIX.polish,
            timeoutMs: 6_000,
            // CRE is the product default, so it is the standing domain
            // instruction; per-session terminology arrives via pinned
            // compiled glossaries, never via glossaryPack.
            defaultDomain: buildDefaultDomainInstruction(),
          }),
          publisher: publisher.withMediaFence(options.mediaFence ?? null, { pipelineGeneration: options.pipelineGeneration }),
        },
      });
    },
  });
  await listen(gateway.server, config);
  return gateway;
}

export async function resolvePipelineInitialSequences({
  publisher,
  message,
  previousPipeline = null,
  recoveryReason = null,
  signal = null,
  requireDurableSeed = false,
}) {
  const isDurableRecovery = recoveryReason === "durable-caption";
  const initialSequences = isDurableRecovery ? {} : { ...(previousPipeline?.lastSequences ?? {}) };
  try {
    const persisted = isDurableRecovery
      ? Object.fromEntries(await Promise.all(message.languages.map(async (language) => [
        language,
        await publisher.reconcileCaptionLane(message.sessionId, language, { signal }),
      ])))
      : await publisher.fetchLastUtteranceSeqs(message.sessionId, message.languages);
    for (const language of message.languages) {
      const rawPersistedSequence = persisted?.[language];
      if ((isDurableRecovery || requireDurableSeed)
        && (!Object.hasOwn(persisted ?? {}, language)
          || !Number.isSafeInteger(rawPersistedSequence)
          || rawPersistedSequence < 0)) {
        throw new Error("DURABLE_CAPTION_RECOVERY_SEED_INVALID");
      }
      const persistedSequence = Number(rawPersistedSequence ?? 0);
      const durableSequence = Number.isSafeInteger(persistedSequence) && persistedSequence >= 0
        ? persistedSequence
        : 0;
      initialSequences[language] = isDurableRecovery
        ? durableSequence
        : Math.max(initialSequences[language] ?? 0, durableSequence);
    }
  } catch (error) {
    if (requireDurableSeed) throw new Error("MEDIA_SEQUENCE_RESTORE_FAILED", { cause: error });
    if (isDurableRecovery) {
      if (error instanceof Error && error.message === "DURABLE_CAPTION_RECOVERY_SEED_INVALID") throw error;
      throw new Error("DURABLE_CAPTION_RECOVERY_SEED_FAILED", { cause: error });
    }
    // Ordinary settings updates preserve the prior in-memory counters when
    // the read is unavailable; they do not follow an ambiguous failed commit.
  }
  // The seed only completes when this session is getting a fresh pipeline
  // (durable recovery additionally proves reconciliation serialized behind
  // the ambiguous commit above). New pipelines derive fresh utterance keys,
  // so the source latch's job — stopping the FAILED pipeline from retrying
  // an ambiguous write — is over.
  publisher.resetAuthoritativeSourceLane?.(message.sessionId);
  return initialSequences;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMediaGateway().then((gateway) => {
    installGatewayShutdown(gateway);
    process.stdout.write("Realtime Noel media gateway listening\n");
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "미디어 게이트웨이를 시작하지 못했습니다."}\n`);
    process.exitCode = 1;
  });
}
