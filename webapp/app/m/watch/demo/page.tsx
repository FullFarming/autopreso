"use client";

// Design-preview route: renders the mobile live viewer with mock data so the
// pure-black feed can be reviewed without a running session. No auth, no
// network — static mock captions only.

import { SpeakControlIcon, ViewerSessionContext, ViewerStage } from "@/components/live/LiveViewer";
import type { CaptionEvent, SpeakerAssignment } from "@/lib/live-contract";

function speaker(id: number, label: string): SpeakerAssignment {
  return {
    speakerId: `speaker-${id}`,
    label,
    colorToken: ["speaker-blue", "speaker-red", "speaker-green"][id % 3],
    voiceName: null,
    voiceStatus: "disabled",
    lastSeenAt: "2026-07-23T04:00:00Z",
  };
}

function caption(seq: number, who: SpeakerAssignment | null, text: string, isFinal = true): CaptionEvent {
  return {
    type: "caption", seq, sessionId: "demo", language: "en", speaker: who, text, isFinal,
    sourceEndedAt: new Date(1_784_000_000_000 + seq * 45_000).toISOString(),
    emittedAt: new Date(1_784_000_000_000 + seq * 45_000).toISOString(),
  };
}

const noel = speaker(0, "Noel Kim");
const james = speaker(1, "James");
const host = speaker(2, "Host");

const MOCK_CAPTIONS: CaptionEvent[] = [
  caption(1, host, "Good afternoon. Welcome to our second-quarter earnings call."),
  caption(2, james, "Revenue increased 24 percent year over year, led by AI demand and continued cloud growth."),
  caption(3, noel, "Thank you. I would like to understand the return profile of your generative AI investments."),
  caption(4, noel, "How are your capital allocation principles changing through 2027?", false),
];

export default function MobileWatchDemoPage() {
  return (
    <main className="live-viewer-shell is-compact">
      <header className="glass-pill live-viewer-toolbar">
        <strong>NOVA</strong>
        <button type="button" className="live-leave-button" aria-label="Leave meeting">Leave</button>
      </header>
      <ViewerSessionContext title="Q2 2026 Earnings Call" scheduledAt="2026-07-23T14:00:00+09:00" />
      {/* Mirrors LiveViewer: reading controls sit below the title, directly above
          the caption record, and no translated-audio control is surfaced. */}
      <div className="live-caption-controls">
        <div className="live-language-switch" role="group" aria-label="Caption language">
          <button type="button" className="is-selected" aria-pressed>EN</button>
          <button type="button">KO</button>
        </div>
        <div className="live-text-size">
          <button type="button" className="live-text-size-button" aria-expanded="false"
            aria-controls="live-caption-scale" aria-label="Caption text size">Aa</button>
          <label className="live-text-size-slider" hidden>
            <span className="sr-only">Caption text size</span>
            <input id="live-caption-scale" type="range" min={1} max={2} step={0.1} defaultValue={1} />
          </label>
        </div>
      </div>
      <ViewerStage sessionType="meeting" outputMode="captions" captions={MOCK_CAPTIONS}
        speakers={[host, james, noel]} status="Connected · live captions" sessionStatus="live"
        isAudioEnabled={false} floorHolder="Noel Kim" />
      <div className="live-speak-bar is-speaking">
        <span className="live-floor-indicator is-idle">Your turn is live until someone else takes over.</span>
        <button type="button" className="live-speak-button is-speaking" aria-pressed="true" aria-disabled="true"
          aria-label="Speaking. Your turn stays active until another participant or the host takes over."
          data-level="4">
          <SpeakControlIcon state="speaking" />
        </button>
      </div>
      <footer className="live-viewer-footer"><span>Noel Kim · 12/50 joined</span><span>Valid until the host ends this session</span></footer>
    </main>
  );
}
