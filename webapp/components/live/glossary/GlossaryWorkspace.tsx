"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { glossaryMessages, formatGlossaryStatus } from "@/lib/system-language/glossary-messages";


import { useState } from "react";
import type {
  GlossaryImportPreviewPresentation,
  GlossaryPresetPresentation,
  GlossaryTermPresentation,
  GlossaryValidationIssue,
  GlossaryVersionPresentation,
  GlossaryDraftEdits,
} from "./glossary-presentation";
import { GlossaryEditor } from "./GlossaryEditor";
import { GlossaryImportPreview } from "./GlossaryImportPreview";
import { GlossaryRegistrationDialog, type GlossaryRegistrationPreview } from "./GlossaryRegistrationDialog";
import { GlossaryPresetList } from "./GlossaryPresetList";
import { GlossaryValidationSummary } from "./GlossaryValidationSummary";
import { GlossaryVersionHistory } from "./GlossaryVersionHistory";
import styles from "./glossary.module.css";

export interface GlossaryWorkspaceProps {
  readonly presets: readonly GlossaryPresetPresentation[];
  readonly selectedPreset: GlossaryPresetPresentation;
  readonly terms: readonly GlossaryTermPresentation[];
  readonly versions: readonly GlossaryVersionPresentation[];
  readonly validationIssues: readonly GlossaryValidationIssue[];
  readonly importPreview: GlossaryImportPreviewPresentation | null;
  readonly registrationPreview: GlossaryRegistrationPreview | null;
  readonly registrationStatus: string;
  readonly sessionSelectionLabel: string;
  readonly onSelectPreset: (presetId: string) => void;
  readonly isBusy?: boolean;
  readonly onAction: (action: GlossaryWorkspaceAction) => void;
}

export type GlossaryWorkspaceAction =
  | { readonly type: "create" | "duplicate" | "export" | "confirm-import" | "confirm-registration" | "close-registration" }
  | { readonly type: "validate-registration"; readonly text: string }
  | { readonly type: "select-session" | "activate-version"; readonly version: number }
  | { readonly type: "save-draft"; readonly edits: GlossaryDraftEdits }
  | { readonly type: "add-term" }
  | { readonly type: "remove-term" | "approve-candidate" | "reject-candidate"; readonly termId: string }
  | { readonly type: "choose-import" | "extract-pdf"; readonly file: File };

export function GlossaryWorkspace(props: GlossaryWorkspaceProps) {
  const t = useSystemText(glossaryMessages);
  const action = props.onAction;
  const [focusRequest, setFocusRequest] = useState<{ fieldId: string; sequence: number } | null>(null);
  const [isRegistrationOpen, setRegistrationOpen] = useState(false);
  const closeRegistration = () => { setRegistrationOpen(false); action({ type: "close-registration" }); };
  return (
    <section className={styles.workspace} aria-label={t("용어집 관리")} aria-busy={props.isBusy}>
      <GlossaryPresetList presets={props.presets} selectedPresetId={props.selectedPreset.id}
        isBusy={props.isBusy} onSelect={props.onSelectPreset} onCreate={() => action({ type: "create" })} />
      <div className={styles.content}>
        <div className={styles.workspaceActions}>
          <div><strong>{props.selectedPreset.name}</strong><span>{formatGlossaryStatus(props.sessionSelectionLabel, t)}</span></div>
          <button type="button" disabled={props.isBusy} onClick={() => setRegistrationOpen(true)}>{t("언어집 등록")}</button>
          <button type="button" disabled={props.isBusy} onClick={() => action({ type: "duplicate" })}>{t("복제")}</button>
          <button type="button" disabled={props.isBusy} onClick={() => action({ type: "export" })}>{t("내보내기")}</button>
          <button type="button" disabled={props.isBusy || props.selectedPreset.activeVersion === null}
            onClick={() => props.selectedPreset.activeVersion && action({ type: "select-session", version: props.selectedPreset.activeVersion })}>{t("세션에 사용")}</button>
        </div>
        <GlossaryValidationSummary issues={props.validationIssues} onRequestFocus={(fieldId) => {
          setFocusRequest((current) => ({ fieldId, sequence: (current?.sequence ?? 0) + 1 }));
        }} />
        <GlossaryEditor key={`${props.selectedPreset.id}-${props.selectedPreset.latestVersion}`} preset={props.selectedPreset} terms={props.terms} isBusy={props.isBusy} onSaveDraft={(edits) => action({ type: "save-draft", edits })}
          onAddTerm={() => action({ type: "add-term" })} onRemoveTerm={(termId) => action({ type: "remove-term", termId })}
          onApproveCandidate={(termId) => action({ type: "approve-candidate", termId })} onRejectCandidate={(termId) => action({ type: "reject-candidate", termId })}
          focusRequest={focusRequest} />
        <div className={styles.secondaryGrid}>
          <GlossaryImportPreview preview={props.importPreview} isBusy={props.isBusy}
            onChooseFile={(file) => action({ type: "choose-import", file })}
            onExtractPdf={(file) => action({ type: "extract-pdf", file })}
            onConfirmImport={() => action({ type: "confirm-import" })} />
          <GlossaryVersionHistory versions={props.versions} isBusy={props.isBusy} onActivate={(version) => action({ type: "activate-version", version })} />
        </div>
        <span className={styles.announcement} aria-live="polite">{formatGlossaryStatus(props.sessionSelectionLabel, t)}</span>
      </div>
      <GlossaryRegistrationDialog isOpen={isRegistrationOpen} isBusy={props.isBusy}
        preview={props.registrationPreview} statusMessage={props.registrationStatus}
        onValidate={(text) => action({ type: "validate-registration", text })}
        onRegister={() => { action({ type: "confirm-registration" }); setRegistrationOpen(false); }}
        onClose={closeRegistration} />
    </section>
  );
}
