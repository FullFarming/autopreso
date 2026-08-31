"use client";

import { CircleNotch, Record, Stop } from "@phosphor-icons/react";
import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { viewerMessages } from "@/lib/system-language/viewer-messages";

interface ParticipantSpeakButtonProps {
  state: "idle" | "starting" | "speaking";
  disabled?: boolean;
  onClick: () => void;
}

export function ParticipantSpeakButton({ state, disabled = false, onClick }: ParticipantSpeakButtonProps) {
  const t = useSystemText(viewerMessages);
  const Icon = state === "speaking" ? Stop : state === "starting" ? CircleNotch : Record;
  return <button type="button" className="live-speak-trigger viewer-microphone-capsule"
    data-speak-state={state} disabled={disabled} aria-pressed={state !== "idle"} aria-busy={state === "starting"}
    aria-label={t(state === "speaking" ? "발언 종료" : state === "starting" ? "발언 연결 중" : "발언 시작")}
    onClick={onClick}>
    <Icon key={state} size={32} weight={state === "speaking" ? "fill" : "regular"} aria-hidden="true" />
  </button>;
}
