import { pathToFileURL } from "node:url";

import { createGeminiCaptionConfig, geminiCaptionConfigFingerprint, GEMINI_WORKLOAD_MODEL_MATRIX } from "../../packages/caption-core/index.js";
import { createGeminiServerRuntime } from "../../packages/gemini-server/index.js";
import { readGatewayEnvironment } from "./config.js";
import { createGatewayServer } from "./gateway-server.js";
import { installGatewayShutdown } from "./gateway-shutdown.js";
import { createGoogleLiveClient } from "./google-live-client.js";
import { assertEngineForLanguages, assertEngineKeys, createSpeechToText, createTextTranslate, isCombinedEngine } from "./engines/create-engines.js";
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

/** Paragraph summaries use the process admission cap. Live input/output
 * transcription shares bounded target connections without Flash audio requests. */
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
  const topicGenerators = new Map();

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
    async loadForEngine(engine) {
      const selection = assertEngineKeys(engine, { GEMINI_API_KEY: config.geminiApiKey, SONIOX_API_KEY: config.sonioxApiKey });
      return isCombinedEngine(selection) ? { liveClient: null, geminiRuntime: null } : load();
    },
    async bindTopicModel(sessionId, model) {
      const { geminiRuntime } = await load();
      if (!topicGenerators.has(sessionId) && topicGenerators.size >= GATEWAY_GEMINI_LIMITS.maximumTrackedSessions) throw new Error("GEMINI_TOPIC_MODEL_STATE_EXHAUSTED");
      const client = geminiRuntime.createSessionClient(sessionId, "topic", { model });
      topicGenerators.set(sessionId, createGeminiTopicGenerate({ client }));
    },
    async generateTopic(request, context) {
      const generate = topicGenerators.get(context?.sessionId);
      if (!generate) throw new Error("GEMINI_TOPIC_MODEL_NOT_BOUND");
      return generate(request, context);
    },
    async releaseSession(sessionId) {
      topicGenerators.delete(sessionId);
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

export function createGeminiTopicGenerate({ runtime = undefined, client = undefined }) {
  if (typeof runtime?.generateContent !== "function" && typeof client?.models?.generateContent !== "function") {
    throw new Error("INVALID_TOPIC_PROVIDER");
  }
  return async (request, { signal, sessionId } = {}) => {
    const input = parseTopicProviderRequest(request);
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new Error("INVALID_TOPIC_PROVIDER_REQUEST");
    }
    const dispatch = {
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
    };
    if (client) {
      const response = await client.models.generateContent({ contents: dispatch.contents,
        config: { ...dispatch.config, abortSignal: signal } });
      return { outputText: response.text };
    }
    const response = await runtime.generateContent(dispatch);
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

const FLASH_MODEL_METRICS = Object.freeze({ "gemini-3.7-flash": "flash_37", "gemini-3.6-flash": "flash_36", "gemini-3.5-flash": "flash_35" });
const GEMINI_METRIC_POLICY = Object.freeze({
  topic: FLASH_MODEL_METRICS,
  source: FLASH_MODEL_METRICS,
  translation: FLASH_MODEL_METRICS,
  polish: Object.freeze({ [GEMINI_WORKLOAD_MODEL_MATRIX.polish]: "flash_37" }),
  recap: FLASH_MODEL_METRICS,
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
  const modelMetric = policy && Object.hasOwn(policy, event?.model) ? policy[event.model] : null;
  const resultMetric = GEMINI_RESULT_METRICS[event?.code];
  if (typeof modelMetric !== "string" || !resultMetric
    || !Number.isFinite(event?.latencyMilliseconds) || event.latencyMilliseconds < 0
    || [event?.inputTokens, event?.outputTokens, event?.totalTokens]
      .some((value) => !Number.isSafeInteger(value) || value < 0)) return;
  const prefix = `gemini_${event.workload}`;
  metrics.increment(`${prefix}_model_${modelMetric}_total`);
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
    eventFanout(sessionId, language, event, context) { return gateway.broadcastEvent(sessionId, language, event, context); },
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
    // Presence-only view of the provider keys for the admin engine endpoint;
    // the factory below re-checks the same env before any pipeline exists.
    engineKeyEnvironment: { GEMINI_API_KEY: config.geminiApiKey, SONIOX_API_KEY: config.sonioxApiKey },
    async pipelineFactory(message, previousPipeline, onHostEvent, options = {}) {
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
      // Per-language caption seq survives host reconnects and process
      // restarts. Durable-failure recovery is stricter: the failed final has
      // already consumed an in-memory seq but its commit outcome is unknown,
      // so only the reconciled durable max may seed the replacement.
      const [{ liveClient, geminiRuntime }, initialSequences, compiledGlossary] = await Promise.all([
        runtimeLoader.loadForEngine(captionConfig.engine),
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
      // The session's engine selection picks the STT provider and the text
      // translator. A selection whose provider key is absent is refused here,
      // before any paid connection or pipeline exists; the host sees
      // ENGINE_KEY_MISSING through gatewayMessage. Key values are only tested
      // for presence and never copied into a pipeline or a log. A selection the
      // catalog does not support for the selected caption languages is
      // refused the same way as ENGINE_SELECTION_INVALID.
      const engine = captionConfig.engine;
      assertEngineKeys(engine, { GEMINI_API_KEY: config.geminiApiKey, SONIOX_API_KEY: config.sonioxApiKey });
      assertEngineForLanguages(engine, captionConfig.languages);
      const textTranslate = createTextTranslate({ engine, geminiRuntime, sessionId: message.sessionId });
      if (textTranslate === null && !isCombinedEngine(engine)) throw new Error("TEXT_TRANSLATE_REQUIRED");
      if (!isCombinedEngine(engine)) await runtimeLoader.bindTopicModel(message.sessionId, captionConfig.models.summary);
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
          // Gemini uses one STT connection; three-language Soniox owns one
          // native connection per target, but only one authoritative source.
          speechToText: createSpeechToText({
            engine,
            liveClient,
            sonioxApiKey: config.sonioxApiKey,
            languageCodes: [],
            compiledGlossary,
            glossaryText: captionConfig.glossary,
            domainText: captionConfig.domain,
            translationLanguages: captionConfig.languages,
          }),
          // null for a combined engine: translation then rides on the STT final.
          textTranslate,
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
