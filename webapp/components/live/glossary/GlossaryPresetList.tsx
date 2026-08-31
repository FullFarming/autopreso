"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { glossaryMessages, formatGlossaryLanguageTag } from "@/lib/system-language/glossary-messages";

import type { GlossaryPresetPresentation } from "./glossary-presentation";
import styles from "./glossary.module.css";

interface GlossaryPresetListProps {
  readonly presets: readonly GlossaryPresetPresentation[];
  readonly selectedPresetId: string;
  readonly onSelect: (presetId: string) => void;
  readonly onCreate: () => void;
  readonly isBusy?: boolean;
}

export function GlossaryPresetList({ presets, selectedPresetId, onSelect, onCreate, isBusy = false }: GlossaryPresetListProps) {
  const t = useSystemText(glossaryMessages);
  return (
    <nav className={styles.presetPanel} aria-labelledby="glossary-preset-list-title">
      <div className={styles.sectionHeading}>
        <h2 id="glossary-preset-list-title">{t("용어집 목록")}</h2>
        <button type="button" disabled={isBusy} onClick={onCreate}>{t("새 용어집")}</button>
      </div>
      {presets.length === 0 ? <p role="status" className={styles.empty}>{t("저장된 용어집이 없습니다.")}</p> : (
        <ul className={styles.presetList}>
          {presets.map((preset) => (
            <li key={preset.id}>
              <button type="button" disabled={isBusy} className={styles.presetButton} aria-current={preset.id === selectedPresetId ? "true" : undefined}
                onClick={() => onSelect(preset.id)}>
                <strong>{preset.name}</strong>
                <span className={styles.languageTags} aria-label={t("언어: {languages}", { languages: preset.languagePairLabel })}>
                  {preset.languageTags.map((tag) => <span key={tag} className={styles.languageTag}>{formatGlossaryLanguageTag(tag, t)}</span>)}
                </span>
                <span>{preset.termCount === null ? "" : t("{count}개 용어", { count: preset.termCount })}</span>
                <small>{preset.activeVersion === null ? t("활성 버전 없음") : t("활성 버전 {version}", { version: preset.activeVersion })}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
