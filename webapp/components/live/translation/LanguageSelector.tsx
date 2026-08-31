"use client";

import { useId } from "react";

import styles from "./translation.module.css";
import { resolveLanguageSelectorPresentation } from "./translation-state";

export interface LanguageOption {
  value: string;
  label: string;
}

interface LanguageSelectorProps {
  value: string;
  options: readonly LanguageOption[];
  onChange: (value: string) => void;
  isCompact?: boolean;
  label?: string;
}

export function LanguageSelector({
  value,
  options,
  onChange,
  isCompact = false,
  label = "Translation language",
}: LanguageSelectorProps) {
  const selectId = `translation-language-${useId()}`;

  if (resolveLanguageSelectorPresentation(options.length, isCompact) === "select") {
    return (
      <label className={styles.selectLabel} htmlFor={selectId}>
        <span>{label}</span>
        <select id={selectId} name={selectId} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    );
  }

  return (
    <fieldset className={styles.segmented}>
      <legend className={styles.srOnly}>{label}</legend>
      <div role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <label key={option.value} data-selected={value === option.value || undefined}>
            <input
              type="radio"
              name={selectId}
              value={option.value}
              checked={value === option.value}
              onChange={(event) => onChange(event.currentTarget.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
