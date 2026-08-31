export class GatewayConnectionLimiter {
  #activeConnections = 0;
  #clients = new Map();

  constructor({
    maxConnections = 256,
    maxConnectionsPerClient = 224,
    maxAuthenticatedConnectionsPerClient = 2,
    attemptsPerMinute = 300,
    maxClientBuckets = 10_000,
    now = Date.now,
  } = {}) {
    for (const [name, value] of Object.entries({
      maxConnections,
      maxConnectionsPerClient,
      maxAuthenticatedConnectionsPerClient,
      attemptsPerMinute,
      maxClientBuckets,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`INVALID_${name.toUpperCase()}`);
    }
    this.maxConnections = maxConnections;
    this.maxConnectionsPerClient = maxConnectionsPerClient;
    this.maxAuthenticatedConnectionsPerClient = maxAuthenticatedConnectionsPerClient;
    this.attemptsPerMinute = attemptsPerMinute;
    this.maxClientBuckets = maxClientBuckets;
    this.now = now;
  }

  acquire(clientKey) {
    const timestamp = this.now();
    const existing = this.#clients.get(clientKey);
    const elapsed = existing ? Math.max(0, timestamp - existing.refilledAt) : 0;
    const tokens = Math.min(
      this.attemptsPerMinute,
      (existing?.tokens ?? this.attemptsPerMinute) + elapsed * this.attemptsPerMinute / 60_000,
    );
    if (!existing && this.#clients.size >= this.maxClientBuckets) this.#prune(timestamp);
    if (!existing && this.#clients.size >= this.maxClientBuckets) return null;
    const state = existing ?? { active: 0, tokens, refilledAt: timestamp, lastSeenAt: timestamp };
    state.tokens = tokens;
    state.refilledAt = timestamp;
    state.lastSeenAt = timestamp;
    this.#clients.set(clientKey, state);
    if (state.tokens < 1) return null;
    state.tokens -= 1;
    if (this.#activeConnections >= this.maxConnections || state.active >= this.maxConnectionsPerClient) return null;
    state.active += 1;
    this.#activeConnections += 1;
    let isReleased = false;
    let currentKey = clientKey;
    const release = () => {
      if (isReleased) return;
      isReleased = true;
      this.#activeConnections = Math.max(0, this.#activeConnections - 1);
      const current = this.#clients.get(currentKey);
      if (!current) return;
      current.active = Math.max(0, current.active - 1);
      current.lastSeenAt = this.now();
    };
    release.promote = (authenticatedKey) => {
      if (isReleased || typeof authenticatedKey !== "string" || !/^[0-9a-f]{64}$/u.test(authenticatedKey)) return false;
      const nextKey = `authenticated:${authenticatedKey}`;
      if (currentKey === nextKey) return true;
      let next = this.#clients.get(nextKey);
      if (!next && this.#clients.size >= this.maxClientBuckets) this.#prune(this.now());
      if (!next && this.#clients.size >= this.maxClientBuckets) return false;
      next ??= { active: 0, tokens: this.attemptsPerMinute, refilledAt: this.now(), lastSeenAt: this.now() };
      if (next.active >= this.maxAuthenticatedConnectionsPerClient) return false;
      const current = this.#clients.get(currentKey);
      if (current) {
        current.active = Math.max(0, current.active - 1);
        current.lastSeenAt = this.now();
      }
      next.active += 1;
      next.lastSeenAt = this.now();
      this.#clients.set(nextKey, next);
      currentKey = nextKey;
      return true;
    };
    return release;
  }

  #prune(timestamp) {
    for (const [key, state] of this.#clients) {
      if (state.active === 0 && timestamp - state.lastSeenAt >= 60_000) this.#clients.delete(key);
      if (this.#clients.size < this.maxClientBuckets) return;
    }
  }
}
