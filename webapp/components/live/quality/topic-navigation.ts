import { dedupeTopicPresentations, topicDomId, type TopicPresentation } from "../translation/topic-presentation";

const MAX_DIRECT_TOPIC_LINKS = 12;

export interface TopicNavigationModel {
  mode: "links" | "select";
  directItems: TopicPresentation[];
  options: TopicPresentation[];
}

interface FocusableTarget {
  focus: () => void;
}

interface TopicDetailsTarget {
  open: boolean;
  querySelector: (selector: string) => FocusableTarget | null;
}

interface TopicDocument {
  getElementById: (id: string) => TopicDetailsTarget | null;
}

export function buildTopicNavigationModel(topics: readonly TopicPresentation[]): TopicNavigationModel {
  const uniqueTopics = dedupeTopicPresentations(topics);
  return {
    mode: uniqueTopics.length > MAX_DIRECT_TOPIC_LINKS ? "select" : "links",
    directItems: uniqueTopics.slice(0, MAX_DIRECT_TOPIC_LINKS),
    options: uniqueTopics,
  };
}

const browserTopicDocument: TopicDocument = {
  getElementById(id) {
    const element = document.getElementById(id);
    return element instanceof HTMLDetailsElement ? element : null;
  },
};

export function revealTopicTarget(topicId: string, root: TopicDocument = browserTopicDocument): boolean {
  const target = root.getElementById(topicDomId(topicId));
  if (!target) return false;
  target.open = true;
  target.querySelector("summary")?.focus();
  return true;
}
