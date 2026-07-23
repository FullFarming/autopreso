"use client";

// Mobile/tablet (<1024px) primary surface for 통역 모드: committed history as
// compact bubbles scrolling above, the current utterance rendered movie-style
// in the bottom third, controls collapsed into a slide-up glass sheet, and a
// big floating round Start/Stop button.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import SubtitleBubble from "./SubtitleBubble";
import { ENGINES, INPUT_MODES, LANGUAGE_PAIRS, TONES } from "./ControlBar";
import type { AppSettings } from "@/lib/settings";
import type { EngineKind, InputMode, LanguagePairId, PartialLine, SubtitleLine, ToneKind } from "@/lib/types";

/** Fit text into at most `maxLines` lines: start from the CSS clamp() base
 *  size and shrink stepwise until it fits. Never overflows horizontally
 *  (keep-all + overflow-wrap:anywhere come from .subtitle-live). */
export function FitSubtitle({ text, maxLines = 3 }: { text: string; maxLines?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.fontSize = ""; // reset to the clamp() base before measuring
    const base = parseFloat(getComputedStyle(el).fontSize) || 32;
    const steps = [1, 0.9, 0.8, 0.72, 0.64, 0.56, 0.5];
    for (const step of steps) {
      el.style.fontSize = `${Math.round(base * step)}px`;
      const size = parseFloat(getComputedStyle(el).fontSize) || base * step;
      const lineHeight = size * 1.3;
      if (el.scrollHeight <= lineHeight * maxLines + 3) break;
    }
  }, [text, maxLines]);

  return (
    <div ref={ref} className="subtitle-live w-full">
      {text}
    </div>
  );
}

