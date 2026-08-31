"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages } from "@/lib/system-language/records-messages";

import type { ReactNode } from "react";

import { CompletedTopicAccordion, topicDomId, type TopicPresentation } from "../translation";
import { buildTopicNavigationModel, revealTopicTarget } from "./topic-navigation";

export function MeetingTopicNavigator({ topics }: { topics: readonly TopicPresentation[] }) {
  const t = useSystemText(recordsMessages);
  if (!topics.length) return null;
  const navigation = buildTopicNavigationModel(topics);
  return (
    <nav className="live-topic-navigator" aria-label={t("회의 주제")}>
      {navigation.mode === "links" ? navigation.directItems.map((topic) => (
        <a key={topic.id} href={`#${topicDomId(topic.id)}`}
          onClick={() => revealTopicTarget(topic.id)}>{topic.title}</a>
      )) : (
        <label className="live-topic-navigator-select">
          <span>{t("주제로 이동")}</span>
          <select defaultValue="" onChange={(event) => {
            if (event.currentTarget.value) revealTopicTarget(event.currentTarget.value);
          }}>
            <option value="" disabled>{t("주제를 선택하세요")}</option>
            {navigation.options.map((topic) => <option key={topic.id} value={topic.id}>{topic.title}</option>)}
          </select>
        </label>
      )}
    </nav>
  );
}

export function MeetingTopicChapters({
  topics,
  expandedTopicIds,
  onExpandedChange,
}: {
  topics: readonly TopicPresentation[];
  expandedTopicIds?: readonly string[];
  onExpandedChange?: (topicId: string, isExpanded: boolean) => void;
}) {
  const t = useSystemText(recordsMessages);
  return (
    <CompletedTopicAccordion topics={topics} selectedLaneLabel={t("선택 언어")}
      ariaLabel={t("주제별 회의록")} emptyLabel={t("회의록 주제가 없습니다.")}
      captionCountLabel={(count) => t("자막 {count}개", { count })} noCaptionsLabel={t("표시할 자막 없음")}
      expandedTopicIds={expandedTopicIds} onExpandedChange={onExpandedChange} />
  );
}

export function RecapStatePanel({ isBusy, children }: { isBusy: boolean; children: ReactNode }) {
  return <div className="live-recap-state" aria-busy={isBusy}>{children}</div>;
}
