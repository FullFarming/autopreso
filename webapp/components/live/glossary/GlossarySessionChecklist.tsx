"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { glossaryMessages, formatGlossaryStatus, formatGlossaryVersionDescription } from "@/lib/system-language/glossary-messages";


import { useEffect, useMemo, useState } from "react";

import type { GlossaryPreset } from "@/lib/glossary-presets/types";
import { listGlossaryPresets, type GlossaryFetcher } from "./glossary-client";
import {
  evaluateGlossarySessionSelection,
  getGlossarySessionOptionAvailability,
  toggleGlossarySessionSelection,
  type GlossarySessionOption,
  type GlossarySessionPinSelection,
} from "./glossary-presentation";
import styles from "./glossary.module.css";

const BUILT_IN_GLOSSARY_OPTIONS: readonly GlossarySessionOption[] = [
  { sourceKind: "builtin", sourceId: "common_business", label: "공통 비즈니스", description: "회의·발표에 자주 쓰는 기본 표현", group: "builtin", sourceLanguage: "ko", targetLanguages: ["en"], conflictKeys: [] },
  { sourceKind: "builtin", sourceId: "ai_ax", label: "AI·AX", description: "AI 전환·데이터·자동화 용어", group: "builtin", sourceLanguage: "ko", targetLanguages: ["en"], conflictKeys: [] },
  { sourceKind: "builtin", sourceId: "commercial_real_estate", label: "상업용 부동산", description: "투자·개발·자산관리 용어", group: "builtin", sourceLanguage: "ko", targetLanguages: ["en"], conflictKeys: [] },
  { sourceKind: "builtin", sourceId: "hospitality", label: "호텔·호스피탈리티", description: "호텔 운영·투자·브랜드 용어", group: "builtin", sourceLanguage: "ko", targetLanguages: ["en"], conflictKeys: [] },
  { sourceKind: "builtin", sourceId: "fnb_retail", label: "F&B·리테일", description: "식음·임대·리테일 용어", group: "builtin", sourceLanguage: "ko", targetLanguages: ["en", "ja"], conflictKeys: [] },
  { sourceKind: "builtin", sourceId: "proper_nouns", label: "고유명사", description: "회사·브랜드·인명 표기", group: "builtin", sourceLanguage: "ko", targetLanguages: ["en"], conflictKeys: [] },
  { sourceKind: "builtin", sourceId: "ko_ja_idioms", label: "한·일 관용표현", description: "한국어 관용표현의 자연스러운 일본어 번역", group: "builtin", sourceLanguage: "ko", targetLanguages: ["ja"], conflictKeys: [] },
] as const;

interface GlossarySessionChecklistProps {
  readonly options: readonly GlossarySessionOption[];
  readonly selections: readonly GlossarySessionPinSelection[];
  readonly targetLanguages: readonly string[];
  readonly disabled?: boolean;
  readonly onChange: (selections: readonly GlossarySessionPinSelection[]) => void;
}

