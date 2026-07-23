"use client";

// Design-preview route: renders the mobile live viewer with mock data so the
// pure-black feed can be reviewed without a running session. No auth, no
// network — static mock captions only.

import { ViewerStage } from "@/components/live/LiveViewer";
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
    type: "caption", seq, sessionId: "demo", language: "ko", speaker: who, text, isFinal,
    sourceEndedAt: new Date(1_784_000_000_000 + seq * 45_000).toISOString(),
    emittedAt: new Date(1_784_000_000_000 + seq * 45_000).toISOString(),
  };
}

const noel = speaker(0, "김노엘");
const james = speaker(1, "James");
const host = speaker(2, "운영자");

const MOCK_CAPTIONS: CaptionEvent[] = [
  caption(1, host, "안녕하세요, 여러분. 오늘 2분기 실적 발표 컨퍼런스 콜에 오신 것을 환영합니다."),
  caption(2, host, "먼저 안전 항구 조항에 대해 간단히 말씀드리겠습니다. 오늘 전달하는 내용 중 일부는 미래 예측 진술일 수 있습니다."),
  caption(3, james, "감사합니다. 이번 분기 매출은 AI 수요와 클라우드 성장에 힘입어 전년 대비 24% 증가했습니다."),
  caption(4, james, "특히 보안 플랫폼이 분석하는 AI 워크로드 수는 분기별로 45% 이상 증가하는 성장세를 보이고 있습니다."),
  caption(5, noel, "질문 기회를 주셔서 감사합니다. 두 가지 여쭙고 싶은데요, 하나는 생성형 AI 투자수익률 기회에 관한 것입니다."),
  caption(6, noel, "2027년 용량 제약 해소를 위한 자본적지출 예산 원칙은 어떻게 바뀌는지 궁금합니다.", false),
];

export default function MobileWatchDemoPage() {
  return (
    <main className="live-viewer-shell is-compact">
      <header className="glass-pill live-viewer-toolbar">
        <strong>Realtime Noel</strong>
        <div className="live-language-switch" role="group" aria-label="자막 언어 선택">
          <button type="button" className="is-selected" aria-pressed>한국어</button>
          <button type="button">EN</button>
        </div>
      </header>
      <ViewerStage sessionType="meeting" outputMode="captions" captions={MOCK_CAPTIONS}
        speakers={[host, james, noel]} status="실시간 연결" isAudioEnabled={false} floorHolder="김노엘" />
      <div className="live-speak-bar">
        <span className="live-floor-indicator"><span className="live-speaking-waves" aria-hidden="true"><i /><i /><i /></span>김노엘 발언 중</span>
        <button type="button" className="live-speak-button">🎙 발언하기</button>
      </div>
      <footer className="live-viewer-footer"><span>김노엘 · 12/50명 접속</span><span>만료 19:30</span></footer>
    </main>
  );
}
