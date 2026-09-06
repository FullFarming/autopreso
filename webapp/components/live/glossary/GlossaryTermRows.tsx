"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { glossaryMessages } from "@/lib/system-language/glossary-messages";

import type { GlossaryTermDraftField, GlossaryTermDrafts, GlossaryTermWindowItem } from "./glossary-presentation";
import styles from "./glossary.module.css";

interface GlossaryTermRowsProps {
  readonly window: Readonly<{ items: readonly GlossaryTermWindowItem[]; totalMatchCount: number; hasPrevious: boolean; hasNext: boolean }>;
  readonly drafts: GlossaryTermDrafts;
  readonly onAddTerm: () => void;
  readonly onRemoveTerm: (termId: string) => void;
  readonly onApproveCandidate: (termId: string) => void;
  readonly onRejectCandidate: (termId: string) => void;
  readonly onChangeDraft: (termId: string, field: GlossaryTermDraftField, value: string) => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly isBusy?: boolean;
}

export function GlossaryTermRows(props: GlossaryTermRowsProps) {
  const t = useSystemText(glossaryMessages);
  return (
    <section className={styles.termSection} aria-labelledby="glossary-term-title">
      <div className={styles.sectionHeading}>
        <div><h3 id="glossary-term-title">{t("용어")}</h3><span>{t("{count}개", { count: props.window.totalMatchCount })}</span></div>
        <button type="button" disabled={props.isBusy} onClick={props.onAddTerm}>{t("용어 추가")}</button>
      </div>
      <div className={styles.termHeader} aria-hidden="true"><span>{t("원문")}</span><span>{t("번역어")}</span><span>{t("별칭")}</span><span>{t("상태와 작업")}</span></div>
      <ol id="glossary-term-list" className={styles.termList}>
        {props.window.items.map(({ term, index }) => (
          <li key={term.id} className={styles.termRow} data-status={term.status}>
            <label htmlFor={`glossary-term-source-${index}`}><span>{t("원문")}</span><input id={`glossary-term-source-${index}`} name="sourceTerm"
              value={props.drafts[term.id]?.source ?? term.source} onChange={(event) => props.onChangeDraft(term.id, "source", event.currentTarget.value)} disabled={props.isBusy} /></label>
            <div className={styles.termTranslations}>
              {Object.entries(term.translations ?? { target: term.target }).map(([language, value]) => (
                <label key={language} htmlFor={`glossary-term-target-${index}-${language}`}>
                  <span>{t("번역어")} {language === "target" ? "" : language}</span>
                  <input id={`glossary-term-target-${index}-${language}`} name={`targetTerm-${language}`}
                    value={props.drafts[term.id]?.[language === "target" ? "target" : `translation:${language}`] ?? value}
                    onChange={(event) => props.onChangeDraft(term.id, language === "target" ? "target" : `translation:${language}`, event.currentTarget.value)}
                    disabled={props.isBusy || term.doNotTranslate} />
                </label>
              ))}
              <label className={styles.termProtection}>
                <input type="checkbox" checked={Boolean(term.doNotTranslate)} disabled={props.isBusy}
                  onChange={(event) => props.onChangeDraft(term.id, "doNotTranslate", String(event.currentTarget.checked))} />
                <span>원문 유지</span>
              </label>
            </div>
            <label htmlFor={`glossary-term-aliases-${index}`}><span>{t("별칭")}</span><input id={`glossary-term-aliases-${index}`} name="aliases"
              value={props.drafts[term.id]?.aliases ?? term.aliases.join(", ")} onChange={(event) => props.onChangeDraft(term.id, "aliases", event.currentTarget.value)} disabled={props.isBusy} /></label>
            <div className={styles.termActions}>
              <span className={styles.statusChip}>{term.status === "candidate" ? t("승인 대기") : t("승인됨")}</span>
              {term.status === "candidate" ? <>
                <button type="button" disabled={props.isBusy} onClick={() => props.onApproveCandidate(term.id)}>{t("후보 승인")}</button>
                <button type="button" disabled={props.isBusy} onClick={() => props.onRejectCandidate(term.id)}>{t("후보 제외")}</button>
              </> : <button type="button" disabled={props.isBusy} onClick={() => props.onRemoveTerm(term.id)}>{t("삭제")}</button>}
            </div>
          </li>
        ))}
      </ol>
      {props.window.items.length === 0 && <p className={styles.empty} role="status">{t("일치하는 용어가 없습니다.")}</p>}
      <nav className={styles.termPagination} aria-label={t("용어 목록 페이지")}>
        <button type="button" disabled={props.isBusy || !props.window.hasPrevious} onClick={props.onPrevious}>{t("이전 50개 보기")}</button>
        <button type="button" disabled={props.isBusy || !props.window.hasNext} onClick={props.onNext}>{t("다음 50개 보기")}</button>
      </nav>
    </section>
  );
}
