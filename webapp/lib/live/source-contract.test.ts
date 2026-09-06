import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceEventSchema, sourceSnapshotSchema } from './source-contract';

const event = { type: 'source', sessionId: '00000000-0000-4000-8000-000000000001',
  sourceUtteranceId: '00000000-0000-4000-8000-000000000002', sourceSeq: 1, utteranceKey: 'segment-1', text: '2026',
  sourceLanguage: 'und', languageObservation: { state: 'unknown', languageCode: 'und', providerLanguageCode: null,
    evidence: 'neutral', languages: [] }, speaker: { role: 'host', label: '발표자' }, isFinal: true,
  sourceStartedAt: null, sourceEndedAt: '2026-08-31T00:00:00.000Z', emittedAt: '2026-08-31T00:00:00.001Z' };

test('source replay preserves immutable speaker company and department and rejects malformed identity', () => {
  const speakerProfile = { id: event.sessionId, version: 1, displayName: '김민지', company: '노바', department: '제품팀', photoAssetId: null };
  const parsed = sourceEventSchema.parse({ ...event, speakerProfile });
  assert.deepEqual(parsed.speakerProfile, speakerProfile);
  speakerProfile.displayName = '새 이름';
  assert.equal(parsed.speakerProfile?.displayName, '김민지');
  assert.equal(sourceEventSchema.safeParse({ ...event, speakerProfile: { ...speakerProfile, id: '../other' } }).success, false);
  assert.equal(sourceEventSchema.safeParse({ ...event, speakerAttribution: 'unresolved' }).success, true);
  assert.equal(sourceEventSchema.safeParse({ ...event, speakerAttribution: 'guessed' }).success, false);
});

test('canonical source accepts neutral und without discarding language observations', () => {
  assert.deepEqual(sourceEventSchema.parse(event), event);
  assert.equal(sourceEventSchema.safeParse({ ...event, languageObservation: null, sourceLanguage: 'en' }).success, true);
  assert.equal(sourceEventSchema.safeParse({ ...event, sourceLanguage: 'ko' }).success, false);
  assert.equal(sourceEventSchema.safeParse({ ...event, sourceSeq: Number.MAX_SAFE_INTEGER + 1 }).success, false);
  assert.equal(sourceEventSchema.safeParse({ ...event, rawText: 'private' }).success, false);
  for (const utteranceKey of ['bad<key', 'bad\nkey', 'bad\u200bkey'])
    assert.equal(sourceEventSchema.safeParse({ ...event, utteranceKey }).success, false);
});

test('snapshot rejects foreign sessions, unordered duplicates, and impossible continuation cursors', () => {
  const snapshot = { sessionId: event.sessionId, sources: [event], lastSourceSeq: 1, hasNextPage: false,
    nextAfterSourceSeq: null, recordsExpiresAt: null };
  assert.deepEqual(sourceSnapshotSchema.parse(snapshot), snapshot);
  assert.equal(sourceSnapshotSchema.safeParse({ ...snapshot, sources: [event, event] }).success, false);
  assert.equal(sourceSnapshotSchema.safeParse({ ...snapshot, sessionId: event.sourceUtteranceId }).success, false);
  assert.equal(sourceSnapshotSchema.safeParse({ ...snapshot, hasNextPage: true }).success, false);
});
