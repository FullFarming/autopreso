"use client";

import { Children, type ReactNode, useEffect, useRef, useState } from "react";
import styles from "./translation.module.css";
import { isPinnedToLiveEdge } from "./translation-state";

export type TranslationViewportState =
  | "live"
  | "loading"
  | "paused"
  | "disconnected"
  | "ended"
  | "failed";

interface TranslationViewportProps {
  children: ReactNode;
  state: TranslationViewportState;
  statusLabel?: string;
  statusDescription?: string;
  emptyLabel?: string;
  captionFirstPreview?: string;
  previewLabel?: string;
  finalAnnouncement?: string;
  ariaLabel?: string;
  listLabel?: string;
  density?: "standard" | "compact" | "comfortable";
  isEmpty?: boolean;
}

export function TranslationViewport({
  children,
  state,
  statusLabel,
  statusDescription,
  emptyLabel = "Translations will appear here",
  captionFirstPreview = "",
  previewLabel = "현재 자막",
  finalAnnouncement = "",
  ariaLabel = "Live translations",
  listLabel = "Live translation feed",
  density = "standard",
  isEmpty,
}: TranslationViewportProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isPinned, setIsPinned] = useState(true);
  const hasContent = !(isEmpty ?? (Children.count(children) === 0));
  const previewText = captionFirstPreview.trim().slice(0, 280);
  const hasPreview = previewText.length > 0;
  const resolvedStatusLabel = statusLabel ?? (state === "loading" ? "자막을 불러오는 중입니다."
    : state === "failed" ? "자막을 표시할 수 없습니다. 다시 확인해 주세요."
    : state === "ended" ? "라이브가 종료되었습니다."
    : state === "paused" ? "자막이 일시 정지되었습니다."
    : state === "disconnected" ? "연결을 확인하고 있습니다."
    : "실시간 자막 수신 중");

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || !isPinned) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
  }, [children, isPinned]);

  function jumpToLatest() {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
    setIsPinned(true);
  }

  return (
    <section className={styles.viewport} data-translation-state={state} aria-label={ariaLabel}
      data-caption-first={hasPreview || undefined} data-density={density} aria-busy={state === "loading"}>
      <header className={styles.statusBar} data-status-state={state}>
        <span className={styles.statusDot} aria-hidden="true" />
        <p className={styles.statusText} role="status" aria-live="polite" aria-atomic="true">
          {resolvedStatusLabel}
          {statusDescription && <span>{statusDescription}</span>}
        </p>
      </header>
      {hasPreview && (
        <aside className={styles.preview} aria-label={previewLabel}>
          <span className={styles.previewLabel}>{previewLabel}</span>
          <p className={styles.previewText}>{previewText}</p>
        </aside>
      )}
      <div
        ref={scrollRef}
        className={styles.scroller}
        tabIndex={0}
        role="region"
        aria-label={listLabel}
        onScroll={(event) => setIsPinned(isPinnedToLiveEdge(event.currentTarget))}
      >
        <div className={styles.feed}>{hasContent ? children : <p className={styles.empty}>{emptyLabel}</p>}</div>
      </div>
      {!isPinned && (
        <button className={styles.jumpButton} type="button" onClick={jumpToLatest}>
          최신 자막으로 이동
        </button>
      )}
      <p className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {finalAnnouncement.slice(0, 500)}
      </p>
    </section>
  );
}
