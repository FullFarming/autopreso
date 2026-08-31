import { randomUUID } from "node:crypto";

const CONTROL_INTERVAL_MS = 5_000;
const SOURCE_HEARTBEAT_MS = 15_000;
const RUNTIME_STATES = new Set(["sleeping", "waking", "active", "draining", "failed", "ended"]);

export function createDesktopLiveDemandController({
  request, hasSource, isActive, onConnect, onIdle, onError,
  now = Date.now, createGeneration = randomUUID,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let stopped = false;
  let failed = false;
  let runtime = null;
  let generation = createGeneration();
  let sourceRegistered = false;
  let sourceHeartbeatAt = null;
  let lastRefreshAt = null;
  let refreshPromise = null;
  let sourcePromise = null;
  let connectionPromise = null;
  let timer = null;
  let stopPromise = null;

  const canConnect = () => !stopped && !failed && isActive() && hasSource()
    && runtime?.enabled === true && runtime.hostSourceReady === true
    && runtime.hasDemand === true && ["waking", "active"].includes(runtime.state);

  function fail(code) {
    if (stopped || failed) return;
    failed = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    onIdle();
    onError(typeof code === "string" && /^[A-Z0-9_]{1,80}$/u.test(code) ? code : "MEDIA_CONTROL_FAILED");
  }

  async function writeSource(sourceReady) {
    // An ambiguous successful write still needs a final release; leases expire
    // server-side if that release cannot reach the server.
    const requestGeneration = generation;
    if (sourceReady) {
      sourceRegistered = true;
    } else {
      // A release can commit even when its response is lost. Never reuse the
      // tombstoned generation; a failed request still reaches the caller.
      sourceRegistered = false;
      generation = createGeneration();
    }
    const result = await request("host-source", { method: "POST", body: { sourceGeneration: requestGeneration, sourceReady } });
    if (!result?.ok) throw new Error(result?.code ?? "MEDIA_SOURCE_LEASE_FAILED");
    sourceHeartbeatAt = now();
    return result;
  }

  function schedule() {
    if (stopped || failed || !isActive() || timer !== null) return;
    timer = setTimer(() => { timer = null; void refresh(); }, CONTROL_INTERVAL_MS);
    timer?.unref?.();
  }

  async function refreshOnce() {
    lastRefreshAt = now();
    try {
      const sourceReady = hasSource();
      if ((sourceReady && (!sourceRegistered || sourceHeartbeatAt === null || now() - sourceHeartbeatAt >= SOURCE_HEARTBEAT_MS))
        || (!sourceReady && sourceRegistered)) {
        sourcePromise = writeSource(sourceReady);
        try { await sourcePromise; } finally { sourcePromise = null; }
      }
      if (stopped || !isActive()) return;
      const result = await request("runtime", { method: "GET" });
      if (stopped || !isActive()) return;
      const next = result?.data;
      if (!result?.ok) throw new Error(result?.code ?? "MEDIA_CONTROL_FAILED");
      if (next?.enabled !== true || !RUNTIME_STATES.has(next.state)
        || !Number.isSafeInteger(next.epoch) || next.epoch < 0
        || typeof next.hostSourceReady !== "boolean" || typeof next.hasDemand !== "boolean") {
        throw new Error("MEDIA_RUNTIME_INVALID");
      }
      runtime = next;
      if (runtime.state === "failed") throw new Error("MEDIA_RUNTIME_FAILED");
      if (runtime.state === "ended") throw new Error("SESSION_ENDED");
      if (!sourceReady || ["sleeping", "draining", "ended"].includes(runtime.state)) onIdle();
      if (canConnect() && !connectionPromise) {
        connectionPromise = Promise.resolve().then(() => canConnect() ? onConnect() : undefined)
          .catch((error) => fail(error?.message)).finally(() => { connectionPromise = null; });
      }
    } catch (error) {
      fail(error?.message);
    }
  }

  function refresh() {
    if (refreshPromise) return refreshPromise;
    if (stopped || failed || !isActive()) return Promise.resolve();
    if (lastRefreshAt !== null && now() - lastRefreshAt < CONTROL_INTERVAL_MS) return Promise.resolve();
    refreshPromise = refreshOnce().finally(() => { refreshPromise = null; schedule(); });
    return refreshPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    onIdle();
    // Serialize false after an in-flight true; otherwise the late heartbeat can
    // re-arm a source after the host has already stopped capture.
    stopPromise = (async () => {
      try { await sourcePromise; } catch { /* The final release still has to run. */ }
      if (sourceRegistered) {
        try { await writeSource(false); } catch (error) { onError(error?.message ?? "MEDIA_SOURCE_RELEASE_FAILED"); }
      }
    })();
    return stopPromise;
  }

  return {
    refresh, stop, canConnect,
    getState: () => ({ failed, runtime, stopped }),
    handleIdle: (reason) => {
      runtime = null;
      onIdle();
      if (!["no_audience", "source_unavailable"].includes(reason)) fail(reason);
    },
  };
}
