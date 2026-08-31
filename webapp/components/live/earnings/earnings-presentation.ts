import type { LiveAgendaItem, LiveEventType, LiveSessionSection } from "@/lib/live-contract";

export interface EarningsEventPresentation {
  readonly companyName?: string | null;
  readonly ticker?: string | null;
  readonly fiscalPeriod?: string | null;
  readonly eventType?: LiveEventType | null;
  readonly agenda?: readonly LiveAgendaItem[];
  readonly activeSection?: LiveSessionSection | null;
  readonly sectionStartedAt?: string | null;
}

export interface SearchableCaption {
  readonly id: string;
  readonly text: string;
  readonly speakerLabel?: string;
  readonly timestamp?: string;
}

export interface IndexedTopic {
  readonly id: string;
  readonly title: string;
}

export const SECTION_LABELS: Readonly<Record<LiveSessionSection, string>> = {
  prepared_remarks: "발표",
  qa: "질의응답",
  other: "기타",
};

export function searchSelectedTranscript(
  captions: readonly SearchableCaption[],
  rawQuery: string,
  limit = 50,
  onVisit?: () => void,
): SearchableCaption[] {
  const query = rawQuery.normalize("NFC").trim().toLocaleLowerCase();
  if (!query) return [];
  const results: SearchableCaption[] = [];
  for (const caption of captions) {
    onVisit?.();
    const haystack = `${caption.speakerLabel ?? ""} ${caption.text}`.normalize("NFC").toLocaleLowerCase();
    if (results.length < limit && haystack.includes(query)) results.push(caption);
  }
  return results;
}

export function buildGroundedPostCallIndex(
  agenda: readonly LiveAgendaItem[],
  topics: readonly IndexedTopic[],
  visibleCount = 40,
) {
  return {
    agenda: [...agenda].sort((left, right) => left.ordinal - right.ordinal),
    visibleTopics: topics.slice(0, Math.max(0, visibleCount)),
    totalTopicCount: topics.length,
  };
}

export function hasEarningsContext(event: EarningsEventPresentation): boolean {
  return event.eventType === "earnings_call"
    || Boolean(event.companyName || event.ticker || event.fiscalPeriod || event.agenda?.length);
}

export function formatSectionTime(value?: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}
