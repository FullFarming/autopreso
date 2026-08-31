"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { glossaryMessages } from "@/lib/system-language/glossary-messages";

import { useId } from "react";

import type { GlossaryImportPreviewPresentation } from "./glossary-presentation";
import styles from "./glossary.module.css";

interface GlossaryImportPreviewProps {
  readonly preview: GlossaryImportPreviewPresentation | null;
  readonly onChooseFile: (file: File) => void;
  readonly onConfirmImport: () => void;
  readonly onExtractPdf: (file: File) => void;
  readonly isBusy?: boolean;
}

export function GlossaryImportPreview({ preview, onChooseFile, onConfirmImport, onExtractPdf, isBusy = false }: GlossaryImportPreviewProps) {
  const t = useSystemText(glossaryMessages);
  const inputId = useId();
  const pdfInputId = useId();
  return (
    <details className={styles.disclosure}>
      <summary>{t("가져오기 미리보기")}</summary>
      <div className={styles.disclosureBody}>
        <label htmlFor={inputId}>{t("용어집 파일")}</label>
        <input id={inputId} name="glossaryImport" className={styles.fileInput} type="file" accept="application/json,.json" disabled={isBusy}
          onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onChooseFile(file); }} />
        <label htmlFor={pdfInputId}>{t("PDF에서 AI 후보 추출")}</label>
        <input id={pdfInputId} name="glossaryPdf" className={styles.fileInput} type="file" accept="application/pdf,.pdf" disabled={isBusy}
          onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onExtractPdf(file); }} />
        {preview ? <div className={styles.importPreview} aria-live="polite">
          <strong>{preview.fileName}</strong>
          <dl><div><dt>{t("승인 용어")}</dt><dd>{preview.approvedCount}</dd></div><div><dt>{t("AI 후보")}</dt><dd>{preview.candidateCount}</dd></div><div><dt>{t("제외")}</dt><dd>{preview.ignoredCount}</dd></div></dl>
          <button type="button" disabled={isBusy} onClick={onConfirmImport}>{t("새 용어집으로 저장")}</button>
        </div> : <p role="status">{t("선택한 파일의 구조와 용어 수를 저장 전에 확인합니다.")}</p>}
      </div>
    </details>
  );
}
