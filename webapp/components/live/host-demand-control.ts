export interface HostMediaRuntime {
  enabled: boolean;
  state?: "sleeping" | "waking" | "active" | "draining" | "failed" | "ended";
  epoch?: number;
  hostSourceReady?: boolean;
  hasDemand?: boolean;
}

export interface HostDemandControl {
  read(): Promise<HostMediaRuntime>;
  setSourceReady(ready: boolean): Promise<void>;
  retryStart(): Promise<void>;
}

export function canConnectHostMedia(runtime: HostMediaRuntime): boolean {
  return !runtime.enabled || (runtime.hostSourceReady === true && runtime.hasDemand === true
    && (runtime.state === "waking" || runtime.state === "active"));
}

export function createHostDemandControl(sessionId: string, request: typeof fetch = fetch): HostDemandControl {
  let sourceGeneration = crypto.randomUUID();
  let lastReady: boolean | null = null;
  let lastHeartbeatAt = 0;
  let sourceFlight: Promise<void> = Promise.resolve();
  const base = `/api/live-sessions/${encodeURIComponent(sessionId)}`;
  const readEnvelope = async (response: Response): Promise<Record<string, unknown>> => {
    const value: unknown = await response.json();
    if (!response.ok || !value || typeof value !== "object" || !("ok" in value) || value.ok !== true
      || !("data" in value) || !value.data || typeof value.data !== "object") {
      throw new Error("참여자 연결 상태를 확인하지 못했습니다. 다시 연결해 주세요.");
    }
    return value.data as Record<string, unknown>;
  };
  return {
    async retryStart() {
      const current = await readEnvelope(await request(base, {
        method: "GET", cache: "no-store", signal: AbortSignal.timeout(10_000),
      }));
      if (current.id !== sessionId || !Number.isSafeInteger(current.version)
        || (current.status !== "preparing" && current.status !== "live")) {
        throw new Error("현재 회의의 재시작 상태를 확인하지 못했습니다.");
      }
      const started = await readEnvelope(await request(`${base}/start`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: current.version, demandEnabled: true }),
        signal: AbortSignal.timeout(10_000),
      }));
      if (started.sessionId !== sessionId || !started.runtime || typeof started.runtime !== "object"
        || !("enabled" in started.runtime) || started.runtime.enabled !== true) {
        throw new Error("참여자 대기 기능의 재시작을 확인하지 못했습니다.");
      }
    },
    async read() {
      const data = await readEnvelope(await request(`${base}/runtime`, {
        method: "GET", cache: "no-store", signal: AbortSignal.timeout(10_000),
      }));
      if (data.enabled === false) return { enabled: false };
      if (data.enabled !== true || typeof data.state !== "string"
        || !["sleeping", "waking", "active", "draining", "failed", "ended"].includes(data.state)
        || typeof data.hasDemand !== "boolean" || typeof data.hostSourceReady !== "boolean") {
        throw new Error("참여자 연결 상태 응답이 올바르지 않습니다.");
      }
      return { enabled: true, state: data.state as HostMediaRuntime["state"],
        hostSourceReady: data.hostSourceReady, hasDemand: data.hasDemand };
    },
    async setSourceReady(ready) {
      // Release follows any in-flight heartbeat. Cleanup remains possible
      // after an error, but the failed request still rejects its own caller.
      const pending = sourceFlight.catch(() => undefined).then(async () => {
        if (lastReady === ready && Date.now() - lastHeartbeatAt < 15_000) return;
        if (ready && lastReady === false) sourceGeneration = crypto.randomUUID();
        // A release may commit even when its response is lost. Never let the
        // next capture heartbeat reuse a potentially tombstoned generation.
        if (!ready) { lastReady = false; lastHeartbeatAt = 0; }
        await readEnvelope(await request(`${base}/host-source`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceGeneration, sourceReady: ready }),
          signal: AbortSignal.timeout(10_000),
        }));
        lastReady = ready;
        lastHeartbeatAt = Date.now();
      });
      sourceFlight = pending;
      await pending;
    },
  };
}
