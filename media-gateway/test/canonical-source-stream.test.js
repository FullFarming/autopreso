import assert from 'node:assert/strict';
import test from 'node:test';
import { SupabaseLivePublisher } from '../src/supabase-adapters.js';

const sessionId = '00000000-0000-4000-8000-000000000001';
const sourceId = '00000000-0000-4000-8000-000000000002';
const observation = { state: 'mixed', languageCode: 'und', providerLanguageCode: 'ko', evidence: 'conflict', languages: ['ko', 'en'] };
const input = { sessionId, utteranceKey: 'utterance-1', rawText: '매출 revenue', normalizedText: '매출 revenue', sourceLanguage: 'und',
  languageObservation: observation, speakerRole: 'host', speakerLabel: '1', speakerName: 'Private Owner',
  speakerDepartment: 'Private Department', speakerJobTitle: null, participantId: null,
  sourceStartedAt: null, sourceEndedAt: '2026-08-31T00:00:01.000Z', providerCommittedAt: '2026-08-31T00:00:01.100Z',
  sttProvider: 'gemini-transcribe-live', sttModel: null, translationModel: null, pipelineConfigFingerprint: null };

test('canonical source broadcasts only after durable commit, once, independently of target lanes', async () => {
  const calls = []; const events = [];
  const publisher = new SupabaseLivePublisher({ baseUrl: 'https://project.supabase.co', serviceRoleKey: 'test-key',
    async eventFanout() { assert.fail('source must not be broadcast through a target lane'); },
    async sourceEventFanout(event) { calls.push('broadcast'); events.push(event); },
    async fetchFn(url, init) { calls.push('commit'); assert.match(url, /persist_authoritative_live_source_utterance_v2$/u);
      assert.deepEqual(JSON.parse(init.body).p_language_observation, observation);
      return Response.json({ ok: true, sourceUtteranceId: sourceId, sourceSeq: 3, idempotent: false }); },
  });
  await publisher.persistAuthoritativeSource(input);
  assert.deepEqual(calls, ['commit', 'broadcast']); assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'source', sessionId, sourceUtteranceId: sourceId, sourceSeq: 3,
    utteranceKey: input.utteranceKey, text: input.normalizedText, sourceLanguage: 'und', languageObservation: observation,
    speaker: { role: 'host', label: '발표자' }, isFinal: true, sourceStartedAt: null,
    sourceEndedAt: input.sourceEndedAt, emittedAt: input.providerCommittedAt });
  assert.doesNotMatch(JSON.stringify(events), /Private|rawText|sttProvider|participantId/u);
});

test('failed source commit never emits a final, and observation conflicts fail before network', async () => {
  let broadcasts = 0; let requests = 0;
  const publisher = new SupabaseLivePublisher({ baseUrl: 'https://project.supabase.co', serviceRoleKey: 'test-key', eventFanout() {},
    sourceEventFanout() { broadcasts++; }, fetchFn() { requests++; return Promise.resolve(new Response('', { status: 503 })); } });
  await assert.rejects(publisher.persistAuthoritativeSource({ ...input, sourceLanguage: 'ko' }), /INVALID_AUTHORITATIVE_SOURCE_INPUT/u);
  assert.equal(requests, 0);
  await assert.rejects(publisher.persistAuthoritativeSource(input), /AUTHORITATIVE_SOURCE_PERSIST_FAILED/u);
  assert.equal(broadcasts, 0);
});

test('source persistence preserves the same immutable demand epoch for the versioned RPC', async () => {
  const ownerId = '00000000-0000-4000-8000-000000000003';
  const publisher = new SupabaseLivePublisher({ baseUrl: 'https://project.supabase.co', serviceRoleKey: 'test-key', eventFanout() {},
    async fetchFn(url, init) { assert.match(url, /persist_authoritative_live_source_utterance_v2_fenced_v1$/u);
      const body = JSON.parse(init.body); assert.equal(body.p_epoch, 4); assert.equal(body.p_owner_id, ownerId);
      return Response.json({ ok: true, sourceUtteranceId: sourceId, sourceSeq: 3, idempotent: false }); } });
  await publisher.withMediaFence({ epoch: 4, ownerId }).persistAuthoritativeSource(input);
});

test('ephemeral drafts are bounded, neutral, fenced and never allocate a source sequence', async () => {
  const events = []; const generation = '00000000-0000-4000-8000-000000000004';
  const fence = { epoch: 3, ownerId: sourceId };
  const publisher = new SupabaseLivePublisher({ baseUrl: 'https://project.supabase.co', serviceRoleKey: 'test-key', eventFanout() {},
    fetchFn() { assert.fail('drafts cannot read/write database'); },
    sourceEventFanout(event, context) { events.push(event); assert.deepEqual(context.mediaFence, fence); } });
  const scoped = publisher.withMediaFence(fence);
  await scoped.publishSourceDraft({ type: 'source-draft', sessionId, generation, revision: 2, text: input.normalizedText,
    sourceLanguage: 'und', languageObservation: observation, speaker: { role: 'host', label: 'Private Owner' }, emittedAt: input.providerCommittedAt });
  await scoped.publishSourceDraft({ type: 'source-draft-clear', sessionId, generation, revision: 2 });
  assert.equal(events[0].speaker.label, '발표자'); assert.equal(events[0].sourceSeq, undefined); assert.equal(events.length, 2);
  await assert.rejects(scoped.publishSourceDraft({ type: 'source-draft-clear', sessionId, generation, revision: 0 }), /INVALID_SOURCE_DRAFT/u);
});

test('durable replay keeps original lane sequences and restores neutral language observations without writes', async () => {
  const events=[]; const calls=[];
  const neutral={state:'unknown',languageCode:'und',providerLanguageCode:null,evidence:'neutral',languages:[]};
  const publisher=new SupabaseLivePublisher({baseUrl:'https://project.supabase.co',serviceRoleKey:'test-key',
    eventFanout(session,language,event){events.push({session,language,event});},
    async fetchFn(url,init){calls.push({url,method:init.method});
      if(url.includes('/rpc/read_live_caption_source_observations_v1')) return Response.json([{source_utterance_id:sourceId,source_seq:2,language_observation:neutral}]);
      const parsed=new URL(url);assert.equal(parsed.searchParams.get('authoritative_source_id'),`eq.${sourceId}`);
      return Response.json(parsed.searchParams.get('language')==='eq.ko'?[{seq:11,authoritative_source_id:sourceId,
        text:'2026',source_text:'2026',source_language:'und',translation_status:'verbatim',source_ended_at:input.sourceEndedAt,
        emitted_at:input.providerCommittedAt,utterance_key:'key-1'}]:[]);
    }});
  const result=await publisher.replayAuthoritativeSourceCaptions(sessionId,sourceId,['ko','en']);
  assert.deepEqual(result,{restoredLanguages:['ko'],missingLanguages:['en']});
  assert.equal(events[0].event.seq,11);assert.equal(events[0].event.replay,true);
  assert.deepEqual(events[0].event.languageObservation,neutral);
  assert.ok(calls.every(call=>call.method==='GET'||call.url.includes('/read_live_caption_source_observations_v1')));
});
