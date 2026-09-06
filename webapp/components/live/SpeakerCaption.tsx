import { SpeakerIdentity } from "./SpeakerIdentity";
import type { SpeakerProfile, CaptionEvent, SpeakerAssignment } from "@/lib/live-contract";

const SPEAKER_COLORS = ["#1D1740", "#0093AD", "#F1B434", "#007C58", "#8E1000", "#545859"] as const;

function hashSpeaker(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

export function resolveSpeakerColor(speaker: SpeakerAssignment | null): string {
  if (!speaker) return "#545859";
  const tokenIndex = Number.parseInt(speaker.colorToken.replace(/\D/g, ""), 10);
  const index = Number.isFinite(tokenIndex) ? tokenIndex : hashSpeaker(speaker.speakerId);
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
}

/* Papago's 10-colour speaker rotation (DESIGN.md §5.5), adjusted for the dark
 * viewer surface: every value holds ≥4.5:1 on #14141A so a 13px speaker name
 * stays WCAG AA. #3652EE from the original rotation fails on dark and is
 * replaced by its lightened variant #8FA1FF. */
const VIEWER_SPEAKER_COLORS = [
  "#FF9448", "#4F9EFF", "#54D089", "#EF6262", "#A883FF",
  "#F383FF", "#C5A700", "#89A100", "#66C9EB", "#8FA1FF",
] as const;

export function resolveViewerSpeakerColor(speaker: SpeakerAssignment | null): string | undefined {
  if (!speaker) return undefined;
  const tokenIndex = Number.parseInt(speaker.colorToken.replace(/\D/g, ""), 10);
  const index = Number.isFinite(tokenIndex) ? tokenIndex : hashSpeaker(speaker.speakerId);
  return VIEWER_SPEAKER_COLORS[index % VIEWER_SPEAKER_COLORS.length];
}

/** Contract C5: gray caption meta — name · department · job title when the
 *  gateway attributes the caption to a participant identity. Everything not
 *  attributed to a floor participant is the host microphone, so it reads as
 *  "Host" instead of leaking raw diarization labels (S1, S2…). */
export function speakerMetaLine(speaker: SpeakerAssignment | null, profile?: SpeakerProfile): string {
  if (profile) return [profile.displayName, profile.company, profile.department].filter(Boolean).join(" · ");
  if (!speaker) return "Host";
  if (!speaker.speakerId.startsWith("participant:")) return "Host";
  const name = speaker.name?.trim() || "Participant";
  return [name, speaker.department?.trim(), speaker.jobTitle?.trim()]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

export default function SpeakerCaption({ caption, active = false }: { caption: CaptionEvent; active?: boolean }) {
  const color = resolveSpeakerColor(caption.speaker);
  const speaker = caption.speaker;
  const label = speakerMetaLine(speaker, caption.speakerProfile);

  return (
    <article
      className={`live-caption-card ${active ? "is-active" : ""} ${caption.isFinal ? "" : "is-partial"}`}
      data-caption-seq={caption.seq}
      aria-label={`${label} caption${caption.isFinal ? "" : ", updating"}`}
    >
      <div className="live-caption-speaker">
        <span className="live-speaker-dot" style={{ backgroundColor: color }} aria-hidden="true" />
        <SpeakerIdentity profile={caption.speakerProfile} sessionId={caption.sessionId} fallback={label} />
        <span className="live-speaker-line" style={{ backgroundColor: color }} aria-hidden="true" />
        {!caption.isFinal && <span className="live-caption-state">Listening</span>}
      </div>
      <p>{caption.text}</p>
    </article>
  );
}
