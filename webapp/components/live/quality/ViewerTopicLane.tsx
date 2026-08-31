import { useMemo } from "react";

import type { LiveSessionStatus } from "@/lib/live-contract";
import type { LiveTopicState } from "@/lib/live/topic-state";
import { CompletedTopicAccordion, CurrentTopicPanel, TranslationViewport,
  type TopicPresentation, type TranslationLanePresentation } from "../translation";
import { composeViewerTopics } from "../viewer-topic-composition";

interface ViewerTopicLaneProps {
  lane: TranslationLanePresentation;
  captions: TopicPresentation["captions"];
  topicState: LiveTopicState | null;
  sessionStatus: LiveSessionStatus;
  statusLabel?: string;
  expandedTopicIds: readonly string[];
  onExpandedTopicChange: (topicId: string, isExpanded: boolean) => void;
}

export function ViewerTopicLane({
  lane, captions, topicState, sessionStatus, statusLabel, expandedTopicIds, onExpandedTopicChange,
}: ViewerTopicLaneProps) {
  const composition = useMemo(() => composeViewerTopics(captions, topicState), [captions, topicState]);
  const isDegraded = topicState?.topics.some((topic) => topic.detectorHealth === "degraded") ?? false;
  const viewportState = sessionStatus === "paused" ? "paused" : sessionStatus === "live" ? "live" : "disconnected";
  const previewCaption = captions.at(-1);
  return (
    <TranslationViewport state={viewportState} isEmpty={captions.length === 0}
      statusLabel={sessionStatus === "live" ? undefined : statusLabel}
      statusDescription={isDegraded ? "주제 분류 지연" : undefined}
      captionFirstPreview={previewCaption?.text ?? ""}
      previewLabel={`${lane.label} 현재 자막`}
      finalAnnouncement={captions.findLast((caption) => caption.isFinal)?.text}
      emptyLabel="실시간 자막이 여기에 표시됩니다." ariaLabel={`${lane.label} 실시간 자막`}
      listLabel={`${lane.label} 자막 목록`} density="compact">
      <div className="live-viewer-topic-flow">
        <CurrentTopicPanel topic={composition.active}
          state={isDegraded ? "degraded" : composition.active ? "ready" : "empty"}
          ariaLabel="진행 중인 주제" statusLabel="진행 중"
          emptyLabel="진행 중인 주제를 기다리고 있습니다."
          degradedLabel="주제 분류가 지연되고 있습니다. 자막은 계속 표시됩니다."
          captionsEmptyLabel="이 주제의 자막을 기다리고 있습니다." />
        {composition.unassigned && <CurrentTopicPanel topic={composition.unassigned}
          ariaLabel="분류 중인 자막" statusLabel="실시간" captionsEmptyLabel="분류할 자막을 기다리고 있습니다." />}
        <CompletedTopicAccordion topics={composition.completed} selectedLaneLabel={lane.label}
          state={isDegraded ? "degraded" : composition.completed.length ? "ready" : "empty"}
          ariaLabel="완료된 주제" emptyLabel="완료된 주제가 없습니다."
          degradedLabel="일부 완료 주제를 불러오지 못했습니다."
          captionCountLabel={(count) => `자막 ${count}개`} noCaptionsLabel="표시할 자막 없음"
          expandedTopicIds={expandedTopicIds} onExpandedChange={onExpandedTopicChange} />
      </div>
    </TranslationViewport>
  );
}
