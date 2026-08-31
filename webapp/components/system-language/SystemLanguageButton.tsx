"use client";

import { Check, Globe, CaretDown } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { SYSTEM_LANGUAGES, SYSTEM_LANGUAGE_LABELS, isSystemLanguage } from "../../lib/system-language";
import { commonMessages } from "../../lib/dictionaries/common";
import { useSystemLanguage, useSystemText } from "./SystemLanguageProvider";
import styles from "./system-language.module.css";

export function SystemLanguageButton() {
  const { language, setLanguage, hasStorageError } = useSystemLanguage();
  const t = useSystemText(commonMessages);
  const [isOpen, setIsOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionsRef = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!isOpen) return;
    optionsRef.current[SYSTEM_LANGUAGES.indexOf(language)]?.focus();
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setIsOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [isOpen, language]);

  function closeMenu() { setIsOpen(false); triggerRef.current?.focus(); }
  function handleMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); closeMenu(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = optionsRef.current.findIndex((option) => option === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? SYSTEM_LANGUAGES.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + SYSTEM_LANGUAGES.length) % SYSTEM_LANGUAGES.length;
    optionsRef.current[next]?.focus();
  }

  return <div className={styles.control} ref={rootRef} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setIsOpen(false);
  }}>
    <button ref={triggerRef} className={styles.trigger} type="button" aria-label={`${t("systemLanguage")}: ${SYSTEM_LANGUAGE_LABELS[language]}`}
      aria-haspopup="menu" aria-expanded={isOpen} aria-controls={menuId} onClick={() => setIsOpen((open) => !open)}
      onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIsOpen(true); } }}>
      <Globe size={20} aria-hidden="true" /><span lang={language}>{SYSTEM_LANGUAGE_LABELS[language]}</span><CaretDown size={16} aria-hidden="true" />
    </button>
    {isOpen && <div id={menuId} className={styles.menu} role="menu" aria-label={t("chooseLanguage")} onKeyDown={handleMenuKey}>
      {SYSTEM_LANGUAGES.map((option, index) => <button key={option} ref={(element) => { optionsRef.current[index] = element; }}
        type="button" role="menuitemradio" tabIndex={-1} aria-checked={language === option} lang={option} className={styles.option}
        onClick={() => { if (isSystemLanguage(option)) setLanguage(option); closeMenu(); }}>
        <span>{SYSTEM_LANGUAGE_LABELS[option]}</span>{language === option && <Check size={20} aria-hidden="true" />}
      </button>)}
    </div>}
    {hasStorageError && !isOpen && <p className={styles.notice} role="status">{t("storageError")}</p>}
  </div>;
}
