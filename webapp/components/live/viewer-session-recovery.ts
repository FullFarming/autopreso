import { LANGUAGE_CODES } from "../../lib/languageDetect";

export const VIEWER_RECOVERY_STORAGE_KEY = "rnw-live-viewer-context-v1";

export interface ViewerRecoveryContext {
  sessionId: string;
  language: string;
  preferredTargetLanguage: string;
  selectedLaneId: string;
  expandedTopicIds: string[];
  anchorUtteranceKey: string;
  anchorsByLane: Record<string, string>;
}

interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const utteranceKeyPattern = /^[^<>\p{Cc}\p{Cf}]{0,256}$/u;

function isSelectedLaneId(value: string): boolean {
  return value === "source" || (value.startsWith("translation:")
    && LANGUAGE_CODES.some((language) => value === `translation:${language}`));
}

export function readViewerRecoveryContext(storage: RecoveryStorage): ViewerRecoveryContext | null {
  const serialized = storage.getItem(VIEWER_RECOVERY_STORAGE_KEY);
  if (!serialized) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(",");
    const isLegacy = keys === "anchorUtteranceKey,expandedTopicIds,language,selectedLaneId,sessionId";
    if ((!isLegacy && keys !== "anchorUtteranceKey,anchorsByLane,expandedTopicIds,language,preferredTargetLanguage,selectedLaneId,sessionId")
      || typeof record.sessionId !== "string"
      || !sessionIdPattern.test(record.sessionId)
      || typeof record.language !== "string"
      || !LANGUAGE_CODES.some((language) => language === record.language)
      || typeof record.selectedLaneId !== "string"
      || !isSelectedLaneId(record.selectedLaneId)
      || !Array.isArray(record.expandedTopicIds)
      || record.expandedTopicIds.length > 40
      || !record.expandedTopicIds.every((topicId) => typeof topicId === "string" && sessionIdPattern.test(topicId))
      || new Set(record.expandedTopicIds).size !== record.expandedTopicIds.length
      || typeof record.anchorUtteranceKey !== "string"
      || !utteranceKeyPattern.test(record.anchorUtteranceKey)) return null;
    const preferredTargetLanguage = isLegacy ? record.language : record.preferredTargetLanguage;
    if (typeof preferredTargetLanguage !== "string" || !LANGUAGE_CODES.some((code) => code === preferredTargetLanguage)) return null;
    const anchors = isLegacy ? { [record.selectedLaneId]: record.anchorUtteranceKey } : record.anchorsByLane;
    if (!anchors || typeof anchors !== "object" || Array.isArray(anchors)
      || Object.keys(anchors).length > LANGUAGE_CODES.length + 1
      || !Object.entries(anchors).every(([laneId, anchor]) => isSelectedLaneId(laneId)
        && typeof anchor === "string" && utteranceKeyPattern.test(anchor))) return null;
    const anchorsByLane = Object.fromEntries(Object.entries(anchors).map(([laneId, anchor]) => [laneId, String(anchor)]));
    return {
      sessionId: record.sessionId,
      language: record.language,
      preferredTargetLanguage,
      selectedLaneId: record.selectedLaneId,
      expandedTopicIds: record.expandedTopicIds,
      anchorUtteranceKey: record.anchorUtteranceKey,
      anchorsByLane,
    };
  } catch {
    return null;
  }
}

export function writeViewerRecoveryContext(storage: RecoveryStorage, context: ViewerRecoveryContext): void {
  storage.setItem(VIEWER_RECOVERY_STORAGE_KEY, JSON.stringify({
    sessionId: context.sessionId,
    language: context.language,
    preferredTargetLanguage: context.preferredTargetLanguage,
    selectedLaneId: context.selectedLaneId,
    expandedTopicIds: context.expandedTopicIds,
    anchorUtteranceKey: context.anchorUtteranceKey,
    anchorsByLane: context.anchorsByLane,
  }));
}

export function clearViewerRecoveryContext(storage: RecoveryStorage): void {
  storage.removeItem(VIEWER_RECOVERY_STORAGE_KEY);
}

export function selectViewerRecoveryLanguage(preferred: string, languages: string[]): string {
  return languages.includes(preferred) ? preferred : languages[0] ?? "";
}

export function resolveViewerRecoverySelection(context: ViewerRecoveryContext, languages: string[]) {
  const preferredTargetLanguage = selectViewerRecoveryLanguage(context.preferredTargetLanguage, languages);
  const selectedTarget = languages.find((code) => context.selectedLaneId === `translation:${code}`);
  const language = selectedTarget ?? preferredTargetLanguage;
  const selectedLaneId = context.selectedLaneId === "source" ? "source" : `translation:${language}`;
  return { language, selectedLaneId, anchorUtteranceKey: context.anchorsByLane[selectedLaneId] ?? "" };
}
