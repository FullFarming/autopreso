"use client";

import { useSystemLanguage, useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages, formatSystemRecordTime } from "@/lib/system-language/records-messages";

import { SECTION_LABELS, type EarningsEventPresentation } from "./earnings-presentation";
import styles from "./earnings.module.css";

export function EarningsCallHeader({ event, statusLabel }: {
  event: EarningsEventPresentation;
  statusLabel?: string;
}) {
  const t = useSystemText(recordsMessages);
  const { language } = useSystemLanguage();
  const activeLabel = event.activeSection ? SECTION_LABELS[event.activeSection] : null;
  const sectionTime = formatSystemRecordTime(event.sectionStartedAt, language);
  return (
    <header className={styles.header} aria-label={t("실적 발표 정보")}>
      <div>
        <span className={styles.eyebrow}>{t("실적 발표")}</span>
        <strong>{event.companyName || t("회사 정보 미정")}{event.ticker ? ` · ${event.ticker}` : ""}</strong>
        {event.fiscalPeriod && <span>{event.fiscalPeriod}</span>}
      </div>
      <p className={styles.status} role="status" aria-live="polite">
        {statusLabel || t(activeLabel || "진행 정보 준비 중")}
        {sectionTime && <time dateTime={event.sectionStartedAt ?? undefined}> · {sectionTime}</time>}
      </p>
    </header>
  );
}
