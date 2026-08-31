"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages } from "@/lib/system-language/records-messages";

import type { LiveSessionSection } from "@/lib/live-contract";
import { SECTION_LABELS } from "./earnings-presentation";
import styles from "./earnings.module.css";

const SECTIONS = Object.entries(SECTION_LABELS) as [LiveSessionSection, string][];

export function EarningsSectionNav({ activeSection, targetId }: {
  activeSection?: LiveSessionSection | null;
  targetId: string;
}) {
  const t = useSystemText(recordsMessages);
  const activeIndex = SECTIONS.findIndex(([section]) => section === activeSection);
  return (
    <nav className={styles.sectionNav} aria-label={t("실적 발표 구간")}>
      <ol>
        {SECTIONS.map(([section, label], index) => {
          const state = section === activeSection ? "current" : activeIndex < 0 ? "waiting" : index < activeIndex ? "completed" : "upcoming";
          const stateLabel = t(state === "completed" ? "완료" : state === "upcoming" ? "예정" : "대기");
          return (
            <li key={section} data-section-state={state}>
              {section === activeSection ? (
                <a href={`#${targetId}`} aria-current="location"><span>{t(label)}</span><small>{t("현재")}</small></a>
              ) : (
                <span aria-label={`${t(label)} · ${stateLabel}`}><span>{t(label)}</span><small>{stateLabel}</small></span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
