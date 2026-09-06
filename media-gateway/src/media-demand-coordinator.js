import { randomUUID } from "node:crypto";

/** The gateway owns connected leases; admission tickets alone never start AI. */
export class MediaDemandCoordinator {
  constructor({ store, onIdle, now = Date.now, pollMilliseconds = 5_000, startTimeoutMilliseconds = 20_000 }) {
    this.store = store;
    this.onIdle = onIdle;
    this.now = now;
    this.startTimeoutMilliseconds = startTimeoutMilliseconds;
    this.ownerId = randomUUID();
    this.sessions = new Map();
    this.closed = false;
    this.timer = setInterval(() => { void this.tick(); }, pollMilliseconds);
    this.timer.unref?.();
  }

  async read(sessionId) { return this.store.read(sessionId); }

  async connect(claims, message) {
    const runtime = await this.read(claims.sessionId);
    if (!runtime) return null;
    if (!Number.isSafeInteger(message.epoch) || message.epoch !== runtime.epoch
      || typeof message.connectionId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(message.connectionId)) {
      throw new Error("MEDIA_CONNECTION_INVALID");
    }
    const result = await this.store.transition(claims.sessionId, runtime.epoch, this.ownerId, "connect", {
      connectionId: message.connectionId, grantId: claims.grantId, userId: claims.userId,
    });
    const entry = this.#entry(result);
    entry.connections.add(message.connectionId);
    entry.verifiedAt.set(message.connectionId, this.now());
    return { connectionId: message.connectionId, epoch: runtime.epoch };
  }

  async disconnect(sessionId, connection) {
    if (!connection) return;
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.epoch !== connection.epoch) return;
    entry.connections.delete(connection.connectionId);
    entry.verifiedAt.delete(connection.connectionId);
    await this.store.transition(sessionId, entry.epoch, this.ownerId, "disconnect", {
      connectionId: connection.connectionId,
    });
  }

  async prepare(sessionId, signal) {
    const runtime = await this.read(sessionId);
    if (!runtime) return null;
    const entry = this.#entry(await this.store.transition(sessionId, runtime.epoch, this.ownerId, "claim"));
    const deadline = Math.min(this.now() + this.startTimeoutMilliseconds, Date.parse(runtime.wakeDeadline) || Infinity);
    while (!this.closed && !signal?.aborted && !entry.closing && this.now() < deadline) {
      const current = await this.read(sessionId);
      if (!current || current.epoch !== entry.epoch || !current.hostSourceReady
        || ["ended", "failed", "sleeping", "draining"].includes(current.state)) throw new Error("MEDIA_START_DENIED");
      if (entry.connections.size > 0 && current.connectedCount > 0) return entry.epoch;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("MEDIA_START_TIMEOUT");
  }

  async ready(sessionId, epoch) {
    if (epoch === null) return;
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closing || entry.epoch !== epoch || entry.connections.size === 0) throw new Error("MEDIA_DEMAND_LOST");
    await this.store.transition(sessionId, epoch, this.ownerId, "ready");
  }

  markAlive(sessionId, connection) {
    const entry = this.sessions.get(sessionId);
    if (connection && entry?.epoch === connection.epoch && entry.connections.has(connection.connectionId)) {
      entry.verifiedAt.set(connection.connectionId, this.now());
    }
  }

  async fail(sessionId, epoch, reason = "MEDIA_START_FAILED") {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.epoch !== epoch || entry.closing) return;
    await this.#idle(sessionId, entry, reason);
  }

  async tick() {
    await Promise.all([...this.sessions].map(async ([sessionId, entry]) => {
      if (entry.checking || entry.closing) return;
      entry.checking = true;
      try {
        const runtime = await this.store.transition(sessionId, entry.epoch, this.ownerId, "renew", {
          connectionIds: [...entry.connections].filter((id) => this.now() - (entry.verifiedAt.get(id) ?? 0) < 45_000),
        });
        if (runtime.epoch !== entry.epoch || runtime.state === "ended") {
          await this.#idle(sessionId, entry, "SESSION_ENDED");
        } else if (!runtime.hostSourceReady) {
          await this.#idle(sessionId, entry, "source_unavailable");
        } else if (runtime.state === "waking" && Date.parse(runtime.wakeDeadline) <= this.now()) {
          await this.#idle(sessionId, entry, "MEDIA_START_TIMEOUT");
        } else if (runtime.connectedCount === 0 && runtime.idleAfter && Date.parse(runtime.idleAfter) <= this.now()) {
          await this.#idle(sessionId, entry, "no_audience");
        }
      } catch {
        // Losing the control plane must never leave an unbounded paid stream.
        await this.#idle(sessionId, entry, "MEDIA_LEASE_FAILED");
      } finally { entry.checking = false; }
    }));
  }

  async #idle(sessionId, entry, reason) {
    if (entry.closing) return;
    entry.closing = true;
    let cancelled = false;
    try {
      if (reason !== "SESSION_ENDED") {
        let runtime;
        try { runtime = await this.store.transition(sessionId, entry.epoch, this.ownerId, "drain"); }
        catch {
          runtime = await this.read(sessionId).catch(() => null);
          // PostgreSQL may reject the drain because a reconnect won its row lock.
          if (reason === "no_audience" && runtime?.epoch === entry.epoch
            && runtime.state === "active" && runtime.connectedCount > 0) {
            cancelled = true; entry.closing = false; return;
          }
          reason = "MEDIA_LEASE_FAILED";
        }
        if (reason === "no_audience" && runtime?.epoch === entry.epoch && runtime.connectedCount > 0) {
          cancelled = true; entry.closing = false; return;
        }
      }
      const outcome = await this.onIdle(sessionId, entry.epoch, reason);
      if (outcome?.drained === false) reason = "MEDIA_DRAIN_FAILED";
    } finally {
      if (cancelled) return;
      await this.store.transition(sessionId, entry.epoch, this.ownerId,
        ["no_audience", "source_unavailable"].includes(reason) ? "sleep" : "fail").catch(() => undefined);
      if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId);
    }
  }

  #entry(runtime) {
    let entry = this.sessions.get(runtime.sessionId);
    if (!entry || entry.epoch !== runtime.epoch) {
      entry = { epoch: runtime.epoch, connections: new Set(), verifiedAt: new Map(), checking: false, closing: false };
      this.sessions.set(runtime.sessionId, entry);
    }
    return entry;
  }

  close() { this.closed = true; clearInterval(this.timer); }
}
