import { z } from "zod";

const sessionSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: z.string(),
});
const pageSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    sessions: z.array(sessionSchema),
    nextOffset: z.number().int().nonnegative().safe().nullable(),
  }),
});

export type HostScreenSession = z.infer<typeof sessionSchema>;

export async function loadHostScreenSessions(fetchPage: typeof fetch, signal: AbortSignal): Promise<HostScreenSession[]> {
  let offset = 0;
  let sessions: HostScreenSession[] = [];
  while (true) {
    signal.throwIfAborted();
    const url = offset === 0 ? "/api/live-sessions?scope=mine" : `/api/live-sessions?scope=mine&offset=${offset}`;
    const response = await fetchPage(url, { method: "GET", cache: "no-store", signal }).catch((error: unknown) => {
      if (signal.aborted) throw error;
      throw new Error("세션 목록을 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.");
    });
    if (response.status === 401) throw new Error("세션을 확인하려면 데스크톱과 같은 계정으로 다시 로그인해 주세요.");
    if (!response.ok) throw new Error("세션 목록을 불러오지 못했습니다. 다시 시도해 주세요.");
    const body: unknown = await response.json().catch(() => {
      throw new Error("세션 목록을 확인할 수 없습니다. 다시 시도해 주세요.");
    });
    const parsed = pageSchema.safeParse(body);
    if (!parsed.success) throw new Error("세션 목록을 확인할 수 없습니다. 다시 시도해 주세요.");
    const { nextOffset } = parsed.data.data;
    const knownIds = new Set(sessions.map((session) => session.id));
    const active = parsed.data.data.sessions.filter((session) => ["preparing", "live", "paused"].includes(session.status));
    sessions = [...sessions, ...active.filter((session) => {
      if (knownIds.has(session.id)) return false;
      knownIds.add(session.id);
      return true;
    })];
    signal.throwIfAborted();
    if (nextOffset === null) return sessions;
    if (nextOffset <= offset) throw new Error("세션 목록의 다음 페이지를 확인할 수 없습니다.");
    offset = nextOffset;
  }
}