export function GlossarySessionChecklist({ options, selections, targetLanguages, disabled = false, onChange }: GlossarySessionChecklistProps) {
  const t = useSystemText(glossaryMessages);
  const [feedback, setFeedback] = useState("");
  const evaluation = evaluateGlossarySessionSelection(options, selections, targetLanguages);
  const selectedKeys = new Set(selections.map((selection) => `${selection.sourceKind}:${selection.sourceId}`));
  const groups = [
    { id: "builtin", label: "내장 용어집", options: options.filter((option) => option.group === "builtin") },
    { id: "host", label: "내 용어집", options: options.filter((option) => option.group === "host") },
  ] as const;

  function toggle(option: GlossarySessionOption): void {
    const result = toggleGlossarySessionSelection(options, selections, option, targetLanguages);
    if (!result.ok) {
      setFeedback(result.code === "GLOSSARY_SELECTION_REQUIRED"
        ? "세션 용어집을 1개 이상 선택해 주세요."
        : result.code === "GLOSSARY_SELECTION_LIMIT"
          ? "용어집은 최대 5개까지 선택할 수 있습니다."
          : result.code === "INCOMPATIBLE_GLOSSARY_LANGUAGE"
            ? "현재 번역 언어와 호환되지 않는 용어집입니다."
            : `같은 용어의 번역이 충돌합니다: ${result.evaluation.conflictKeys.join(", ")}`);
      return;
    }
    setFeedback(result.selections.length ? `${result.selections.length}개 용어집을 선택했습니다.` : "선택한 용어집이 없습니다.");
    onChange(result.selections);
  }

  return (
    <fieldset className={styles.sessionChecklist} disabled={disabled}>
      <legend>{t("세션 용어집")}</legend>
      <div className={styles.sessionChecklistHeading}>
        <span>{t("필요한 분야를 함께 선택하세요.")}</span>
        <output aria-live="polite">{t("{count}/5개 선택", { count: selections.length })}</output>
      </div>
      {groups.map((group) => (
        <section key={group.id} className={styles.sessionChecklistGroup} aria-labelledby={`glossary-session-${group.id}`}>
          <h3 id={`glossary-session-${group.id}`}>{t(group.label)}</h3>
          {group.options.length === 0 ? <p>{t("활성화된 용어집이 없습니다.")}</p> : (
            <div className={styles.sessionChecklistOptions}>
              {group.options.map((option) => {
                const key = `${option.sourceKind}:${option.sourceId}`;
                const availability = getGlossarySessionOptionAvailability(options, selections, option, targetLanguages);
                const description = !availability.isTargetCompatible
                  ? "현재 번역 언어와 호환되지 않음"
                  : !availability.isSourceCompatible
                    ? "선택한 용어집과 원문 언어가 다름"
                    : option.description;
                return (
                  <label key={key} className={styles.sessionChecklistOption}
                    data-incompatible={!availability.isTargetCompatible || !availability.isSourceCompatible || undefined}>
                    <input type="checkbox" name="glossaries" value={key}
                      checked={selectedKeys.has(key)} disabled={availability.isDisabled}
                      onChange={() => toggle(option)} />
                    <span>
                      <strong>{option.sourceKind === "builtin" ? t(option.label) : option.label}</strong>
                      <span className={styles.languageTags} aria-label={t("언어: {languages}", { languages: `${option.sourceLanguage} → ${option.targetLanguages.join(", ")}` })}>
                        <span className={styles.languageTag}>{t("원문 {language}", { language: option.sourceLanguage })}</span>
                        {option.targetLanguages.map((language) => <span key={language} className={styles.languageTag}>{language}</span>)}
                      </span>
                      <small>{!availability.isTargetCompatible || !availability.isSourceCompatible || option.sourceKind === "builtin"
                        ? t(description ?? "") : formatGlossaryVersionDescription(description ?? "", t)}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </section>
      ))}
      <p className={styles.sessionChecklistFeedback} role={evaluation.hasConflict ? "alert" : "status"} aria-live="polite">
        {formatGlossaryStatus(feedback || (evaluation.hasConflict
          ? `같은 용어의 번역이 충돌합니다: ${evaluation.conflictKeys.join(", ")}`
          : "적용할 때 번역 충돌을 확인합니다."), t)}
      </p>
    </fieldset>
  );
}

interface ConnectedGlossarySessionChecklistProps extends Omit<GlossarySessionChecklistProps, "options"> {
  readonly fetcher?: GlossaryFetcher;
}

export function ConnectedGlossarySessionChecklist({ fetcher = fetch, ...props }: ConnectedGlossarySessionChecklistProps) {
  const [presets, setPresets] = useState<GlossaryPreset[]>([]);
  useEffect(() => {
    let isDisposed = false;
    void listGlossaryPresets(fetcher).then((next) => { if (!isDisposed) setPresets(next); }, () => { if (!isDisposed) setPresets([]); });
    return () => { isDisposed = true; };
  }, [fetcher]);
  const options = useMemo<GlossarySessionOption[]>(() => [
    ...BUILT_IN_GLOSSARY_OPTIONS,
    ...presets.filter((preset) => preset.activeDocumentVersion !== null).map((preset) => ({
      sourceKind: "host" as const,
      sourceId: preset.id,
      documentVersion: preset.activeDocumentVersion!,
      label: preset.name,
      description: `${preset.domain} · 활성 버전 ${preset.activeDocumentVersion}`,
      group: "host" as const,
      sourceLanguage: preset.languagePair.a,
      targetLanguages: [...preset.targetLanguages],
      conflictKeys: [],
    })),
  ], [presets]);
  return <GlossarySessionChecklist {...props} options={options} />;
}
