/** Keep the host-owned access lease alive independently of microphone and demand. */
export function createLiveAccessHeartbeat({ getSession, request, onFailure = (_code) => {}, now = Date.now }) {
  let timer = null;
  let owner = null;
  let controller = null;
  let nextRefreshAt = 0;
  let isStopped = false;
  async function tick() {
    const current = getSession();
    const active = current && ["preparing", "live", "paused"].includes(current.status);
    if (!active || current !== owner) {
      controller?.abort();
      controller = null;
      owner = active ? current : null;
      nextRefreshAt = 0;
    }
    if (isStopped || !owner || controller || now() < nextRefreshAt) return;
    const snapshot = owner;
    const pending = new AbortController();
    controller = pending;
    nextRefreshAt = now() + 300_000;
    try {
      const response = await request(snapshot, pending.signal);
      if (isStopped || pending.signal.aborted || getSession() !== snapshot || !["preparing", "live", "paused"].includes(snapshot.status)) return;
      if (!response.ok) { onFailure(response.code); return; }
      if (Number.isSafeInteger(response.data?.version) && response.data.version >= snapshot.version
        && typeof response.data.expiresAt === "string" && Number.isFinite(Date.parse(response.data.expiresAt))) {
        snapshot.version = response.data.version;
        snapshot.expiresAt = response.data.expiresAt;
      }
    } catch { if (!pending.signal.aborted) onFailure("LIVE_ACCESS_RENEWAL_FAILED"); }
    finally { if (controller === pending) controller = null; }
  }
  return {
    start() {
      if (timer || isStopped) return;
      void tick();
      timer = setInterval(() => { void tick(); }, 1000);
      timer.unref?.();
    },
    tick,
    close() { isStopped = true; controller?.abort(); controller = null; if (timer) clearInterval(timer); timer = null; },
  };
}
