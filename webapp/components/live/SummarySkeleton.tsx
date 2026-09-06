"use client";

// The post-meeting summary takes tens of seconds to generate. A skeleton of
// the card that is coming reads as progress toward a known shape, where three
// bouncing dots read as an indefinite wait. Callers localize the copy; this
// component owns only the shape and the motion.

const OVERVIEW_LINES = ["is-full", "is-short"] as const;
const CHAPTER_LINES = [0, 1, 2] as const;

export default function SummarySkeleton({
  label,
  elapsedLabel,
}: {
  label: string;
  elapsedLabel?: string;
}) {
  return (
    <div className="live-minutes-loading" role="status" aria-live="polite" aria-label={label}>
      <strong>{label}</strong>
      {elapsedLabel ? <span className="live-minutes-elapsed">{elapsedLabel}</span> : null}
      {/* Decorative: the label above already announces what is happening. */}
      <div className="live-summary-skeleton" aria-hidden="true">
        <span className="live-summary-skeleton-title" />
        {OVERVIEW_LINES.map((width) => (
          <span key={width} className={`live-summary-skeleton-line ${width}`} />
        ))}
        {CHAPTER_LINES.map((index) => (
          <span key={index} className="live-summary-skeleton-chapter" />
        ))}
      </div>
    </div>
  );
}
