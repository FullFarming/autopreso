"use client";

// Earnings-call style meeting feed: speaker-attributed turn cards with
// timestamps scrolling above, and the current (partial) utterance rendered
// large in a fixed bottom live sheet. Modeled on the AI earnings-call
// reference (dark card feed + speaker label + time + live caption sheet).

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SpeakerIdentity } from "./SpeakerIdentity";
import type { SpeakerProfile, CaptionEvent } from "@/lib/live-contract";
import { resolveSpeakerColor, speakerMetaLine } from "./SpeakerCaption";

export interface MeetingTurn {
  key: string;
  speakerIdentity: string;
  speakerLabel: string;
  speakerProfile?: SpeakerProfile;
  sessionId?: string;
  speakerColor: string;
  startedAt: string;
  captions: Array<{ seq: number; text: string; isFinal: boolean }>;
}

/** Groups consecutive captions by speaker into turns, newest last. A seq can
 *  arrive first as partial and then as final; the last value wins while its
 *  React key remains unchanged. */
export function groupCaptionsIntoTurns(captions: CaptionEvent[]): MeetingTurn[] {
  const turns: MeetingTurn[] = [];
  for (const caption of captions) {
    const speakerIdentity = caption.speakerProfile ? `${caption.speakerProfile.id}:${caption.speakerProfile.version}` : caption.speaker?.speakerId ?? "host";
    const speakerLabel = speakerMetaLine(caption.speaker, caption.speakerProfile);
    const previous = turns.at(-1);
    const previousCaption = previous?.captions.at(-1);
    if (previous && previous.speakerIdentity === speakerIdentity && previousCaption?.seq === caption.seq) {
      previous.captions[previous.captions.length - 1] = {
        seq: caption.seq,
        text: caption.text,
        isFinal: caption.isFinal,
      };
      continue;
    }
    if (previous && previous.speakerIdentity === speakerIdentity) {
      previous.captions.push({ seq: caption.seq, text: caption.text, isFinal: caption.isFinal });
      continue;
    }
    turns.push({
      key: `turn-${caption.seq}`,
      speakerIdentity,
      speakerLabel, speakerProfile: caption.speakerProfile, sessionId: caption.sessionId,
      speakerColor: resolveSpeakerColor(caption.speaker),
      startedAt: caption.emittedAt,
      captions: [{ seq: caption.seq, text: caption.text, isFinal: caption.isFinal }],
    });
  }
  return turns;
}

/** True when two separate groupings produced the same turn, contents included. */
function isSameTurn(left: MeetingTurn, right: MeetingTurn): boolean {
  if (left.key !== right.key || left.speakerIdentity !== right.speakerIdentity
    || left.speakerLabel !== right.speakerLabel
    || left.speakerColor !== right.speakerColor || left.startedAt !== right.startedAt
    || left.captions.length !== right.captions.length) return false;
  // Sentence strings come straight off the caption objects, so this is a
  // pointer comparison in practice, not a character-by-character one.
  for (let index = 0; index < left.captions.length; index += 1) {
    const leftCaption = left.captions[index];
    const rightCaption = right.captions[index];
    if (leftCaption.seq !== rightCaption.seq || leftCaption.text !== rightCaption.text
      || leftCaption.isFinal !== rightCaption.isFinal) return false;
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
const MeetingTurnCard = memo(function MeetingTurnCard({ turn, recentFromIndex }: {
  turn: MeetingTurn;
  recentFromIndex: number;
}) {
  const hasPartial = turn.captions.some((caption) => !caption.isFinal);
  return (
    <article className={`live-turn-card ${hasPartial ? "is-live" : ""}`}
      data-caption-state={hasPartial ? "updating" : "final"}>
      {/* Plain header, not a control. Folding used to live here, but a speaker
          adding one more sentence then made the paragraph bundle and visibly
          drop text mid-meeting. A live transcript must only ever append; the
          RECORDS view (MeetingMinutes) is where a static transcript can be
          summarised per paragraph and expanded to the full original. */}
      <header>
        <span className="live-speaker-dot" style={{ backgroundColor: turn.speakerColor }} aria-hidden="true" />
        <SpeakerIdentity profile={turn.speakerProfile} sessionId={turn.sessionId} fallback={turn.speakerLabel} />
        <time dateTime={turn.startedAt}>{formatTurnTime(turn.startedAt)}</time>
      </header>
      <p className="live-turn-body">
        {turn.captions.map((caption, captionIndex) => (
          <span key={`caption-${caption.seq}`}
            className={`live-turn-text ${!caption.isFinal || captionIndex >= recentFromIndex ? "is-recent" : ""} ${caption.isFinal ? "" : "is-pending"}`}>
            {caption.text}{" "}
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
  const turns = useStableTurns(captions);
  // Reference-app treatment: everything already read fades to gray; only the
  // two most recently completed sentences stay white.
  const turnOffsets = useMemo(() => {
    const offsets: number[] = [];
    let total = 0;
    for (const turn of turns) {
      offsets.push(total);
      total += turn.captions.filter((caption) => caption.isFinal).length;
    }
    return { offsets, total };
  }, [turns]);
  // The full-strength boundary is global (last two sentences of the whole
  // record), so it can sit inside an older turn. Resolving it to a per-turn
  // sentence index here keeps the global counters out of every card's props:
  // only the one or two cards straddling the boundary see a changed prop, and
  // the rest stay memo-stable.
  const turnRecentFrom = useMemo(() => turns.map((turn, turnIndex) => {
    let finalIndexInTurn = 0;
    for (let captionIndex = 0; captionIndex < turn.captions.length; captionIndex += 1) {
      if (!turn.captions[captionIndex].isFinal) continue;
      const globalIndex = turnOffsets.offsets[turnIndex] + finalIndexInTurn;
      if (globalIndex >= turnOffsets.total - 2) return captionIndex;
      finalIndexInTurn += 1;
    }
    return turn.captions.length;
  }), [turns, turnOffsets]);

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
        {turns.length === 0
          ? <p className="live-empty-caption">{emptyMessage}</p>
          : (
            <>
              {turns.map((turn, turnIndex) => (
                <MeetingTurnCard key={turn.key} turn={turn}
                  recentFromIndex={turnRecentFrom[turnIndex]} />
              ))}
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
