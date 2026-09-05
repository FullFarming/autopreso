import { z } from "zod";

export const speakerRosterEntrySchema = z.object({
  id: z.uuid(), version: z.number().int().positive(), displayName: z.string().trim().min(1).max(40),
  company: z.string().trim().max(80).default(""), department: z.string().trim().max(80).default(""),
  photoAssetId: z.uuid().nullable(), participantId: z.uuid().nullable(),
});
export const speakerRosterSchema = z.object({ sessionId: z.uuid(), revision: z.number().int().nonnegative(),
  appliedRevision: z.number().int().nonnegative(), activeOnsiteSpeakerId: z.uuid().nullable(),
  speakers: z.array(speakerRosterEntrySchema).max(30),
});
export type SpeakerRosterEntry = z.infer<typeof speakerRosterEntrySchema>;
export type SpeakerRoster = z.infer<typeof speakerRosterSchema>;
export function buildSpeakerRosterUpdate(roster: SpeakerRoster) {
  const valid = speakerRosterSchema.parse(roster);
  if (new Set(valid.speakers.map((speaker) => speaker.id)).size !== valid.speakers.length) throw new Error("중복된 발언자가 있습니다.");
  const participantIds = valid.speakers.flatMap((speaker) => speaker.participantId ? [speaker.participantId] : []);
  if (new Set(participantIds).size !== participantIds.length) throw new Error("한 참여자는 한 프로필에만 연결할 수 있습니다.");
  if (valid.activeOnsiteSpeakerId && !valid.speakers.some((speaker) => speaker.id === valid.activeOnsiteSpeakerId)) throw new Error("현장 발언자를 확인해 주세요.");
  return { expectedRevision: valid.revision, speakers: valid.speakers, activeOnsiteSpeakerId: valid.activeOnsiteSpeakerId };
}
export class SpeakerRosterRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = "SpeakerRosterRequestError"; this.status = status; }
}
export function speakerRosterFailureState(error: unknown, state: { roster: SpeakerRoster | null; draft: SpeakerRosterEntry | null; isDirty: boolean }) {
  return error instanceof SpeakerRosterRequestError && [401, 403, 404].includes(error.status)
    ? { roster: null, draft: null, isDirty: false } : state;
}
export async function requestSpeakerRoster(sessionId: string, body?: ReturnType<typeof buildSpeakerRosterUpdate>, signal?: AbortSignal) {
  const response = await fetch(`/api/live-sessions/${z.uuid().parse(sessionId)}/speakers`, { method: body ? "PUT" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined, cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    body: body ? JSON.stringify(body) : undefined });
  const payload: unknown = await response.json().catch(() => null);
  const parsed = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.string().optional() }).safeParse(payload);
  if (!response.ok || !parsed.success || !parsed.data.ok) throw new SpeakerRosterRequestError(response.status === 409 ? "다른 곳에서 수정했습니다. 새로 불러온 뒤 다시 변경해 주세요." : parsed.success ? parsed.data.error ?? "발언자 정보를 불러오지 못했습니다." : "발언자 정보를 불러오지 못했습니다.", response.status);
  const envelope = parsed.data;
  const roster = speakerRosterSchema.parse(envelope.data);
  if (roster.sessionId !== sessionId) throw new Error("회의 정보가 일치하지 않습니다.");
  return roster;
}

export function speakerRosterStatus(roster: Pick<SpeakerRoster, "revision" | "appliedRevision"> | null, isDirty: boolean): string {
  if (isDirty) return "저장하지 않은 변경 사항";
  if (!roster) return "불러오는 중";
  if (roster.revision !== roster.appliedRevision) return "반영 중";
  return roster.revision > 0 ? "반영되었습니다." : "발언자 목록";
}
