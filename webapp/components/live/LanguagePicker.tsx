"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { glossaryMessages } from "@/lib/system-language/glossary-messages";


import { useId, useRef, useState } from "react";
import { MagnifyingGlass, Minus, Plus } from "@phosphor-icons/react";

import { findLanguages, normalizeLanguageSearch, PICKER_LANGUAGES, updateLanguageSelection } from "./language-picker";
import styles from "./language-picker.module.css";

interface LanguagePickerProps {
  readonly label: string;
  readonly value: readonly string[];
  readonly onChange: (update: (current: readonly string[]) => string[]) => void;
  readonly minSelection?: number;
  readonly maxSelection?: number;
  readonly excludedLanguages?: readonly string[];
  readonly requiredLanguages?: readonly string[];
  readonly isDisabled?: boolean;
}

export function LanguagePicker({ label, value, onChange, minSelection = 1, maxSelection = 3, excludedLanguages = [], requiredLanguages = [], isDisabled = false }: LanguagePickerProps) {
  const t = useSystemText(glossaryMessages);
  const searchId = useId();
  const helpId = useId();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const translatedLabel = t(label);
  const matchingLanguages = findLanguages(query, value, excludedLanguages);
  const localizedMatches = PICKER_LANGUAGES.filter((language) => !value.includes(language.code)
    && !excludedLanguages.includes(language.code)
    && normalizeLanguageSearch(query).length > 0
    && normalizeLanguageSearch(t(language.label)).includes(normalizeLanguageSearch(query)));
  const results = [...new Map([...matchingLanguages, ...localizedMatches].map((language) => [language.code, language])).values()];
  const hasQuery = normalizeLanguageSearch(query).length > 0;
  const isAtLimit = value.length >= maxSelection;
  const limits = { minSelection, maxSelection, excludedLanguages, requiredLanguages };

  function addLanguage(code: string): void {
    if (isDisabled) return;
    onChange((current) => updateLanguageSelection(current, code, "add", limits));
    setQuery("");
    searchRef.current?.focus();
  }

  return (
    <fieldset className={styles.picker} disabled={isDisabled}>
      <legend className={styles.legend}>{translatedLabel}<span>{value.length}/{maxSelection}</span></legend>
      {value.length > 0 && <ul className={styles.selected} aria-label={t("선택한 {label}", { label: translatedLabel })}>
        {value.map((code) => {
          const language = PICKER_LANGUAGES.find((option) => option.code === code);
          const name = language ? t(language.label) : code;
          const isRequired = requiredLanguages.includes(code);
          return <li key={code} className={styles.row}>
            <span className={styles.languageName}>{name}<span>{language?.english ?? code}</span>{isRequired && <span>{t("기본 자막")}</span>}</span>
            <button className={styles.remove} type="button" aria-label={t("{name} 제거", { name })}
              title={isRequired ? t("기본 자막 언어는 유지됩니다") : value.length <= minSelection ? t("최소 {count}개 언어가 필요합니다", { count: minSelection }) : t("{name} 제거", { name })}
              disabled={isDisabled || isRequired || value.length <= minSelection}
              onClick={() => { onChange((current) => updateLanguageSelection(current, code, "remove", limits)); searchRef.current?.focus(); }}>
              <Minus size={20} aria-hidden="true" />
            </button>
          </li>;
        })}
      </ul>}
      <label className={styles.searchLabel} htmlFor={searchId}>{t("{label} 검색", { label: translatedLabel })}</label>
      <div className={styles.searchField}>
        <MagnifyingGlass size={20} aria-hidden="true" />
        <input ref={searchRef} id={searchId} type="search" value={query} maxLength={100} autoComplete="off"
          disabled={isDisabled} placeholder={t("언어 검색 · 한국어, English, ja")} aria-describedby={helpId}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (results.length === 1 && !isAtLimit) addLanguage(results[0].code);
            }
          }} />
      </div>
      <p id={helpId} className={styles.notice} role="status" aria-live="polite">
        {value.length > maxSelection ? t("추가 언어를 제거해 {count}개 이하로 맞춰 주세요.", { count: maxSelection })
          : isAtLimit ? t("최대 {count}개까지 선택할 수 있습니다.", { count: maxSelection })
          : hasQuery ? results.length ? t("검색 결과 {count}개", { count: results.length }) : t("추가할 수 있는 언어가 없습니다.")
            : t("언어를 검색한 뒤 + 버튼으로 추가하세요.")}
      </p>
      {hasQuery && results.length > 0 && <ul className={styles.results} aria-label={t("{label} 검색 결과", { label: translatedLabel })}>
        {results.map((language) => <li key={language.code} className={styles.row}>
          <span className={styles.languageName}>{t(language.label)}<span>{language.english}</span></span>
          <button className={styles.add} type="button" aria-label={t("{name} 추가", { name: t(language.label) })}
            disabled={isDisabled || isAtLimit} onClick={() => addLanguage(language.code)}>
            <Plus size={20} aria-hidden="true" />
          </button>
        </li>)}
      </ul>}
    </fieldset>
  );
}
