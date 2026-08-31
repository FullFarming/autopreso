"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { glossaryMessages, formatGlossaryStatus } from "@/lib/system-language/glossary-messages";

import { useMemo } from "react";

import { buildGlossaryValidationSummary, type GlossaryValidationIssue } from "./glossary-presentation";
import styles from "./glossary.module.css";

export function GlossaryValidationSummary({
  issues,
  onRequestFocus = (fieldId) => document.getElementById(fieldId)?.focus(),
}: {
  readonly issues: readonly GlossaryValidationIssue[];
  readonly onRequestFocus?: (fieldId: string) => void;
}) {
  const t = useSystemText(glossaryMessages);
  const summary = useMemo(() => buildGlossaryValidationSummary(issues), [issues]);
  if (issues.length === 0) return <p className={styles.validationOk} role="status">{t("검증을 통과했습니다.")}</p>;
  return (
    <section className={styles.validation} role="alert" aria-labelledby="glossary-validation-title">
      <h3 id="glossary-validation-title">{t("검증 결과")}</h3>
      <p>{t("{errors}개 오류 · {warnings}개 확인", { errors: summary.errorCount, warnings: summary.warningCount })}</p>
      <ul>
        {issues.map((issue) => <li key={issue.id}>
          <button type="button" onClick={() => onRequestFocus(issue.fieldId)}>
            <strong>{issue.severity === "error" ? t("오류") : t("확인")}</strong><span>{formatGlossaryStatus(issue.message, t)}</span>
          </button>
        </li>)}
      </ul>
    </section>
  );
}
