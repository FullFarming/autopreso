import { buildSpeakerPhotoUrl } from "../../../../packages/caption-core/speaker-profile.js";
import type { AuthoritativeTranscriptItem } from "../../../lib/live-records/service";

type RecordedSpeaker = Pick<AuthoritativeTranscriptItem,
  "sourceUtteranceId" | "speakerRole" | "speakerLabel" | "speakerName" | "participantId" | "speakerDepartment" | "speakerProfile" | "speakerAttribution">;

export function getRecordSpeakerPresentation(sessionId: string, item: RecordedSpeaker) {
  const isUnresolved = item.speakerAttribution === "unresolved";
  const profile = isUnresolved ? undefined : item.speakerProfile;
  const displayName = isUnresolved ? "" : profile?.displayName || item.speakerName || item.speakerLabel || "";
  const organization = isUnresolved ? "" : profile
    ? [profile.company, profile.department].filter(Boolean).join(" · ") : item.speakerDepartment || "";
  let photoUrl: string | null = null;
  if (profile?.photoAssetId) {
    try { photoUrl = buildSpeakerPhotoUrl(sessionId, profile.photoAssetId); } catch { photoUrl = null; }
  }
  // 2026-09-05 fix: A renamed speaker starts a new visual turn; old rows retain their saved profile version.
  const key = isUnresolved ? `unknown:${item.sourceUtteranceId}`
    : profile ? JSON.stringify(["profile", profile.id, profile.version])
      : item.speakerRole === "unknown" ? `unknown:${item.sourceUtteranceId}`
        : item.participantId ? JSON.stringify(["participant", item.participantId, item.speakerName, item.speakerDepartment])
          : item.speakerRole === "host" ? JSON.stringify(["host", item.speakerLabel, item.speakerName, item.speakerDepartment])
            : `unknown:${item.sourceUtteranceId}`;
  return { key, displayName, organization, photoUrl,
    initials: Array.from(displayName.trim()).slice(0, 2).join("") || "?", isUnresolved };
}
