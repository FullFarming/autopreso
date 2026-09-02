export interface ReadingFragment {
  id: string;
  seq: number;
  speakerKey: string;
  speaker: string;
  startedAt: string;
  endedAt: string;
  text: string;
  language?: string;
  topicId?: string;
  rawText?: string;
  isCorrected?: boolean;
}

interface ReadingParagraph {
  key: string;
  fragments: ReadingFragment[];
}

export interface ReadingTurn {
  key: string;
  speakerKey: string;
  speaker: string;
  startedAt: string;
  endedAt: string;
  paragraphs: ReadingParagraph[];
}

interface RecordingInterval { startedAt: string; endedAt: string | null }

function hasRecordingBreak(previous: ReadingFragment, entry: ReadingFragment, gaps: readonly RecordingInterval[]): boolean {
  const previousEnd = Date.parse(previous.endedAt);
  const nextStart = Date.parse(entry.startedAt);
  if (!Number.isFinite(previousEnd) || !Number.isFinite(nextStart)) return true;
  return gaps.some((gap) => {
    const start = Date.parse(gap.startedAt);
    const end = gap.endedAt === null ? Infinity : Date.parse(gap.endedAt);
    return !Number.isFinite(start) || Number.isNaN(end) || (start <= nextStart && end >= previousEnd);
  });
}

export function groupTranscriptReading(entries: readonly ReadingFragment[], gaps: readonly RecordingInterval[] = []): ReadingTurn[] {
  const turns: ReadingTurn[] = [];
  let previous: ReadingFragment | undefined;
  for (const entry of entries) {
    let turn = turns.at(-1);
    if (!previous || !turn || previous.speakerKey !== entry.speakerKey
      || entry.seq !== previous.seq + 1 || hasRecordingBreak(previous, entry, gaps)) {
      // 2026-09-03 fix: a turn is exactly one paragraph. Language, topic, pauses and length never split a speaker's
      // text; every fragment carries its own time marker at render time instead. Only a speaker change, a seq gap
      // or a recording break starts a new turn. The paragraphs array is kept so existing consumers compile.
      turn = { key: entry.id, speakerKey: entry.speakerKey, speaker: entry.speaker,
        startedAt: entry.startedAt, endedAt: entry.endedAt, paragraphs: [{ key: entry.id, fragments: [] }] };
      turns.push(turn);
    }
    // 2026-08-31 feat: Group presentation only; keep exact text and correction evidence attached to each source row.
    turn.paragraphs[0].fragments.push(entry);
    turn.endedAt = entry.endedAt;
    previous = entry;
  }
  return turns;
}
