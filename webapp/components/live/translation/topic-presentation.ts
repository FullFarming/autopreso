import { hasValidTranslationCaptureProvenance, type TranslationCapture } from "../../../lib/live/translation-capture";
import type { SpeakerProfile, CaptionTranslationStatus } from "@/lib/live-contract";
import type { LanguageObservation } from "../../../lib/live/source-contract";
import type { CaptionDisplayMode } from "./CaptionEntry";

export interface TranslationLanePresentation {
  id: string;
  kind: "source" | "translation";
  language: string;
  label: string;
}

export interface TopicCaptionPresentation {
  id: string;
  language?: string;
  utteranceKey?: string;
  text: string;
  speakerLabel?: string;
  speakerProfile?: SpeakerProfile;
  sessionId?: string;
  speakerColor?: string;
  timestamp?: string;
  isFinal: boolean;
  translationStatus?: CaptionTranslationStatus;
  pendingText?: string;
  sourceText?: string | null;
  isActive?: boolean;
  displayMode?: CaptionDisplayMode;
}

export interface CaptionLaneInput extends TopicCaptionPresentation {
  translationCapture?: TranslationCapture;
  language: string;
  sourceLanguage?: string | null;
  origin?: "source";
  languageObservation?: LanguageObservation;
}

export interface TopicPresentation {
  id: string;
  title: string;
  timeLabel?: string;
  summary?: string;
  captions: readonly TopicCaptionPresentation[];
}

export function dedupeTopicPresentations(topics: readonly TopicPresentation[]): TopicPresentation[] {
  const ids = new Set<string>();
  return topics.filter((topic) => {
    if (ids.has(topic.id)) return false;
    ids.add(topic.id);
    return true;
  });
}

export function topicDomId(topicId: string): string {
  return `meeting-topic-${encodeURIComponent(topicId)}`;
}

export function indexTopicCaptions<T extends { topicId?: string | null }>(captions: Iterable<T>): {
  byTopicId: ReadonlyMap<string, T[]>;
  unassigned: T[];
} {
  const byTopicId = new Map<string, T[]>();
  const unassigned: T[] = [];
  for (const caption of captions) {
    if (!caption.topicId) {
      unassigned.push(caption);
      continue;
    }
    const bucket = byTopicId.get(caption.topicId);
    if (bucket) bucket.push(caption);
    else byTopicId.set(caption.topicId, [caption]);
  }
  return { byTopicId, unassigned };
}

function laneEquivalenceKey(lane: TranslationLanePresentation): string {
  if (lane.kind === "source") return "source";
  const language = lane.language.normalize("NFC").trim().toLowerCase().replaceAll("_", "-");
  return language ? `translation:${language}` : `id:${lane.id.normalize("NFC").trim().toLowerCase()}`;
}

export function dedupeEquivalentTranslationLanes(
  lanes: readonly TranslationLanePresentation[],
): TranslationLanePresentation[] {
  const keys = new Set<string>();
  return lanes.filter((lane) => {
    const key = laneEquivalenceKey(lane);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

export function buildTranslationLanes(
  sourceLanguage: string | null,
  translationLanguages: readonly string[],
): TranslationLanePresentation[] {
  return dedupeEquivalentTranslationLanes([
    { id: "source", kind: "source", language: sourceLanguage ?? "und", label: "원문" },
    ...translationLanguages.map((language) => ({
      id: `translation:${language}`,
      kind: "translation" as const,
      language,
      label: language,
    })),
  ]);
}

export function projectCaptionLane(
  captions: readonly CaptionLaneInput[],
  lane: TranslationLanePresentation,
): TopicCaptionPresentation[] {
  const projected = new Map<string, TopicCaptionPresentation>();
  const sourcePriority = new Map<string, number>();
  for (const caption of captions) {
    if (!hasValidTranslationCaptureProvenance(caption)) continue;
    let text: string | null = null;
    let priority = 0;
    if (lane.kind === "source") {
      if (caption.origin === "source" || caption.translationStatus === "verbatim") {
        text = caption.text;
        priority = 2;
      } else if (caption.translationStatus === "translated" && caption.sourceText?.trim()) {
        text = caption.sourceText;
        priority = 1;
      }
    } else if (caption.language === lane.language) {
      const isVerifiedTranslation = caption.translationStatus === "translated"
        && caption.origin !== "source" && (Boolean(caption.sourceText?.trim()) || caption.translationCapture !== undefined);
      const isVerifiedNative = caption.translationStatus === "verbatim"
        && caption.sourceLanguage === lane.language;
      const isVerifiedNeutral = caption.translationStatus === "verbatim" && caption.sourceLanguage === "und"
        && caption.languageObservation?.state === "unknown" && caption.languageObservation.languageCode === "und"
        && caption.languageObservation.evidence === "neutral";
      if (isVerifiedTranslation || isVerifiedNative || isVerifiedNeutral) text = caption.text;
    }
    if (!text?.trim()) continue;
    const id = caption.utteranceKey ?? caption.id;
    if (lane.kind === "source" && (sourcePriority.get(id) ?? 0) >= priority) continue;
    if (lane.kind === "source") sourcePriority.set(id, priority);
    projected.set(id, {
      ...caption,
      id,
      utteranceKey: caption.utteranceKey,
      language: lane.kind === "source" ? caption.sourceLanguage ?? "und" : lane.language,
      text,
      sourceText: lane.kind === "translation" ? caption.sourceText : null,
    });
  }
  return [...projected.values()];
}

export function boundedTopicAnnouncement(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().slice(0, 200);
}
