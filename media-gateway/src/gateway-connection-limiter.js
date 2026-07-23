export class GatewayConnectionLimiter {
  #activeConnections = 0;
  #clients = new Map();

  constructor({
    maxConnections = 200,
    maxConnectionsPerClient = 8,
    attemptsPerMinute = 30,
    maxClientBuckets = 10_000,
    now = Date.now,
  } = {}) {
    for (const [name, value] of Object.entries({ maxConnections, maxConnectionsPerClient, attemptsPerMinute, maxClientBuckets })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`INVALID_${name.toUpperCase()}`);
    }
    this.maxConnections = maxConnections;
    this.maxConnectionsPerClient = maxConnectionsPerClient;
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
    return () => {
      if (isReleased) return;
      isReleased = true;
      this.#activeConnections = Math.max(0, this.#activeConnections - 1);
      const current = this.#clients.get(clientKey);
      if (!current) return;
      current.active = Math.max(0, current.active - 1);
      current.lastSeenAt = this.now();
    };
  }

  #prune(timestamp) {
    for (const [key, state] of this.#clients) {
      if (state.active === 0 && timestamp - state.lastSeenAt >= 60_000) this.#clients.delete(key);
      if (this.#clients.size < this.maxClientBuckets) return;
    }
  }
}
