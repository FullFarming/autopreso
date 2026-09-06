import { z } from "zod";
import { normalizeSpeakerProfile } from "../../../../packages/caption-core/speaker-profile.js";

const boundedText = (maximum: number, minimum = 0) => z.string().transform(value => value.normalize("NFC").trim())
  .pipe(z.string().min(minimum).max(maximum).regex(/^[^<>\u0000-\u001f\u007f]*$/u));
export const speakerMemberInputSchema = z.object({
  id: z.uuid().transform(value => value.toLowerCase()),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  displayName: boundedText(40, 1),
  company: boundedText(80).default(""), department: boundedText(80).default(""),
  photoAssetId: z.uuid().transform(value => value.toLowerCase()).nullable().default(null),
  participantId: z.uuid().transform(value => value.toLowerCase()).nullable().default(null),
}).strict();
export const speakerRosterReplaceSchema = z.object({
  expectedRevision: z.number().int().min(0).max(2_147_483_647),
  speakers: z.array(speakerMemberInputSchema).max(30),
  activeOnsiteSpeakerId: z.uuid().transform(value => value.toLowerCase()).nullable(),
}).strict().superRefine((value, context) => {
  const ids = value.speakers.map(speaker => speaker.id);
  const participants = value.speakers.flatMap(speaker => speaker.participantId ? [speaker.participantId] : []);
  if (new Set(ids).size !== ids.length || new Set(participants).size !== participants.length) {
    context.addIssue({ code: "custom", message: "발언자 또는 온라인 연결이 중복됩니다." });
  }
  if (value.activeOnsiteSpeakerId && !ids.includes(value.activeOnsiteSpeakerId)) {
    context.addIssue({ code: "custom", message: "등록된 발언자를 선택하세요." });
  }
});
export type SpeakerRosterReplace = z.infer<typeof speakerRosterReplaceSchema>;
export const speakerRosterStateSchema = z.object({
  sessionId: z.uuid(), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  appliedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  activeOnsiteSpeakerId: z.uuid().nullable(),
  speakers: z.array(speakerMemberInputSchema.extend({ version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
    .transform(member => ({ ...normalizeSpeakerProfile(member), participantId: member.participantId }))).max(30),
}).refine(state => state.appliedRevision <= state.revision);
export type SpeakerRosterState = z.infer<typeof speakerRosterStateSchema>;
