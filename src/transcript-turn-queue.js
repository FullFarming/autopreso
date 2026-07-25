// A turn that never settles (a hung LLM/network call with no timeout of its
// own) must not jam the queue forever: past this, the queue moves on to the
// buffered chunks. The late turn's result is discarded by the caller's own
// session guards. Generous by default — real agent turns can take minutes.
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
// While a turn runs, overflow chunks are buffered for the next turn. Bound the
// buffer so a stalled turn can't grow it (and the next turn's prompt) without
// limit — keep only the most recent chunks.
const DEFAULT_MAX_BUFFERED_CHUNKS = 200;

export function createTranscriptTurnQueue({
  runTurn,
  debounceMs = 150,
  isReady = (_text) => true,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  maxBufferedChunks = DEFAULT_MAX_BUFFERED_CHUNKS,
  log = console,
}) {
  let running = false;
  let buffered = [];
  let current = Promise.resolve();
  // Pending bucket holds chunks that arrived too recently to fire yet. Waiting
  // a short window lets bursts of small transcript chunks coalesce into one
  // turn. The isReady predicate gates whether the accumulated buffer has
  // enough substantive content to actually fire - if not, we keep accumulating
  // until the next chunk arrives.
  let pending = [];
  let debounceTimer = null;

  function flushPending({ force = false } = {}) {
    debounceTimer = null;
    if (pending.length === 0) return;
    const text = pending.join("\n");
    if (!force && !isReady(text)) {
      // Not enough content yet - keep pending, wait for more chunks. The next
      // enqueue will restart the debounce timer and we'll re-check then.
      return;
    }
    pending = [];
    if (running) {
      buffered.push(text);
      if (buffered.length > maxBufferedChunks) {
        buffered.splice(0, buffered.length - maxBufferedChunks);
      }
    } else {
      current = drain(text);
    }
  }

  // Bound a single turn's wall-clock so a hung runTurn can never leave the
  // queue `running` forever (every later chunk would buffer and nothing would
  // ever fire again — the "queue piles up and everything stops" stall). The
  // timed-out turn keeps running in the background; its late effects are the
  // caller's session guards' problem, but the QUEUE recovers.
  async function runTurnBounded(text) {
    // runTurn MUST start synchronously (callers capture per-session state at
    // the moment the turn begins — deferring even a microtask changes which
    // session a turn observes).
    const turn = Promise.resolve(runTurn(text));
    if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0) return turn;
    // A late rejection after the timeout won loses the race and would otherwise
    // become an unhandled rejection — observe it on a side branch.
    turn.catch(() => {});
    let timer = null;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => {
        log.warn?.(`[turn-queue] turn did not settle within ${turnTimeoutMs}ms; continuing with buffered transcript`);
        resolve();
      }, turnTimeoutMs);
    });
    try {
      await Promise.race([turn, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function drain(text) {
    running = true;
    try {
      await runTurnBounded(text);
    } finally {
      if (buffered.length > 0) {
        const next = buffered.join("\n");
        buffered = [];
        current = drain(next);
      } else {
        running = false;
        // If pending arrived during the turn and is now ready, flush it. If
        // it's still not ready (only fillers), leave it accumulating.
        if (pending.length > 0) {
          if (debounceTimer) clearTimeout(debounceTimer);
          flushPending();
        }
      }
    }
  }

  function enqueue(text) {
    const trimmed = text.trim();
    if (!trimmed) return current;
    pending.push(trimmed);
    if (debounceMs > 0) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushPending, debounceMs);
    } else {
      flushPending();
    }
    return current;
  }

  async function idle() {
    // Force-flush any pending content (bypassing isReady) so idle() always
    // terminates - tests and shutdown paths shouldn't hang on a buffer that
    // happens to contain only fillers.
    while (debounceTimer || running || buffered.length > 0 || pending.length > 0) {
      if (debounceTimer || pending.length > 0) {
        if (debounceTimer) clearTimeout(debounceTimer);
        flushPending({ force: true });
      }
      await current;
    }
  }

  return { enqueue, idle };
}