export default function MobileLiveView({
  settings,
  running,
  starting,
  lines,
  partials,
  onChange,
  onStart,
  onStop,
  onToggleOverlay,
  overlayOpen,
  onExport,
  onClear,
  hasHistory,
}: {
  settings: AppSettings;
  running: boolean;
  starting: boolean;
  lines: SubtitleLine[];
  partials: PartialLine[];
  onChange: (patch: Partial<AppSettings>) => void;
  onStart: () => void;
  onStop: () => void;
  onToggleOverlay: () => void;
  overlayOpen: boolean;
  onExport: () => void;
  onClear: () => void;
  hasHistory: boolean;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const locked = running || starting;

  // Current utterance: the freshest partial, else the latest committed line.
  const live = useMemo(() => {
    if (partials.length > 0) {
      return partials.reduce((latest, partial) => (partial.at > latest.at ? partial : latest));
    }
    if (lines.length > 0) return lines[lines.length - 1];
    return null;
  }, [partials, lines]);

  useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, partials]);

  const pairLabel = LANGUAGE_PAIRS.find((p) => p.value === settings.languagePair)?.label ?? settings.languagePair;
  const inputLabel = INPUT_MODES.find((m) => m.value === settings.inputMode)?.label ?? settings.inputMode;
  const toneLabel = TONES.find((t) => t.value === settings.tone)?.label ?? settings.tone;
  const engineLabel = ENGINES.find((e) => e.value === settings.engine)?.label ?? settings.engine;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Compact control chips — tap any to open the slide-up sheet */}
      <div className="px-safe flex flex-wrap items-center justify-center gap-1.5 px-3 pb-2">
        {[inputLabel, pairLabel, toneLabel, engineLabel].map((label, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setSheetOpen(true)}
            className="glass-pill px-3 py-1 text-[11px] font-medium text-white/70"
          >
            {label}
          </button>
        ))}
      </div>

      {/* Committed history */}
      <div ref={historyRef} className="px-safe min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-2">
        {lines.length === 0 && partials.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/40">
            {running ? "음성을 기다리는 중입니다…" : "아래 빨간 버튼을 누르면 통역이 시작됩니다."}
          </div>
        ) : (
          lines.map((line) => (
            <SubtitleBubble
              key={line.id}
              at={line.at}
              source={line.source}
              targetLanguage={line.targetLanguage}
              sourceText={line.sourceText}
              translatedText={line.translatedText}
              compact
            />
          ))
        )}
      </div>

      {/* Live subtitle — bottom third, movie-style */}
      <div className="px-safe flex min-h-[30dvh] flex-col items-center justify-end gap-2 px-4 pb-2">
        {live ? (
          <>
            <FitSubtitle text={live.translatedText} />
            {live.sourceText ? (
              <p className="max-w-full text-center text-sm leading-snug text-white/55 [overflow-wrap:anywhere] [word-break:keep-all]">
                {live.sourceText}
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      {/* Floating Start/Stop */}
      <div className="px-safe pb-safe flex items-center justify-center gap-4 px-4 pb-4 pt-1">
        <button
          type="button"
          onClick={onToggleOverlay}
          aria-label="오버레이 자막"
          className={`glass-btn rounded-full px-4 py-2.5 text-xs font-medium ${overlayOpen ? "!bg-cyan-400/25 text-cyan-100" : ""}`}
        >
          PiP
        </button>
        {running ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="중지"
            className="glass-btn flex h-20 w-20 items-center justify-center rounded-full border-2 !border-white/40 text-sm font-bold text-white shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
          >
            <span className="block h-6 w-6 rounded bg-white" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onStart}
            disabled={starting}
            aria-label="시작"
            className="accent-btn flex h-20 w-20 items-center justify-center rounded-full text-sm font-bold"
          >
            {starting ? "…" : "시작"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-label="세션 설정"
          className="glass-btn rounded-full px-4 py-2.5 text-xs font-medium"
        >
          설정
        </button>
      </div>

      {/* Slide-up settings sheet */}
      {sheetOpen ? (
        <div
          className="cw-overlay-enter fixed inset-0 z-50 flex flex-col justify-end bg-black/55 backdrop-blur-sm"
          onClick={() => setSheetOpen(false)}
        >
          <div
            className="sheet-enter glass-strong pb-safe mx-auto w-full max-w-lg !rounded-b-none p-5"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="세션 설정"
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/30" />
            <div className="space-y-4">
              <div>
                <div className="mb-1 text-xs font-medium text-white/55">입력 소스</div>
                <select
                  value={settings.inputMode}
                  disabled={locked}
                  onChange={(event) => onChange({ inputMode: event.target.value as InputMode })}
                  className="glass-input"
                >
                  {INPUT_MODES.map((mode) => (
                    <option key={mode.value} value={mode.value}>{mode.label}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 text-xs font-medium text-white/55">언어 쌍</div>
                  <select
                    value={settings.languagePair}
                    disabled={locked}
                    onChange={(event) => onChange({ languagePair: event.target.value as LanguagePairId })}
                    className="glass-input"
                  >
                    {LANGUAGE_PAIRS.map((pair) => (
                      <option key={pair.value} value={pair.value}>{pair.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-white/55">톤</div>
                  <select
                    value={settings.tone}
                    disabled={locked}
                    onChange={(event) => onChange({ tone: event.target.value as ToneKind })}
                    className="glass-input"
                  >
                    {TONES.map((tone) => (
                      <option key={tone.value} value={tone.value}>{tone.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-white/55">엔진</div>
                <select
                  value={settings.engine}
                  disabled={locked}
                  onChange={(event) => onChange({ engine: event.target.value as EngineKind })}
                  className="glass-input"
                >
                  {ENGINES.map((engine) => (
                    <option key={engine.value} value={engine.value}>{engine.label}</option>
                  ))}
                </select>
              </div>
              {locked ? (
                <p className="text-xs text-white/40">세션 실행 중에는 입력/언어/엔진을 바꿀 수 없습니다.</p>
              ) : null}
              <div className="flex items-center gap-2 border-t border-white/10 pt-3">
                <button
                  type="button"
                  onClick={() => { onExport(); }}
                  disabled={!hasHistory}
                  className="glass-btn flex-1 px-3 py-2 text-sm font-medium"
                >
                  Excel 내보내기
                </button>
                <button
                  type="button"
                  onClick={() => { onClear(); }}
                  disabled={!hasHistory}
                  className="glass-btn flex-1 px-3 py-2 text-sm font-medium"
                >
                  기록 지우기
                </button>
              </div>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="glass-btn w-full px-3 py-2.5 text-sm font-semibold"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
