"use client";

// Desktop control bar (glass). Mobile/tablet use MobileLiveView's bottom
// sheet instead — see app/page.tsx for the breakpoint split.

import type { AppSettings } from "@/lib/settings";
import type { EngineKind, InputMode, LanguagePairId, ToneKind } from "@/lib/types";

export const INPUT_MODES: Array<{ value: InputMode; label: string }> = [
  { value: "mic", label: "마이크" },
  { value: "tab", label: "탭 오디오 공유" },
  { value: "both", label: "둘 다" },
];

export const LANGUAGE_PAIRS: Array<{ value: LanguagePairId; label: string }> = [
  { value: "ko-en", label: "KO ↔ EN" },
  { value: "ko-ja", label: "KO ↔ JA" },
  { value: "en-ja", label: "EN ↔ JA" },
];

export const TONES: Array<{ value: ToneKind; label: string }> = [
  { value: "natural", label: "자연스럽게" },
  { value: "business", label: "비즈니스" },
];

export const ENGINES: Array<{ value: EngineKind; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
];

export default function ControlBar({
  settings,
  running,
  starting,
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
  onChange: (patch: Partial<AppSettings>) => void;
  onStart: () => void;
  onStop: () => void;
  onToggleOverlay: () => void;
  overlayOpen: boolean;
  onExport: () => void;
  onClear: () => void;
  hasHistory: boolean;
}) {
  const locked = running || starting;

  return (
    <section className="glass p-4 sm:p-5">
      <div className="flex flex-wrap items-end gap-4">
        {/* Input source segmented toggle */}
        <div>
          <div className="mb-1 text-xs font-medium text-white/55">입력 소스</div>
          <div className="inline-flex overflow-hidden rounded-xl border border-white/20 bg-white/5">
            {INPUT_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                disabled={locked}
                onClick={() => onChange({ inputMode: mode.value })}
                className={`px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed ${
                  settings.inputMode === mode.value
                    ? "bg-white/25 font-medium text-white"
                    : "text-white/60 hover:bg-white/10 disabled:hover:bg-transparent"
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="pair-select" className="mb-1 block text-xs font-medium text-white/55">
            언어 쌍
          </label>
          <select
            id="pair-select"
            disabled={locked}
            value={settings.languagePair}
            onChange={(event) => onChange({ languagePair: event.target.value as LanguagePairId })}
            className="glass-input !w-auto"
          >
            {LANGUAGE_PAIRS.map((pair) => (
              <option key={pair.value} value={pair.value}>
                {pair.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="tone-select" className="mb-1 block text-xs font-medium text-white/55">
            톤
          </label>
          <select
            id="tone-select"
            disabled={locked}
            value={settings.tone}
            onChange={(event) => onChange({ tone: event.target.value as ToneKind })}
            className="glass-input !w-auto"
          >
            {TONES.map((tone) => (
              <option key={tone.value} value={tone.value}>
                {tone.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="engine-select" className="mb-1 block text-xs font-medium text-white/55">
            엔진
          </label>
          <select
            id="engine-select"
            disabled={locked}
            value={settings.engine}
            onChange={(event) => onChange({ engine: event.target.value as EngineKind })}
            className="glass-input !w-auto"
          >
            {ENGINES.map((engine) => (
              <option key={engine.value} value={engine.value}>
                {engine.label}
              </option>
            ))}
          </select>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {running ? (
            <button
              type="button"
              onClick={onStop}
              className="glass-btn px-5 py-2.5 text-sm font-bold"
            >
              중지
            </button>
          ) : (
            <button
              type="button"
              onClick={onStart}
              disabled={starting}
              className="accent-btn px-6 py-2.5 text-sm font-bold"
            >
              {starting ? "연결 중…" : "시작"}
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
        <button
          type="button"
          onClick={onToggleOverlay}
          className={`rounded-xl px-3 py-1.5 text-sm font-medium transition-colors ${
            overlayOpen
              ? "bg-cyan-400/25 text-cyan-100 hover:bg-cyan-400/35"
              : "text-cyan-200 hover:bg-white/10"
          }`}
        >
          오버레이 자막 {overlayOpen ? "닫기" : "열기"}
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onExport}
            disabled={!hasHistory}
            className="glass-btn px-3 py-1.5 text-sm font-medium"
          >
            Excel
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={!hasHistory}
            className="glass-btn px-3 py-1.5 text-sm font-medium"
          >
            Clear
          </button>
        </div>
      </div>
    </section>
  );
}
