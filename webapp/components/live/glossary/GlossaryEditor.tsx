"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { glossaryMessages } from "@/lib/system-language/glossary-messages";

import { useEffect, useMemo, useState } from "react";
import {
  GLOSSARY_TERM_PAGE_SIZE,
  applyGlossaryTermDraft,
  createGlossaryDraftEdits,
  createGlossaryTermWindow,
  type GlossaryDraftEdits,
  type GlossaryPresetPresentation,
  type GlossaryTermDraftField,
  type GlossaryTermDrafts,
  type GlossaryTermPresentation,
} from "./glossary-presentation";
import { GlossaryTermRows } from "./GlossaryTermRows";
import styles from "./glossary.module.css";

interface GlossaryEditorProps {
  readonly preset: GlossaryPresetPresentation;
  readonly terms: readonly GlossaryTermPresentation[];
  readonly onSaveDraft: (edits: GlossaryDraftEdits) => void;
  readonly onAddTerm: () => void;
  readonly onRemoveTerm: (termId: string) => void;
  readonly onApproveCandidate: (termId: string) => void;
  readonly onRejectCandidate: (termId: string) => void;
  readonly focusRequest?: Readonly<{ fieldId: string; sequence: number }> | null;
  readonly isBusy?: boolean;
}

export function GlossaryEditor(props: GlossaryEditorProps) {
  const t = useSystemText(glossaryMessages);
  const [query, setQuery] = useState("");
  const [pageStart, setPageStart] = useState(0);
  const [drafts, setDrafts] = useState<GlossaryTermDrafts>({});
  const termWindow = useMemo(() => createGlossaryTermWindow(props.terms, query, pageStart, drafts), [drafts, pageStart, props.terms, query]);

  useEffect(() => {
    const fieldId = props.focusRequest?.fieldId;
    const match = fieldId?.match(/^glossary-term-(?:source|target|aliases)-(\d+)$/u);
    if (!fieldId || !match) return;
    const index = Number(match[1]);
    setQuery("");
    setPageStart(Math.floor(index / GLOSSARY_TERM_PAGE_SIZE) * GLOSSARY_TERM_PAGE_SIZE);
    const timer = window.setTimeout(() => document.getElementById(fieldId)?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [props.focusRequest]);

  useEffect(() => {
    if (pageStart > 0 && termWindow.items.length === 0) setPageStart(Math.max(0, pageStart - GLOSSARY_TERM_PAGE_SIZE));
  }, [pageStart, termWindow.items.length]);

  const updateDraft = (termId: string, field: GlossaryTermDraftField, value: string) => {
    setDrafts((current) => applyGlossaryTermDraft(current, termId, field, value));
  };
  return (
    <form className={styles.editor} aria-labelledby="glossary-editor-title" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      props.onSaveDraft({
        name: String(data.get("presetName") ?? ""),
        domain: String(data.get("domain") ?? ""),
        terms: createGlossaryDraftEdits(props.terms, drafts),
      });
    }}>
      <div className={styles.sectionHeading}>
        <div><h2 id="glossary-editor-title">{t("용어집 편집")}</h2><span>{t("편집 내용을 저장하면 새 버전이 만들어집니다.")}</span></div>
        <button type="submit" disabled={props.isBusy}>{t("새 버전 저장")}</button>
      </div>
      <div className={styles.metadataGrid}>
        <label htmlFor="glossary-preset-name"><span>{t("이름")}</span><input id="glossary-preset-name" name="presetName" defaultValue={props.preset.name} disabled={props.isBusy} required /></label>
        <label htmlFor="glossary-preset-domain"><span>{t("분야")}</span><input id="glossary-preset-domain" name="domain" defaultValue={props.preset.domain} disabled={props.isBusy} /></label>
        <div><span>{t("언어")}</span><strong>{props.preset.languagePairLabel}</strong></div>
      </div>
      <div className={styles.termSearch}>
        <label htmlFor="glossary-term-search"><span>{t("용어 검색")}</span><input id="glossary-term-search" name="glossaryTermSearch" type="search" value={query}
          onChange={(event) => { setQuery(event.currentTarget.value); setPageStart(0); }} disabled={props.isBusy} autoComplete="off" aria-controls="glossary-term-list" /></label>
        <span aria-live="polite">{t("검색 결과 {count}개", { count: termWindow.totalMatchCount })}</span>
      </div>
      <GlossaryTermRows window={termWindow} drafts={drafts} isBusy={props.isBusy} onAddTerm={props.onAddTerm} onRemoveTerm={props.onRemoveTerm}
        onApproveCandidate={props.onApproveCandidate} onRejectCandidate={props.onRejectCandidate} onChangeDraft={updateDraft}
        onPrevious={() => setPageStart((current) => Math.max(0, current - GLOSSARY_TERM_PAGE_SIZE))}
        onNext={() => setPageStart((current) => current + GLOSSARY_TERM_PAGE_SIZE)} />
    </form>
  );
}
