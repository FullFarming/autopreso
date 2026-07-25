"use client";

// Earnings-call style meeting feed: speaker-attributed turn cards with
// timestamps scrolling above, and the current (partial) utterance rendered
// large in a fixed bottom live sheet. Modeled on the AI earnings-call
// reference (dark card feed + speaker label + time + live caption sheet).

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CaptionEvent } from "@/lib/live-contract";
import { resolveSpeakerColor, speakerMetaLine } from "./SpeakerCaption";

export interface MeetingTurn {
  key: string;
  speakerLabel: string;
  speakerColor: string;
  startedAt: string;
  texts: string[];
}

/** Groups consecutive final captions by speaker into turns, newest last. */
export function groupCaptionsIntoTurns(captions: CaptionEvent[]): MeetingTurn[] {
  const turns: MeetingTurn[] = [];
  for (const caption of captions) {
    if (!caption.isFinal) continue;
    const speakerLabel = speakerMetaLine(caption.speaker);
    const previous = turns.at(-1);
    if (previous && previous.speakerLabel === speakerLabel) {
      previous.texts.push(caption.text);
      continue;
    }
    turns.push({
      key: `turn-${caption.seq}`,
      speakerLabel,
      speakerColor: resolveSpeakerColor(caption.speaker),
      startedAt: caption.emittedAt,
      texts: [caption.text],
    });
  }
  return turns;
}

/** True when two separate groupings produced the same turn, contents included. */
function isSameTurn(left: MeetingTurn, right: MeetingTurn): boolean {
  if (left.key !== right.key || left.speakerLabel !== right.speakerLabel
    || left.speakerColor !== right.speakerColor || left.startedAt !== right.startedAt
    || left.texts.length !== right.texts.length) return false;
  // Sentence strings come straight off the caption objects, so this is a
  // pointer comparison in practice, not a character-by-character one.
  for (let index = 0; index < left.texts.length; index += 1) {
    if (left.texts[index] !== right.texts[index]) return false;
  }
  return true;
}

/**
 * groupCaptionsIntoTurns allocates fresh turn objects every time it runs, and a
 * streaming partial makes it run ~20x a second. A memo()'d card would still see
 * a brand-new `turn` prop on each of those runs, so nothing would be skipped.
 * Reusing the previous object whenever the turn is unchanged makes the props
 * identity-stable, which is what lets memo bail out on every historical card
 * and re-render only the turn that actually grew.
 */
function useStableTurns(captions: CaptionEvent[]): MeetingTurn[] {
  const previousRef = useRef<MeetingTurn[]>([]);
  return useMemo(() => {
    const grouped = groupCaptionsIntoTurns(captions);
    const previousByKey = new Map(previousRef.current.map((turn) => [turn.key, turn]));
    // Keyed, not index-aligned: the caption model is trimmed from the front, so
    // positions shift while keys do not.
    const stable = grouped.map((turn) => {
      const previous = previousByKey.get(turn.key);
      return previous && isSameTurn(previous, turn) ? previous : turn;
    });
    previousRef.current = stable;
    return stable;
  }, [captions]);
}

