"use client";

import { useEffect, useState } from "react";

import { PRESETS, findPreset } from "@/lib/presets";
import { MAX_DOMAIN_CHARS, MAX_GLOSSARY_CHARS, type AppSettings, type PipPosition } from "@/lib/settings";

const PAIR_LABELS: Record<string, [string, string]> = {
  "ko-en": ["한국어", "English"],
  "ko-ja": ["한국어", "日本語"],
  "en-ja": ["English", "日本語"],
};

export default function SettingsModal({
  open,
  settings,
  onApply,
  onClose,
}: {
  open: boolean;
  settings: AppSettings;
  onApply: (patch: Partial<AppSettings>) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AppSettings>(settings);

  useEffect(() => {
    // Snapshot only when the modal opens. Immediate-apply controls mutate
    // `settings` while the modal is open; re-syncing on every settings change
    // would wipe in-progress glossary/domain draft edits.
    if (open) setDraft(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  function update(patch: Partial<AppSettings>) {
    setDraft((previous) => ({ ...previous, ...patch }));
  }

  /** Immediate-apply controls: keep the draft in sync so 저장 doesn't revert them. */
  function applyNow(patch: Partial<AppSettings>) {
    update(patch);
    onApply(patch);
  }

  function handlePresetChange(presetId: string) {
    if (!presetId) {
      update({ presetId: "" });
      return;
    }
    const preset = findPreset(presetId);
    if (!preset) return;
    // A preset switches glossary + domain + language pair together.
    update({
      presetId,
      glossary: preset.glossary,
      domain: preset.domain,
      languagePair: preset.languagePair,
    });
  }

  function handleSave() {
    onApply(draft);
    onClose();
  }

  const label = "mb-1 block text-sm font-medium text-cw-grey75";

  return (
    <div
      className="cw-overlay-enter fixed inset-0 z-50 flex items-center justify-center bg-cw-ink/35 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="설정"
    >
      <div
        className="cw-modal-enter glass-strong flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-cw-hairline px-6 py-4">
          <h2 className="display text-2xl">설정</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="rounded-full px-2 py-1 text-xl leading-none text-cw-grey75 transition-colors hover:bg-black/5 hover:text-cw-ink"
          >
            ×
          </button>
        </div>

        <div className="min-w-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* Program-embedded presets — register a learned glossary/domain in one tap */}
          <div className="rounded-2xl border border-cw-hairline bg-cw-surface p-4">
            <label htmlFor="preset-select" className={label}>
              프리셋 — 프로그램에 등록된 용어집·도메인 불러오기
            </label>
            <select
              id="preset-select"
              value={draft.presetId}
              onChange={(event) => handlePresetChange(event.target.value)}
              className="glass-input"
            >
              <option value="">직접 입력 / 없음</option>
              {PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-cw-grey75">
              선택하면 해당 업계의 용어집·도메인·언어쌍이 한 번에 적용됩니다.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <label className={label}>입력</label>
              <select value={draft.inputMode} onChange={(e) => applyNow({ inputMode: e.target.value as any })} className="glass-input">
                <option value="mic">마이크</option>
                <option value="tab">탭 오디오</option>
                <option value="both">둘 다</option>
              </select>
            </div>
            <div className="min-w-0">
              <label className={label}>언어쌍</label>
              <select value={draft.languagePair} onChange={(e) => applyNow({ languagePair: e.target.value as any })} className="glass-input">
                <option value="ko-en">한국어 ↔ English</option>
                <option value="ko-ja">한국어 ↔ 日本語</option>
                <option value="en-ja">English ↔ 日本語</option>
              </select>
            </div>
            <div className="min-w-0">
              <label className={label}>번역 방향 (비용 절감)</label>
              <select value={draft.direction} onChange={(e) => applyNow({ direction: e.target.value as any })} className="glass-input">
                <option value="both">양방향</option>
                <option value="a2b">{PAIR_LABELS[draft.languagePair][0]} → {PAIR_LABELS[draft.languagePair][1]}</option>
                <option value="b2a">{PAIR_LABELS[draft.languagePair][1]} → {PAIR_LABELS[draft.languagePair][0]}</option>
              </select>
            </div>
            <div className="min-w-0">
              <label className={label}>어투</label>
              <select value={draft.tone} onChange={(e) => applyNow({ tone: e.target.value as any })} className="glass-input">
                <option value="natural">자연스럽게</option>
                <option value="business">비즈니스</option>
              </select>
            </div>
            <div className="min-w-0">
              <label className={label}>엔진</label>
              <select value={draft.engine} onChange={(e) => applyNow({ engine: e.target.value as any })} className="glass-input">
                <option value="openai">OpenAI</option>
                <option value="gemini">Gemini</option>
              </select>
            </div>
          </div>

          <div>
            <span className={label}>동시 출력 언어 (선택 시 언어쌍 대신 적용 — 예: 영어 인입 → 한국어+일본어 동시)</span>
            <div className="flex flex-wrap gap-3">
              {(["ko", "en", "ja"] as const).map((lang) => (
                <label key={lang} className="nowrap flex items-center gap-1.5 text-sm text-cw-grey">
                  <input type="checkbox" checked={draft.targetLanguages.includes(lang)}
                    className="h-4 w-4 accent-cw-primary"
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...draft.targetLanguages, lang]
                        : draft.targetLanguages.filter((entry) => entry !== lang);
                      applyNow({ targetLanguages: next });
                    }} />
                  {{ ko: "한국어", en: "English", ja: "日本語" }[lang]}
                </label>
              ))}
            </div>
          </div>

          <div className="min-w-0">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <label htmlFor="glossary-textarea" className="text-sm font-medium text-cw-grey75">용어집 (Glossary)</label>
              <span className="nowrap text-xs text-cw-grey50">
                {draft.glossary.length.toLocaleString()} / {MAX_GLOSSARY_CHARS.toLocaleString()}
              </span>
            </div>
            <textarea
              id="glossary-textarea"
              value={draft.glossary}
              maxLength={MAX_GLOSSARY_CHARS}
              onChange={(event) => update({ glossary: event.target.value, presetId: "" })}
              rows={8}
              className="glass-input resize-y font-mono !text-base leading-relaxed sm:!text-xs"
              placeholder="용어쌍을 한 줄에 하나씩 입력하세요. 예) 임차인 = tenant"
            />
          </div>

          <div className="min-w-0">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <label htmlFor="domain-textarea" className="text-sm font-medium text-cw-grey75">도메인 설명</label>
              <span className="nowrap text-xs text-cw-grey50">
                {draft.domain.length.toLocaleString()} / {MAX_DOMAIN_CHARS.toLocaleString()}
              </span>
            </div>
            <textarea
              id="domain-textarea"
              value={draft.domain}
              maxLength={MAX_DOMAIN_CHARS}
              onChange={(event) => update({ domain: event.target.value, presetId: "" })}
              rows={3}
              className="glass-input resize-y !text-base leading-relaxed sm:!text-xs"
              placeholder="회의 주제/도메인을 영어 또는 한국어로 설명하면 번역 정확도가 올라갑니다."
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor="pip-position" className={label}>오버레이 자막 위치</label>
              <select
                id="pip-position"
                value={draft.pipPosition}
                onChange={(event) => update({ pipPosition: event.target.value as PipPosition })}
                className="glass-input"
              >
                <option value="bottom">하단</option>
                <option value="middle">중앙</option>
                <option value="top">상단</option>
              </select>
            </div>
            <div className="min-w-0">
              <label htmlFor="pip-font-size" className={label}>자막 글자 크기 ({draft.pipFontSize}px)</label>
              <input
                id="pip-font-size"
                type="range"
                min={18}
                max={64}
                value={draft.pipFontSize}
                onChange={(event) => update({ pipFontSize: Number(event.target.value) })}
                className="w-full accent-cw-primary"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-cw-grey">
            <input
              type="checkbox"
              checked={draft.pipShowSource}
              onChange={(event) => update({ pipShowSource: event.target.checked })}
              className="h-4 w-4 accent-cw-primary"
            />
            오버레이/자막에 원문도 함께 표시
          </label>

          <label className="flex items-start gap-2 text-sm text-cw-grey">
            <input
              type="checkbox"
              checked={draft.silenceGate}
              onChange={(event) => applyNow({ silenceGate: event.target.checked })}
              className="mt-0.5 h-4 w-4 accent-cw-primary"
            />
            <span>
              무음 자동 절전 — 말하지 않는 구간은 전송하지 않아 비용 절감 (단어 잘림 없음)
            </span>
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-cw-hairline px-6 py-4">
          <button type="button" onClick={onClose} className="glass-btn px-4 py-2 text-sm font-medium">
            취소
          </button>
          <button type="button" onClick={handleSave} className="accent-btn px-5 py-2 text-sm font-semibold">
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
