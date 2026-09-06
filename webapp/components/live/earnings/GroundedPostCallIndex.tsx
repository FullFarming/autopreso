"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages } from "@/lib/system-language/records-messages";

import { useMemo, useState } from "react";
import type { LiveAgendaItem } from "@/lib/live-contract";
import { topicDomId } from "../translation";
import { buildGroundedPostCallIndex, type IndexedTopic } from "./earnings-presentation";
import styles from "./earnings.module.css";

const PAGE_SIZE = 40;

export function GroundedPostCallIndex({ agenda, topics }: {
  agenda: readonly LiveAgendaItem[];
  topics: readonly IndexedTopic[];
}) {
  const t = useSystemText(recordsMessages);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const index = useMemo(() => buildGroundedPostCallIndex(agenda, topics, visibleCount), [agenda, topics, visibleCount]);
  return (
    <nav className={styles.postCallIndex} aria-label={t("회의 인덱스")}>
      <h3>{t("회의 인덱스")}</h3>
      {index.agenda.length > 0 && <ol>{index.agenda.map((item) => <li key={`${item.ordinal}-${item.label}`}>{item.label}</li>)}</ol>}
      <ul>{index.visibleTopics.map((topic) => <li key={topic.id}><a href={`#${topicDomId(topic.id)}`}>{topic.title}</a></li>)}</ul>
      {index.visibleTopics.length < index.totalTopicCount && (
        <button type="button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>{t("주제 더 보기")}</button>
      )}
    </nav>
  );
}