export function formatTurnTime(iso: string): string {
  // 2026-07-24 fix: Use the fixed KST session clock. Locale output and host
  // time zones previously produced different SSR/client text and hydration #418.
  const normalizedIso = /(?:Z|[+-]\d{2}:\d{2})$/u.test(iso) ? iso : `${iso}Z`;
  const timestamp = Date.parse(normalizedIso);
  if (!Number.isFinite(timestamp)) return "";
  const kstTime = new Date(timestamp + (9 * 60 * 60 * 1_000));
  const hours = String(kstTime.getUTCHours()).padStart(2, "0");
  const minutes = String(kstTime.getUTCMinutes()).padStart(2, "0");
  const seconds = String(kstTime.getUTCSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * One speaker paragraph, memoised. A two-hour call leaves hundreds of these in
 * the record while a streaming partial re-renders the feed ~20x a second; memo
 * keeps that work proportional to what changed (the growing turn) instead of to
 * the length of the meeting. Every prop is a primitive or an identity-stable
 * object (see useStableTurns) so the default shallow comparison is enough.
 */
const MeetingTurnCard = memo(function MeetingTurnCard({ turn, isCollapsed, recentFromIndex, onToggle }: {
  turn: MeetingTurn;
  isCollapsed: boolean;
  recentFromIndex: number;
  onToggle: (key: string) => void;
}) {
  const bodyId = `${turn.key}-body`;
  return (
    <article className={`live-turn-card ${isCollapsed ? "is-collapsed" : ""}`}>
      <header>
        {/* The whole header is the fold control: a speaker paragraph is the
            natural unit to collapse, and the header is the only part that
            stays visible when it is folded. */}
        <button type="button" className="live-turn-toggle"
          aria-expanded={!isCollapsed} aria-controls={bodyId}
          onClick={() => onToggle(turn.key)}>
          <span className="live-speaker-dot" style={{ backgroundColor: turn.speakerColor }} aria-hidden="true" />
          <strong>{turn.speakerLabel}</strong>
          <time dateTime={turn.startedAt}>{formatTurnTime(turn.startedAt)}</time>
          <span className="live-turn-count">{turn.texts.length}</span>
          <span className="live-turn-chevron" aria-hidden="true" />
        </button>
      </header>
      {/* Collapsed clamps rather than unmounts, so the text stays in the DOM
          for browser find and copy. */}
      <p id={bodyId} className="live-turn-body">
        {turn.texts.map((text, textIndex) => (
          <span key={`${turn.key}-${textIndex}`}
            className={`live-turn-text ${textIndex >= recentFromIndex ? "is-recent" : ""}`}>
            {text}{" "}
          </span>
        ))}
      </p>
    </article>
  );
});

export default function MeetingTurnFeed({ captions, floorHolder, emptyMessage }: {
  captions: CaptionEvent[];
  floorHolder: string | null;
  emptyMessage: string;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isPinnedToLatest, setIsPinnedToLatest] = useState(true);
  const isPinnedRef = useRef(true);
  isPinnedRef.current = isPinnedToLatest;
  // Collapsed paragraphs, keyed by turn. A Live Call runs for hours, so a
  // speaker's turn can grow to dozens of sentences; folding one lets a reader
  // skim who spoke when without scrolling through the whole thing. Keyed by
  // turn.key (the turn's first caption seq), which is stable while the turn
  // keeps growing, so a fold survives every re-render and new caption.
  const [collapsedTurnKeys, setCollapsedTurnKeys] = useState<ReadonlySet<string>>(new Set());
  const toggleTurnCollapsed = useCallback((key: string) => {
    setCollapsedTurnKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const turns = useStableTurns(captions);
  // Reference-app treatment: everything already read fades to gray; only the
  // two most recently completed sentences stay white.
  const turnOffsets = useMemo(() => {
    const offsets: number[] = [];
    let total = 0;
    for (const turn of turns) {
      offsets.push(total);
      total += turn.texts.length;
    }
    return { offsets, total };
  }, [turns]);
  // The full-strength boundary is global (last two sentences of the whole
  // record), so it can sit inside an older turn. Resolving it to a per-turn
  // sentence index here keeps the global counters out of every card's props:
  // only the one or two cards straddling the boundary see a changed prop, and
  // the rest stay memo-stable.
  const turnRecentFrom = useMemo(() => turns.map((turn, turnIndex) => {
    for (let textIndex = 0; textIndex < turn.texts.length; textIndex += 1) {
      const globalIndex = turnOffsets.offsets[turnIndex] + textIndex;
      if (globalIndex >= turnOffsets.total - 2) return textIndex;
    }
    return turn.texts.length;
  }), [turns, turnOffsets]);
  // The in-progress utterance renders INSIDE the main record as the newest
  // paragraph (speaker-attributed) — the mic-button sheet never duplicates
  // caption text; it only signals who currently holds the floor. Scanned from
  // the tail rather than filtered: the record holds thousands of captions and
  // this runs on every streaming update.
  const livePartial = useMemo(() => {
    for (let index = captions.length - 1; index >= 0; index -= 1) {
      if (!captions[index].isFinal) return captions[index];
    }
    return null;
  }, [captions]);

  // Writing scrollTop needs scrollHeight read back, and that read is a forced
  // synchronous layout anywhere the DOM is still dirty — measured at ~0.5ms per
  // read from a post-commit effect on a two-hour record. The ResizeObserver
  // below runs AFTER layout, so the same read there is free, which is why it is
  // the only caller on the per-caption path. The guard then skips the write
  // whenever the reader is already parked at the live edge, which also skips the
  // scroll event it would fire and that handler's own three layout reads.
  const pinToLatest = useCallback(() => {
    const feed = feedRef.current;
    if (!feed || !isPinnedRef.current) return;
    if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 1) return;
    feed.scrollTop = feed.scrollHeight;
  }, []);

  const scrollToLatest = useCallback(() => {
    // Direct, not deferred: this is a tap, and it must land in the same frame.
    const feed = feedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
    setIsPinnedToLatest(true);
  }, []);

  // Returning to the live edge re-pins. Deliberately keyed on the pin flag
  // alone: content growth is the ResizeObserver's job below, and running this
  // effect per caption instead was ~20 forced layouts a second.
  useEffect(() => {
    if (isPinnedToLatest) pinToLatest();
  }, [isPinnedToLatest, pinToLatest]);

  // Any content growth — streaming partials, a new speaker paragraph, or the
  // Aa text-size toggle reflowing every line — re-pins the scroll so the
  // newest words never slide out of view or hide behind the Speak bar. The
  // observer also coalesces for free: it delivers at most once per frame, after
  // layout, so a burst of partials costs one read and one write.
  useEffect(() => {
    const feed = feedRef.current;
    const content = contentRef.current;
    if (!feed || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (isPinnedRef.current) pinToLatest();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [pinToLatest]);

  const handleScroll = useCallback(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const distanceFromBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    setIsPinnedToLatest(distanceFromBottom < 48);
  }, []);

  return (
    <div className="live-meeting-feed">
      <div ref={feedRef} className="live-turn-scroll" onScroll={handleScroll} aria-live="polite" aria-relevant="additions">
        <div ref={contentRef} className="live-turn-scroll-content">
        {turns.length === 0 && !livePartial
          ? <p className="live-empty-caption">{emptyMessage}</p>
          : (
            <>
              {turns.map((turn, turnIndex) => (
                <MeetingTurnCard key={turn.key} turn={turn}
                  isCollapsed={collapsedTurnKeys.has(turn.key)}
                  recentFromIndex={turnRecentFrom[turnIndex]}
                  onToggle={toggleTurnCollapsed} />
              ))}
              {livePartial && (
                <article className="live-turn-card is-live" data-caption-state="updating">
                  <header>
                    <span className="live-speaker-dot" style={{ backgroundColor: resolveSpeakerColor(livePartial.speaker) }} aria-hidden="true" />
                    <strong>{speakerMetaLine(livePartial.speaker)}</strong>
                    <span className="live-speaking-waves" aria-hidden="true"><i /><i /><i /></span>
                  </header>
                  <p><span className="live-turn-text is-recent">{livePartial.text}</span></p>
                </article>
              )}
            </>
          )}
        </div>
      </div>
      {!isPinnedToLatest && (
        <button type="button" className="live-jump-latest" onClick={scrollToLatest}>
          Jump to latest
        </button>
      )}
      {floorHolder && (
        /* Floor indicator only — caption text lives exclusively in the main
           record above; repeating it here duplicated every line. */
        <div className="live-now-sheet is-collapsed" aria-live="off">
          <div className="live-now-speaker">
            <span className="live-speaking-waves" aria-hidden="true"><i /><i /><i /></span>
            <strong>{floorHolder}</strong>
            <span>is speaking</span>
          </div>
        </div>
      )}
    </div>
  );
}
