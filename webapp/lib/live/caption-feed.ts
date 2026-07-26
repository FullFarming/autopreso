/** Newest-first caption feed ordering: the live edge is the TOP of the feed
 *  and older captions push downward, so a phone held one-handed keeps the
 *  reader's eyes on a fixed position at the top of the screen. */

import type { CaptionEvent } from "../live-contract";

export const PIN_THRESHOLD_PX = 48;
const COMMITTED_CAPTION_LIMIT = 5_000;

/** Tracks which language histories have completed their first snapshot load.
 * Gateway subscription remains independent: a warm language still reconnects
 * for replay/live events, it simply avoids downloading the same history again. */
export class LanguageSnapshotRegistry {
  private sessionId = "";
  private readonly warmedLanguages = new Set<string>();
  private readonly loadingLanguages = new Set<string>();

  reset(sessionId: string): void {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.warmedLanguages.clear();
    this.loadingLanguages.clear();
  }

  begin(sessionId: string, language: string): boolean {
    // Session changes are explicit at the viewer boundary. A late async task
    // from the previous session must never reset the active registry backward.
    if (sessionId !== this.sessionId) return false;
    if (this.warmedLanguages.has(language) || this.loadingLanguages.has(language)) return false;
    this.loadingLanguages.add(language);
    return true;
  }

  finish(sessionId: string, language: string, succeeded: boolean): void {
    // A response from the previous QR/session must not warm the new session.
    if (sessionId !== this.sessionId) return;
    this.loadingLanguages.delete(language);
    if (succeeded) this.warmedLanguages.add(language);
  }
}

/** Runs one snapshot loader per session/language until it succeeds. Concurrent
 * callers share the in-flight decision and warm toggles become cache-only. */
export async function loadLanguageSnapshotOnce<T>(
  registry: LanguageSnapshotRegistry,
  sessionId: string,
  language: string,
  load: () => Promise<T>,
): Promise<T | null> {
  if (!registry.begin(sessionId, language)) return null;
  try {
    const snapshot = await load();
    registry.finish(sessionId, language, true);
    return snapshot;
  } catch (error: unknown) {
    registry.finish(sessionId, language, false);
    throw error;
  }
}

export function newestFirst<T>(items: readonly T[]): T[] {
  return [...items].reverse();
}

/** The reader is "pinned" to the live edge while scrolled at (or near) the
 *  top; scrolling down to read history unpins so new captions never yank
 *  the scroll position away. */
export function isPinnedToLatest(scrollTop: number, thresholdPx: number = PIN_THRESHOLD_PX): boolean {
  return scrollTop < thresholdPx;
}

/** Captions the web history may show.
 *
 * Each language button is a complete reading lane, not a translation-only
 * overlay. Source speech therefore remains visible in its own language lane,
 * while its translated pair occupies the same canonical sequence in the other
 * lane. A translated entry is visible only when the gateway supplies canonical
 * cross-language provenance; failed, echoed, and uncorrelated provider output
 * stays out of the user-facing record. */
export function isDisplayableCaption(
  caption: {
    language?: string | null;
    sourceLanguage?: string | null;
    origin?: string | null;
    translationStatus?: string | null;
  },
): boolean {
  if (caption.translationStatus === "failed") return false;
  const hasCanonicalLanguages = (caption.language === "en" || caption.language === "ko")
    && (caption.sourceLanguage === "en" || caption.sourceLanguage === "ko");
  if (!hasCanonicalLanguages) return false;
  if (caption.origin === "source") return caption.language === caption.sourceLanguage;
  // 2026-07-26 fix: A translated web lane must have the same cross-language
  // provenance as the Electron caption it mirrors. Provider echoes and
  // uncorrelated intermediate output previously slipped into web history
  // because anything not explicitly marked failed was accepted.
  return caption.language !== caption.sourceLanguage;
}

function normalizedCaptionText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** 2026-07-26 fix: Merge the canonical event stream into one language's visible record.
 *
 * Sequence is identity. Text is deliberately NOT identity: a speaker saying
 * "네" twice produces two valid records with two distinct canonical sequences.
 * Finals are sorted so a post-attach snapshot cannot reorder a newer socket
 * event merely because its HTTP request completed later. Exactly one partial is
 * kept at the tail and replaced in place until the final carrying that sequence
 * arrives. */
export function mergeCaptionTimeline(
  current: readonly CaptionEvent[],
  incoming: CaptionEvent,
): CaptionEvent[] {
  return mergeCaptionEvents(current, [incoming]);
}

function mergeCaptionEvents(
  current: readonly CaptionEvent[],
  incoming: readonly CaptionEvent[],
): CaptionEvent[] {
  const finalBySequence = new Map<number, CaptionEvent>();
  let partial: CaptionEvent | null = null;
  let latestFinalSequence = 0;
  for (const event of current) {
    if (event.isFinal) {
      finalBySequence.set(event.seq, event);
      latestFinalSequence = Math.max(latestFinalSequence, event.seq);
    } else if (!partial || event.seq >= partial.seq) {
      partial = event;
    }
  }

  for (const event of incoming) {
    if (!normalizedCaptionText(event.text)) continue;
    if (event.isFinal) {
      finalBySequence.set(event.seq, event);
      latestFinalSequence = Math.max(latestFinalSequence, event.seq);
      // 2026-07-26 fix: An older snapshot may finish after a newer live partial.
      // Only the final that reaches that partial's sequence may commit it.
      if (partial && partial.seq <= event.seq) partial = null;
      continue;
    }
    if (event.seq > latestFinalSequence) partial = event;
  }

  const committed = [...finalBySequence.values()]
    .sort((left, right) => left.seq - right.seq)
    .slice(-COMMITTED_CAPTION_LIMIT);
  if (!partial || partial.seq <= (committed.at(-1)?.seq ?? 0)) return committed;
  return [...committed, partial];
}

/** 2026-07-26 fix: Update one language without touching any other cached transcript. This is
 * the source of truth used by the EN↔KO selector, so changing language is a
 * synchronous cache read rather than a blank state followed by an HTTP reload. */
export function mergeLanguageCaptionCache(
  current: Readonly<Record<string, CaptionEvent[]>>,
  language: string,
  incoming: readonly CaptionEvent[],
): Record<string, CaptionEvent[]> {
  // The selected button is a hard language boundary. Reject a malformed socket
  // or snapshot event instead of ever mixing EN and KO in one visible history.
  const currentLane = (current[language] ?? []).filter((event) => event.language === language);
  const incomingLane = incoming.filter((event) => event.language === language);
  const timeline = mergeCaptionEvents(currentLane, incomingLane);
  return { ...current, [language]: timeline };
}

/** Returns an already-loaded language lane synchronously. Switching back to EN
 * or KO must not clear the record and wait for another snapshot round trip. */
export function getCachedLanguageCaptions(
  current: Readonly<Record<string, CaptionEvent[]>>,
  language: string,
): CaptionEvent[] {
  return current[language] ?? [];
}
