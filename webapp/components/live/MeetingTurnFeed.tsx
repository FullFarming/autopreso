"use client";

// Earnings-call style meeting feed: speaker-attributed turn cards with
// timestamps scrolling above, and the current (partial) utterance rendered
// large in a fixed bottom live sheet. Modeled on the AI earnings-call
// reference (dark card feed + speaker label + time + live caption sheet).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CaptionEvent } from "@/lib/live-contract";
import { resolveSpeakerColor } from "./SpeakerCaption";

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
    const speakerLabel = caption.speaker?.label ?? "발표자";
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

function formatTurnTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export default function MeetingTurnFeed({ captions, floorHolder, emptyMessage }: {
  captions: CaptionEvent[];
  floorHolder: string | null;
  emptyMessage: string;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  const [isPinnedToLatest, setIsPinnedToLatest] = useState(true);
  const turns = useMemo(() => groupCaptionsIntoTurns(captions), [captions]);
  const partials = captions.filter((caption) => !caption.isFinal);
  const livePartial = partials.at(-1) ?? null;

  const scrollToLatest = useCallback(() => {
    const feed = feedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
    setIsPinnedToLatest(true);
  }, []);

  useEffect(() => {
    if (isPinnedToLatest) {
      const feed = feedRef.current;
      if (feed) feed.scrollTop = feed.scrollHeight;
    }
  }, [turns.length, livePartial?.text, isPinnedToLatest]);

  const handleScroll = useCallback(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const distanceFromBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    setIsPinnedToLatest(distanceFromBottom < 48);
  }, []);

  return (
    <div className="live-meeting-feed">
      <div ref={feedRef} className="live-turn-scroll" onScroll={handleScroll} aria-live="polite" aria-relevant="additions">
        {turns.length === 0 && !livePartial
          ? <p className="live-empty-caption">{emptyMessage}</p>
          : turns.map((turn) => (
            <article key={turn.key} className="live-turn-card">
              <header>
                <span className="live-speaker-dot" style={{ backgroundColor: turn.speakerColor }} aria-hidden="true" />
                <strong>{turn.speakerLabel}</strong>
                <time dateTime={turn.startedAt}>{formatTurnTime(turn.startedAt)}</time>
              </header>
              <p>{turn.texts.join(" ")}</p>
            </article>
          ))}
      </div>
      {!isPinnedToLatest && (
        <button type="button" className="live-jump-latest" onClick={scrollToLatest}>
          최신 발언으로 ↓
        </button>
      )}
      {(livePartial || floorHolder) && (
        <div className="live-now-sheet" aria-live="off">
          <div className="live-now-speaker">
            {floorHolder
              ? <><span className="live-speaking-waves" aria-hidden="true"><i /><i /><i /></span><strong>{floorHolder}</strong><span>발언 중</span></>
              : livePartial
                ? <><span className="live-speaker-dot" style={{ backgroundColor: resolveSpeakerColor(livePartial.speaker) }} aria-hidden="true" /><strong>{livePartial.speaker?.label ?? "발표자"}</strong><span>말하는 중</span></>
                : null}
          </div>
          {livePartial && <p className="live-now-text">{livePartial.text}</p>}
        </div>
      )}
    </div>
  );
}
