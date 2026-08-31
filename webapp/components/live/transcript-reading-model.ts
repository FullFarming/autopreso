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

function endsSentence(text: string): boolean {
  return /[.!?。！？]["'”’」』)\]]*\s*$/u.test(text);
}

export function groupTranscriptReading(entries: readonly ReadingFragment[], gaps: readonly RecordingInterval[] = []): ReadingTurn[] {
  const turns: ReadingTurn[] = [];
  let previous: ReadingFragment | undefined;
  let paragraphCharacters = 0;
  let completedFragments = 0;
  for (const entry of entries) {
    let turn = turns.at(-1);
    if (!previous || !turn || previous.speakerKey !== entry.speakerKey
      || entry.seq !== previous.seq + 1 || hasRecordingBreak(previous, entry, gaps)) {
      turn = { key: entry.id, speakerKey: entry.speakerKey, speaker: entry.speaker,
        startedAt: entry.startedAt, endedAt: entry.endedAt, paragraphs: [] };
      turns.push(turn);
      paragraphCharacters = 0;
      completedFragments = 0;
    }
    const shouldStartParagraph = previous && turn.paragraphs.length > 0 && (
      entry.language !== previous.language || entry.topicId !== previous.topicId
      || Date.parse(entry.startedAt) - Date.parse(previous.endedAt) >= 30_000
      || (endsSentence(previous.text) && (completedFragments >= 3 || paragraphCharacters >= 400))
    );
    if (turn.paragraphs.length === 0 || shouldStartParagraph) {
      turn.paragraphs.push({ key: entry.id, fragments: [] });
      paragraphCharacters = 0;
      completedFragments = 0;
    }
    // 2026-08-31 feat: Group presentation only; keep exact text and correction evidence attached to each source row.
    turn.paragraphs[turn.paragraphs.length - 1].fragments.push(entry);
    turn.endedAt = entry.endedAt;
    paragraphCharacters += entry.text.length;
    if (endsSentence(entry.text)) completedFragments += 1;
    previous = entry;
  }
  return turns;
}
