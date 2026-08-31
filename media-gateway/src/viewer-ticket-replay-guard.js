const DEFAULT_MAX_ENTRIES = 10_000;

export class ViewerTicketReplayGuard {
  #consumed = new Map();
  #nextExpirySeconds = Number.POSITIVE_INFINITY;

  constructor({ now = Date.now, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    if (typeof now !== "function") throw new Error("INVALID_VIEWER_TICKET_CLOCK");
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("INVALID_VIEWER_TICKET_CAPACITY");
    this.now = now;
    this.maxEntries = maxEntries;
  }

  get size() {
    return this.#consumed.size;
  }

  consume({ jti, exp }) {
    const nowSeconds = Math.floor(this.now() / 1_000);
    if (nowSeconds >= this.#nextExpirySeconds || this.#consumed.size >= this.maxEntries) {
      this.#removeExpired(nowSeconds);
    }
    if (this.#consumed.has(jti)) return false;
    // Evicting a live replay marker would make that ticket reusable, so the
    // safe behavior at the bound is to reject fresh authentication attempts.
    if (this.#consumed.size >= this.maxEntries) throw new Error("VIEWER_TICKET_CAPACITY");
    this.#consumed.set(jti, exp);
    this.#nextExpirySeconds = Math.min(this.#nextExpirySeconds, exp);
    return true;
  }

  #removeExpired(nowSeconds) {
    let nextExpirySeconds = Number.POSITIVE_INFINITY;
    for (const [jti, expiresAtSeconds] of this.#consumed) {
      if (expiresAtSeconds <= nowSeconds) this.#consumed.delete(jti);
      else nextExpirySeconds = Math.min(nextExpirySeconds, expiresAtSeconds);
    }
    this.#nextExpirySeconds = nextExpirySeconds;
  }
}
