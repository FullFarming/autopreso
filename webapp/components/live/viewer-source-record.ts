import { z } from "zod";
import { recordingGapSchema, type RecordingGap } from "../../lib/live-recap/contract";
import type { TranscriptEntry } from "./meeting-minutes-model";

const sourcePageSchema = z.object({ ok: z.literal(true), data: z.object({
  view: z.literal("source"),
  recordingGaps: z.array(recordingGapSchema),
  utterances: z.array(z.object({ seq: z.number().int().nonnegative(), speaker: z.string(), text: z.string(),
    emittedAt: z.string(), sourceLanguage: z.string() })),
  nextAfterSourceSeq: z.number().int().nonnegative().nullable(), hasNextPage: z.boolean(),
}) });

export async function loadViewerSourceRecord(sessionId: string, fetcher: typeof fetch = fetch): Promise<{ utterances: TranscriptEntry[]; recordingGaps: RecordingGap[] }> {
  const entries: TranscriptEntry[] = [];
  let afterSourceSeq = 0;
  let recordingGaps: RecordingGap[] = [];
  for (;;) {
    const response = await fetcher(`/api/live-sessions/${encodeURIComponent(sessionId)}/transcript?view=source&afterSourceSeq=${afterSourceSeq}&pageSize=200`, { cache: "no-store" });
    if (!response.ok) throw new Error("발언 원문을 불러오지 못했습니다.");
    const page = sourcePageSchema.parse(await response.json()).data;
    if (afterSourceSeq === 0) recordingGaps = page.recordingGaps;
    entries.push(...page.utterances.map((entry) => ({ ...entry, origin: "source" as const, utteranceKey: `source:${entry.seq}` })));
    if (!page.hasNextPage) return { utterances: entries, recordingGaps };
    if (page.nextAfterSourceSeq === null || page.nextAfterSourceSeq <= afterSourceSeq) throw new Error("원문 페이지 순서를 확인할 수 없습니다.");
    afterSourceSeq = page.nextAfterSourceSeq;
  }
}
