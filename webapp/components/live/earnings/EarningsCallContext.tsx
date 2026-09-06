"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages } from "@/lib/system-language/records-messages";

import type { LiveSessionStatus } from "@/lib/live-contract";
import { EarningsCallHeader } from "./EarningsCallHeader";
import { EarningsSectionNav } from "./EarningsSectionNav";
import { SelectedTranscriptSearch } from "./SelectedTranscriptSearch";
import { hasEarningsContext, type EarningsEventPresentation, type SearchableCaption } from "./earnings-presentation";
import styles from "./earnings.module.css";

const STATUS_LABELS: Record<LiveSessionStatus, string> = {
  preparing: "시작 준비 중", live: "실시간 진행 중", paused: "일시 정지", stopped: "종료", failed: "진행 상태 확인 필요",
};

export function EarningsCallContext({ event, sessionStatus, captions, laneLabel, targetId }: {
  event: EarningsEventPresentation;
  sessionStatus: LiveSessionStatus;
  captions: readonly SearchableCaption[];
  laneLabel: string;
  targetId: string;
}) {
  const t = useSystemText(recordsMessages);
  if (!hasEarningsContext(event)) return null;
  return (
    <section className={styles.context} aria-label={t("실적 발표 현재 정보")}>
      <EarningsCallHeader event={event} statusLabel={t(STATUS_LABELS[sessionStatus])} />
      <EarningsSectionNav activeSection={event.activeSection} targetId={targetId} />
      <SelectedTranscriptSearch captions={captions} laneLabel={laneLabel} />
    </section>
  );
}
