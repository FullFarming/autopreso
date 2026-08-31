"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { viewerMessages } from "@/lib/system-language/viewer-messages";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef } from "react";

import styles from "./translation.module.css";
import { getNativeLanguageLabel } from "../language-picker";
import {
  dedupeEquivalentTranslationLanes,
  type TranslationLanePresentation,
} from "./topic-presentation";

interface TranslationLaneTabsProps {
  lanes: readonly TranslationLanePresentation[];
  selectedLaneId: string;
  onChange: (lane: TranslationLanePresentation) => void;
  renderPanel: (lane: TranslationLanePresentation) => ReactNode;
  ariaLabel?: string;
  emptyLabel?: string;
  participantControls?: boolean;
}

export function TranslationLaneTabs({
  lanes,
  selectedLaneId,
  onChange,
  renderPanel,
  ariaLabel,
  emptyLabel,
  participantControls = false,
}: TranslationLaneTabsProps) {
  const t = useSystemText(viewerMessages);
  const id = useId().replaceAll(":", "");
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const options = useMemo(() => dedupeEquivalentTranslationLanes(lanes), [lanes]);
  const selectedIndex = Math.max(0, options.findIndex((lane) => lane.id === selectedLaneId));

  useEffect(() => {
    const selected = options[selectedIndex];
    if (selected && selected.id !== selectedLaneId) onChange(selected);
  }, [onChange, options, selectedIndex, selectedLaneId]);

  function selectByKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % options.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + options.length) % options.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = options.length - 1;
    else return;
    event.preventDefault();
    const next = options[nextIndex];
    if (!next) return;
    onChange(next);
    tabRefs.current.get(next.id)?.focus();
  }

  if (options.length === 0) return <p className={styles.topicState} role="status">{emptyLabel ?? t("사용 가능한 자막 언어가 없습니다.")}</p>;

  return (
    <section className={styles.laneTabs} aria-label={ariaLabel ?? t("자막 언어")}>
      <div className={styles.laneTabList} data-participant-controls={participantControls || undefined} role="tablist" aria-label={ariaLabel ?? t("자막 언어")}>
        {options.map((lane, index) => {
          const isSelected = index === selectedIndex;
          return (
            <button
              key={lane.id}
              ref={(node) => { if (node) tabRefs.current.set(lane.id, node); else tabRefs.current.delete(lane.id); }}
              id={`${id}-tab-${encodeURIComponent(lane.id)}`}
              className={styles.laneTab}
              type="button"
              role="tab"
              lang={lane.kind === "translation" ? lane.language : undefined}
              aria-selected={isSelected}
              aria-controls={`${id}-panel-${encodeURIComponent(lane.id)}`}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onChange(lane)}
              onKeyDown={(event) => selectByKeyboard(event, index)}
            >
              {lane.kind === "source" ? t("원문") : getNativeLanguageLabel(lane.language)}
            </button>
          );
        })}
      </div>
      {options[selectedIndex] && (
        <div id={`${id}-panel-${encodeURIComponent(options[selectedIndex].id)}`} className={styles.lanePanel}
          role="tabpanel" aria-labelledby={`${id}-tab-${encodeURIComponent(options[selectedIndex].id)}`}>
          {renderPanel(options[selectedIndex])}
        </div>
      )}
    </section>
  );
}
