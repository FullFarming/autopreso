"use client";

import { useId } from "react";

import { CaptionEntry } from "./CaptionEntry";
import styles from "./translation.module.css";
import { boundedTopicAnnouncement, type TopicPresentation } from "./topic-presentation";

interface CurrentTopicPanelProps {
  topic: TopicPresentation | null;
  state?: "ready" | "empty" | "degraded";
  emptyLabel?: string;
  degradedLabel?: string;
  announcement?: string;
  ariaLabel?: string;
  statusLabel?: string;
  captionsEmptyLabel?: string;
}

export function CurrentTopicPanel({
  topic,
  state = "ready",
  emptyLabel = "The current topic will appear here",
  degradedLabel = "The current topic is temporarily unavailable",
  announcement,
  ariaLabel = "Current topic",
  statusLabel = "In progress",
  captionsEmptyLabel = "Captions will appear here",
}: CurrentTopicPanelProps) {
  const titleId = useId();
  const liveAnnouncement = boundedTopicAnnouncement(announcement ?? topic?.title ?? "");

  return (
    <section className={styles.topicPanel} aria-label={ariaLabel} aria-labelledby={topic ? titleId : undefined}>
      {topic && (
        <header className={styles.topicHeader}>
          <span className={styles.statusChip}>{statusLabel}</span>
          <h2 id={titleId} className={styles.topicTitle}>{topic.title}</h2>
          {topic.timeLabel && <time className={styles.topicMeta}>{topic.timeLabel}</time>}
        </header>
      )}
      {state === "degraded" && <p className={styles.topicAlert} role="alert">{degradedLabel}</p>}
      {!topic || state === "empty" ? (
        <p className={styles.topicState} role="status">{emptyLabel}</p>
      ) : topic.captions.length === 0 ? (
        <p className={styles.topicState} role="status">{captionsEmptyLabel}</p>
      ) : (
        <div className={styles.topicCaptions}>
          {topic.captions.map((caption) => (
            <div key={caption.id} data-utterance-key={caption.utteranceKey ?? caption.id}>
              <CaptionEntry {...caption} />
            </div>
          ))}
        </div>
      )}
      <p className={styles.srOnly} aria-live="polite" aria-atomic="true">{liveAnnouncement}</p>
    </section>
  );
}
