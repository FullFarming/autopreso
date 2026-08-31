const DEFAULT_BATCH_WINDOW_MILLISECONDS = 100;
const DEFAULT_MAX_BATCH_SIZE = 50;

function requestKey(request) {
  return `${request.sessionId}\u0000${request.grantId}\u0000${request.userId}\u0000${request.language}`;
}

function normalizeRequest(request) {
  if (!request || typeof request !== "object"
    || typeof request.sessionId !== "string" || !request.sessionId
    || typeof request.grantId !== "string" || !request.grantId
    || typeof request.userId !== "string" || !request.userId
    || typeof request.language !== "string" || !request.language) {
    throw new Error("INVALID_VIEWER_AUTHORIZATION_BATCH_REQUEST");
  }
  return { ...request, key: requestKey(request) };
}

export class ViewerAuthorizationBatcher {
  #pending = new Map();
  #activeEntries = new Map();
  #timer = null;
  #flight = null;
  #isClosed = false;

  constructor({
    authorizeBatch,
    batchWindowMilliseconds = DEFAULT_BATCH_WINDOW_MILLISECONDS,
    maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    if (typeof authorizeBatch !== "function") throw new Error("INVALID_VIEWER_BATCH_AUTHORIZER");
    if (!Number.isFinite(batchWindowMilliseconds) || batchWindowMilliseconds < 0 || batchWindowMilliseconds > 1_000) {
      throw new Error("INVALID_VIEWER_AUTHORIZATION_BATCH_WINDOW");
    }
    if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > DEFAULT_MAX_BATCH_SIZE) {
      throw new Error("INVALID_VIEWER_AUTHORIZATION_BATCH_SIZE");
    }
    this.authorizeBatch = authorizeBatch;
    this.batchWindowMilliseconds = batchWindowMilliseconds;
    this.maxBatchSize = maxBatchSize;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
  }

  authorize(request, { signal } = {}) {
    if (this.#isClosed) return Promise.reject(new Error("VIEWER_AUTHORIZATION_BATCHER_CLOSED"));
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("GRANT_CHECK_CANCELLED"));
    const normalized = normalizeRequest(request);
    let entry = this.#pending.get(normalized.key) ?? this.#activeEntries.get(normalized.key);
    if (!entry) {
      entry = { request: normalized, subscribers: new Set() };
      this.#pending.set(normalized.key, entry);
    }
    const promise = new Promise((resolve, reject) => {
      const subscriber = { resolve, reject, signal, onAbort: null };
      if (signal) {
        subscriber.onAbort = () => {
          entry.subscribers.delete(subscriber);
          reject(signal.reason instanceof Error ? signal.reason : new Error("GRANT_CHECK_CANCELLED"));
          if (entry.subscribers.size === 0 && this.#pending.get(normalized.key) === entry) {
            this.#pending.delete(normalized.key);
          }
        };
        signal.addEventListener("abort", subscriber.onAbort, { once: true });
      }
      entry.subscribers.add(subscriber);
    });
    if (this.#pending.get(normalized.key) === entry) {
      if (this.#pending.size >= this.maxBatchSize) this.#startBatch();
      else this.#scheduleBatch();
    }
    return promise;
  }

  deleteSession(sessionId) {
    const prefix = `${sessionId}\u0000`;
    for (const [key, entry] of this.#pending) {
      if (!key.startsWith(prefix)) continue;
      this.#pending.delete(key);
      this.#settle(entry, false);
    }
    for (const [key, entry] of this.#activeEntries) {
      if (!key.startsWith(prefix)) continue;
      this.#activeEntries.delete(key);
      this.#settle(entry, false);
    }
    if (this.#pending.size === 0 && this.#timer) {
      this.clearTimeoutFn(this.#timer);
      this.#timer = null;
    }
  }

  close() {
    if (this.#isClosed) return;
    this.#isClosed = true;
    if (this.#timer) this.clearTimeoutFn(this.#timer);
    this.#timer = null;
    const error = new Error("VIEWER_AUTHORIZATION_BATCHER_CLOSED");
    this.#flight?.controller.abort(error);
    for (const entry of this.#pending.values()) this.#settle(entry, false, error);
    this.#pending.clear();
    for (const entry of this.#activeEntries.values()) this.#settle(entry, false, error);
    this.#activeEntries.clear();
  }

  #scheduleBatch() {
    if (this.#timer || this.#flight || this.#pending.size === 0) return;
    if (this.batchWindowMilliseconds === 0) {
      this.#startBatch();
      return;
    }
    this.#timer = this.setTimeoutFn(() => {
      this.#timer = null;
      this.#startBatch();
    }, this.batchWindowMilliseconds);
    this.#timer?.unref?.();
  }

  #startBatch() {
    if (this.#isClosed || this.#flight || this.#pending.size === 0) return;
    if (this.#timer) this.clearTimeoutFn(this.#timer);
    this.#timer = null;
    const entries = [...this.#pending.values()].slice(0, this.maxBatchSize);
    for (const entry of entries) {
      this.#pending.delete(entry.request.key);
      this.#activeEntries.set(entry.request.key, entry);
    }
    const controller = new AbortController();
    this.#flight = { controller, promise: null };
    const promise = Promise.resolve()
      .then(() => this.authorizeBatch(entries.map((entry) => entry.request), { signal: controller.signal }))
      .then((results) => {
        for (const entry of entries) {
          const value = results instanceof Map ? results.get(entry.request.key) : undefined;
          this.#settle(entry, value === true);
        }
      }, () => {
        for (const entry of entries) this.#settle(entry, false);
      })
      .finally(() => {
        for (const entry of entries) {
          if (this.#activeEntries.get(entry.request.key) === entry) this.#activeEntries.delete(entry.request.key);
        }
        if (this.#flight?.promise === promise) this.#flight = null;
        if (this.#pending.size >= this.maxBatchSize) this.#startBatch();
        else this.#scheduleBatch();
      });
    this.#flight.promise = promise;
  }

  #settle(entry, value, error = null) {
    for (const subscriber of entry.subscribers) {
      if (subscriber.onAbort) subscriber.signal.removeEventListener("abort", subscriber.onAbort);
      if (error) subscriber.reject(error);
      else subscriber.resolve(value);
    }
    entry.subscribers.clear();
  }
}
