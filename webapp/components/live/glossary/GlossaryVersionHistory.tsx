"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { glossaryMessages } from "@/lib/system-language/glossary-messages";

import type { GlossaryVersionPresentation } from "./glossary-presentation";
import styles from "./glossary.module.css";

interface GlossaryVersionHistoryProps {
  readonly versions: readonly GlossaryVersionPresentation[];
  readonly onActivate: (version: number) => void;
  readonly isBusy?: boolean;
}

export function GlossaryVersionHistory({ versions, onActivate, isBusy = false }: GlossaryVersionHistoryProps) {
  const t = useSystemText(glossaryMessages);
  return (
    <details className={styles.disclosure}>
      <summary>{t("버전 기록")}</summary>
      <ol className={styles.versionList}>
        {versions.map((version) => <li key={version.id}>
          <div><strong>{t("버전 {version}", { version: version.version })}</strong><span>{t(version.createdAtLabel)}{version.termCount === null ? "" : ` · ${t("{count}개", { count: version.termCount })}`}</span></div>
          {version.state === "active" ? <span className={styles.statusChip}>{t("활성")}</span> : (
            <button type="button" disabled={isBusy} onClick={() => onActivate(version.version)}>{t("버전 활성화")}</button>
          )}
        </li>)}
      </ol>
    </details>
  );
}
