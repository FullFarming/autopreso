import type { CaptionEvent, SpeakerAssignment } from "@/lib/live-contract";

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

export default function SpeakerCaption({ caption, active = false }: { caption: CaptionEvent; active?: boolean }) {
  const color = resolveSpeakerColor(caption.speaker);
  const speaker = caption.speaker;
  const label = speaker ? speaker.label : "발표자";

  return (
    <article
      className={`live-caption-card ${active ? "is-active" : ""} ${caption.isFinal ? "" : "is-partial"}`}
      aria-label={`${label} 자막${caption.isFinal ? "" : ", 작성 중"}`}
    >
      <div className="live-caption-speaker">
        <span className="live-speaker-dot" style={{ backgroundColor: color }} aria-hidden="true" />
        <span>{label}</span>
        <span className="live-speaker-line" style={{ backgroundColor: color }} aria-hidden="true" />
        {!caption.isFinal && <span className="live-caption-state">듣는 중</span>}
      </div>
      <p>{caption.text}</p>
    </article>
  );
}
