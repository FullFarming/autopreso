import type { LiveTopicPublicMetadata } from "@/lib/live-contract";
import { projectTopicMemberships, type LiveTopicState } from "@/lib/live/topic-state";
import { formatMinuteTime } from "./meeting-minutes-model";
import { indexTopicCaptions, type TopicPresentation } from "./translation";

export interface ViewerTopicComposition {
  active: TopicPresentation | null;
  completed: TopicPresentation[];
  unassigned: TopicPresentation | null;
}

function topicPresentation(topic: LiveTopicPublicMetadata, captions: TopicPresentation["captions"]): TopicPresentation {
  return { id: topic.id, title: topic.title, timeLabel: formatMinuteTime(topic.startedAt), summary: topic.summary ?? undefined, captions };
}

export function composeViewerTopics(captions: TopicPresentation["captions"], state: LiveTopicState | null): ViewerTopicComposition {
  if (!state) {
    return { active: null, completed: [], unassigned: captions.length ? { id: "classifying", title: "분류 중", captions } : null };
  }
  const indexed = indexTopicCaptions(projectTopicMemberships([...captions], state.topicMemberships));
  const topicCaptions = (topicId: string) => indexed.byTopicId.get(topicId) ?? [];
  const activeTopic = state.topics.find((topic) => topic.status === "active") ?? null;
  return {
    active: activeTopic ? topicPresentation(activeTopic, topicCaptions(activeTopic.id)) : null,
    completed: state.topics.filter((topic) => topic.status === "completed")
      .map((topic) => topicPresentation(topic, topicCaptions(topic.id))),
    unassigned: indexed.unassigned.length ? { id: "classifying", title: "분류 중", captions: indexed.unassigned } : null,
  };
}
