"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { glossaryMessages, formatGlossaryStatus, formatGlossaryLanguageTag } from "@/lib/system-language/glossary-messages";


import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LanguagePicker } from "../LanguagePicker";
import { PICKER_LANGUAGES, removeSourceLanguage } from "../language-picker";

import {
  GLOSSARY_REGISTRATION_LANGUAGES,
  GlossaryRegistrationError,
  buildGlossaryExtractionPrompt,
} from "./glossary-registration";
import styles from "./glossary.module.css";

export interface GlossaryRegistrationPreview {
  readonly name: string;
  readonly termCount: number;
  readonly languageTags: readonly string[];
}

interface GlossaryRegistrationDialogProps {
  readonly isOpen: boolean;
  readonly isBusy?: boolean;
  readonly preview: GlossaryRegistrationPreview | null;
  readonly statusMessage: string;
  readonly onValidate: (text: string) => void;
  readonly onRegister: () => void;
  readonly onClose: () => void;
}

export function GlossaryRegistrationDialog({ isOpen, isBusy = false, preview, statusMessage, onValidate, onRegister, onClose }: GlossaryRegistrationDialogProps) {
  const t = useSystemText(glossaryMessages);
  const titleId = useId();
  const promptId = useId();
  const pasteId = useId();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState("ko");
  const [targetLanguages, setTargetLanguages] = useState<readonly string[]>(["en"]);
  const [prompt, setPrompt] = useState("");
  const [pasted, setPasted] = useState("");
  const [validatedPaste, setValidatedPaste] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState("");
  const [isMounted, setIsMounted] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { setIsMounted(true); }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) return;
    const previousFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [isOpen, isMounted]);

  if (!isOpen || !isMounted) return null;

  function changeSourceLanguage(language: string): void {
    setSourceLanguage(language);
    setTargetLanguages((current) => removeSourceLanguage(current, language));
    setPrompt("");
    setLocalNotice("");
  }

  function changeTargetLanguages(update: (current: readonly string[]) => string[]): void {
    setTargetLanguages(update);
    setPrompt("");
    setLocalNotice("");
  }

  function generatePrompt(): void {
    try {
      setPrompt(buildGlossaryExtractionPrompt({ name, domain, sourceLanguage, targetLanguages }));
      setLocalNotice("프롬프트를 생성했습니다. 복사해서 AI 툴(클로드·코덱스 등)에 문서와 함께 붙여 넣으세요.");
    } catch (reason: unknown) {
      setLocalNotice(reason instanceof GlossaryRegistrationError ? reason.message : "프롬프트를 생성할 수 없습니다.");
    }
  }

  function copyPrompt(): void {
    if (!prompt) { setLocalNotice("먼저 프롬프트를 생성해 주세요."); return; }
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard) { setLocalNotice("클립보드를 사용할 수 없습니다. 프롬프트를 직접 선택해 복사해 주세요."); return; }
    void clipboard.writeText(prompt).then(
      () => setLocalNotice("프롬프트를 복사했습니다."),
      () => setLocalNotice("복사에 실패했습니다. 프롬프트를 직접 선택해 복사해 주세요."),
    );
  }

  return createPortal(
    <div className={`live-modal-root ${styles.registrationOverlay}`} role="presentation">
      <dialog ref={dialogRef} className={styles.registrationDialog} aria-modal="true" aria-labelledby={titleId} aria-busy={isBusy}
        onCancel={(event) => { event.preventDefault(); onClose(); }}>
        <header className={styles.sectionHeading}>
          <h2 id={titleId}>{t("언어집 등록")}</h2>
          <button ref={closeRef} type="button" onClick={onClose}>{t("닫기")}</button>
        </header>
        <div className={styles.registrationBody}>
        <p>{t("1단계 — 언어를 고르고 프롬프트를 생성한 뒤, AI 툴에 문서와 함께 붙여 넣어 용어집을 만들어 옵니다.")}</p>
        <div className={styles.registrationForm}>
          <label>{t("이름")}<input type="text" name="registrationName" value={name} maxLength={80} disabled={isBusy}
              onChange={(event) => setName(event.currentTarget.value)} placeholder={t("예: 2026 세미나 용어집")} />
          </label>
          <label>{t("도메인·행사 설명")}<input type="text" name="registrationDomain" value={domain} maxLength={600} disabled={isBusy}
              onChange={(event) => setDomain(event.currentTarget.value)} placeholder={t("예: 실시간 통역 API 세미나")} />
          </label>
          <label>{t("원문 언어")}<select name="registrationSource" value={sourceLanguage} disabled={isBusy}
              onChange={(event) => changeSourceLanguage(event.currentTarget.value)}>
              {PICKER_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{t(language.label)} · {language.english}</option>)}
            </select>
          </label>
          <LanguagePicker label={t("번역 언어")} value={targetLanguages} onChange={changeTargetLanguages}
            excludedLanguages={[sourceLanguage]} minSelection={1} maxSelection={GLOSSARY_REGISTRATION_LANGUAGES.length - 1} isDisabled={isBusy} />
          <div className={styles.registrationActions}>
            <button type="button" disabled={isBusy || targetLanguages.length === 0} onClick={generatePrompt}>{t("프롬프트 생성")}</button>
            <button type="button" disabled={isBusy || !prompt} onClick={copyPrompt}>{t("프롬프트 복사")}</button>
          </div>
          <label htmlFor={promptId}>{t("생성된 프롬프트")}</label>
          <textarea id={promptId} name="extractionPrompt" readOnly value={prompt} rows={6} wrap="off"
            placeholder={t("프롬프트 생성 버튼을 누르면 여기에 표시됩니다.")} />
        </div>
        <p>{t("2단계 — AI 툴이 만들어 준 결과(프롬프트가 안내한 구조)를 붙여 넣고 검증한 뒤 등록합니다.")}</p>
        <div className={styles.registrationForm}>
          <label htmlFor={pasteId}>{t("결과 붙여넣기")}</label>
          <textarea id={pasteId} name="pastedGlossary" value={pasted} rows={8} wrap="off" disabled={isBusy}
            onChange={(event) => { setPasted(event.currentTarget.value); setValidatedPaste(null); }}
            placeholder={t("AI 툴이 출력한 결과 전체를 붙여 넣으세요.")} />
        </div>
        {preview && (
          <div className={styles.importPreview}>
            <strong>{preview.name}</strong>
            <span>{t("용어 {count}개", { count: preview.termCount })}</span>
            <span className={styles.languageTags}>
              {preview.languageTags.map((tag) => <span key={tag} className={styles.languageTag}>{formatGlossaryLanguageTag(tag, t)}</span>)}
            </span>
          </div>
        )}
        </div>
        <footer className={styles.registrationFooter}>
          <p role="status" aria-live="polite">{formatGlossaryStatus(localNotice || statusMessage, t)}</p>
          <div className={styles.registrationActions}>
            <button type="button" disabled={isBusy || !pasted.trim()} onClick={() => { setLocalNotice(""); setValidatedPaste(pasted); onValidate(pasted); }}>{t("검증")}</button>
            <button type="button" disabled={isBusy || !preview || validatedPaste !== pasted} onClick={() => { setLocalNotice(""); if (validatedPaste === pasted) onRegister(); }}>{t("언어집 등록")}</button>
          </div>
        </footer>
      </dialog>
    </div>, document.body,
  );
}
