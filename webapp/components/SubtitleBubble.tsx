"use client";

import { LANGUAGE_LABELS, type LanguageCode } from "@/lib/languageDetect";
import type { AudioSource } from "@/lib/types";

const SOURCE_LABELS: Record<AudioSource, string> = {
  mic: "마이크",
  tab: "탭",
};

function languageLabel(code: LanguageCode): string {
  return LANGUAGE_LABELS[code] ?? code.toUpperCase();
}

function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export default function SubtitleBubble({
  at,
  source,
  targetLanguage,
  sourceText,
  translatedText,
  partial = false,
  compact = false,
}: {
  at: number;
  source: AudioSource;
  targetLanguage: LanguageCode;
  sourceText: string;
  translatedText: string;
  partial?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={`cw-bubble-enter rounded-2xl border bg-cw-surface ${
        partial ? "border-cw-action/40" : "border-cw-hairline"
      } ${compact ? "px-3 py-2" : "px-4 py-3"} shadow-[0_4px_16px_rgba(12,10,9,0.04)]`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-cw-grey50">
        <span className="nowrap">{formatTime(at)}</span>
        <span
          className={`nowrap rounded-full px-2 py-0.5 font-medium ${
            source === "mic" ? "bg-cw-action/12 text-cw-action" : "bg-cw-surfaceStrong text-cw-grey75"
          }`}
        >
          {SOURCE_LABELS[source]}
        </span>
        <span className="nowrap">→ {languageLabel(targetLanguage)}</span>
        {partial ? <span className="cw-pulse font-bold text-cw-action">…</span> : null}
      </div>
      <p
        className={`font-medium leading-snug text-cw-ink [word-break:keep-all] ${
          compact ? "text-base" : "text-lg sm:text-xl"
        }`}
      >
        {translatedText}
      </p>
      {sourceText ? (
        <p className={`mt-1 leading-snug text-cw-grey [word-break:keep-all] ${compact ? "text-xs" : "text-sm"}`}>
          {sourceText}
        </p>
      ) : null}
    </div>
  );
}
