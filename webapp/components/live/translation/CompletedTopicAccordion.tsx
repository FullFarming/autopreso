"use client";

import { useEffect, useMemo, useState } from "react";

import { CaptionEntry } from "./CaptionEntry";
import styles from "./translation.module.css";
import { boundedTopicAnnouncement, dedupeTopicPresentations, topicDomId, type TopicPresentation } from "./topic-presentation";

interface CompletedTopicAccordionProps {
  topics: readonly TopicPresentation[];
  selectedLaneLabel: string;
  state?: "ready" | "empty" | "degraded";
  emptyLabel?: string;
  degradedLabel?: string;
  announcement?: string;
  ariaLabel?: string;
  captionCountLabel?: (count: number) => string;
  noCaptionsLabel?: string;
  expandedTopicIds?: readonly string[];
  onExpandedChange?: (topicId: string, isExpanded: boolean) => void;
}

export function CompletedTopicAccordion({
  topics,
  selectedLaneLabel,
  state = "ready",
  emptyLabel = "Completed topics will appear here",
  degradedLabel = "Some completed topics are temporarily unavailable",
  announcement = "",
  ariaLabel = "Completed topics",
  captionCountLabel = (count) => `${count} captions`,
  noCaptionsLabel = "No captions",
  expandedTopicIds,
  onExpandedChange,
}: CompletedTopicAccordionProps) {
  const [visibleCount, setVisibleCount] = useState(40);
  const [localExpandedTopicIds, setLocalExpandedTopicIds] = useState<readonly string[]>([]);
  useEffect(() => setVisibleCount(40), [topics]);
  const uniqueTopics = useMemo(() => dedupeTopicPresentations(topics), [topics]);
  const visibleTopics = uniqueTopics.slice(0, visibleCount);
  const expandedTopicSet = useMemo(() => new Set(expandedTopicIds ?? localExpandedTopicIds), [expandedTopicIds, localExpandedTopicIds]);
  const updateExpanded = (topicId: string, isExpanded: boolean) => {
    if (expandedTopicIds === undefined) {
      setLocalExpandedTopicIds((current) => isExpanded
        ? current.includes(topicId) ? current : [...current, topicId]
        : current.filter((id) => id !== topicId));
    }
    onExpandedChange?.(topicId, isExpanded);
  };
  return (
    <section className={styles.topicAccordion} aria-label={`${ariaLabel} · ${selectedLaneLabel}`}>
      {state === "degraded" && <p className={styles.topicAlert} role="alert">{degradedLabel}</p>}
      {topics.length === 0 || state === "empty" ? (
        <p className={styles.topicState} role="status">{emptyLabel}</p>
      ) : visibleTopics.map((topic) => {
        const isExpanded = expandedTopicSet.has(topic.id);
        return (
          <details key={topic.id} className={styles.completedTopic}
            id={topicDomId(topic.id)} open={isExpanded}
            onToggle={(event) => updateExpanded(topic.id, event.currentTarget.open)}>
            <summary>
              <span className={styles.topicSummaryRow}>
                <strong>{topic.title}</strong>
                {topic.timeLabel && <time>{topic.timeLabel}</time>}
                <span>{captionCountLabel(topic.captions.length)}</span>
              </span>
            </summary>
            {isExpanded && (
              <div className={styles.completedTopicBody}>
                {topic.summary && <p className={styles.topicSummaryText}>{topic.summary}</p>}
                {topic.captions.length === 0 ? (
                  <p className={styles.topicState}>{noCaptionsLabel} · {selectedLaneLabel}</p>
                ) : (
                  <div className={styles.topicCaptions}>
                    {topic.captions.map((caption) => (
                      <div key={caption.id} data-utterance-key={caption.utteranceKey ?? caption.id}>
                        <CaptionEntry {...caption} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </details>
        );
      })}
      {visibleCount < uniqueTopics.length && (
        <button type="button" className={styles.loadMoreTopics}
          onClick={() => setVisibleCount((count) => Math.min(count + 40, uniqueTopics.length))}>
          주제 더 보기
        </button>
      )}
      <p className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {boundedTopicAnnouncement(announcement)}
      </p>
    </section>
  );
}
