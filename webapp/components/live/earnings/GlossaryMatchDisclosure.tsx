"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages } from "@/lib/system-language/records-messages";

import styles from "./earnings.module.css";

export interface GlossaryMatchPresentation {
  readonly id: string;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly count: number;
}

export function GlossaryMatchDisclosure({ matches }: { matches: readonly GlossaryMatchPresentation[] }) {
  const t = useSystemText(recordsMessages);
  if (matches.length === 0) return null;
  return (
    <details className={styles.glossary}>
      <summary>{t("용어 일치 · {count}", { count: matches.length })}</summary>
      <ul>{matches.map((match) => <li key={match.id}><span>{match.sourceLabel}</span><span>{match.targetLabel}</span><small>{t("{count}회", { count: match.count })}</small></li>)}</ul>
    </details>
  );
}
