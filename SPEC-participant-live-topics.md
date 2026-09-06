# Specification: Participant Live Topic Transcript

Status: Implemented and locally verified; deployment approval pending  
Date: 2026-08-15  
Surface: `/watch`, `/m/watch`, `/m/watch/demo`

## Objective

Present host microphone and system-audio speech as an earnings-call-style live
transcript. Participants can switch between the original speech and the
host-configured translation while completed discussion sections collapse into
searchable, expandable topic groups.

## Product Contract

1. Audio is never played to participants. VIEWER remains captions-only.
2. The original transcript and each host-configured translation are synchronized
   by the existing stable `utteranceKey`.
3. When original and selected translation are equivalent, the duplicate lane is
   hidden.
4. Exactly one topic may be active per session. It is always expanded.
5. Completed topics render newest-last in transcript order and are collapsed by
   default. Their summary reveals the title, time range, utterance count, and a
   one-to-two-sentence summary. Expansion reveals the full selected lane.
6. A topic completes after 12 seconds without meaningful speech, a semantic
   shift, or session termination. Host pause does not count as silence.
7. Captions never wait for topic analysis. Provider timeout, refusal, rate
   limiting, malformed output, or DB topic failure leaves captions operational
   and assigns speech to a deterministic fallback topic.
8. Active and completed topics are server-authoritative and survive viewer and
   gateway refresh. Active partial captions remain ephemeral.
9. Topic metadata becomes visible automatically to authenticated participants in
   the same session. Participants cannot create, edit, publish, or regenerate it.
10. No transcript, topic title, summary, email, or token is written to browser
    storage. Only session ID, selected lane, expanded topic IDs, and an opaque
    scroll anchor may be stored for recovery.

## Interaction Model

- A native tab pattern exposes `Original` and the host-configured translation
  lanes. Arrow keys, Home, and End move tab focus; the selected panel keeps the
  same topic and utterance position.
- The active topic carries an explicit `Live` state and bounded polite
  announcements. Streaming partial text is never repeatedly announced.
- Completed topics use native disclosure semantics with a minimum 44px target.
- Critical connection, session, and recovery errors stay outside the tabs and
  disclosures.
- The transcript owns the remaining mobile viewport and at least 70vh on
  desktop. Tab overflow scrolls inside the tab list, never the page.

## Authoritative Topic Model

`live_topics` stores session, ordinal, bounded plain-text title and summary,
active/completed status, timestamps, completion reason, detector health, and an
optimistic version. A partial unique index permits one active topic per session.

`live_topic_utterances` maps each durable source `utteranceKey` to exactly one
topic and position. All translated siblings inherit the same topic through the
key; transcript text is not duplicated in the topic tables.

## Detector Contract

- Runs only after a source final is durably committed.
- Uses a bounded recent source context and the existing configured AI provider.
- Returns strict structured data: meaningful, startsNewTopic, and title.
- Uses no tools, URLs, dynamic model selection, email, participant profile, or
  raw provider-response persistence. Provider storage remains disabled.
- AI calls occur outside DB transactions. Database transitions use expected
  topic version and idempotent utterance-key constraints.
- There is no automatic retry or silent alternate provider.

## Security and Privacy

- Gateway host/session/language/version authorization remains authoritative.
- Participant topic reads require the existing valid session-scoped viewer
  credential and return `Cache-Control: private, no-store`.
- AI and logs receive no full email, company, consent, viewer token, or grant.
- Titles and summaries are NFC plain text with control, bidi-control, markup,
  unknown-key, and length rejection before persistence.
- Topic data follows the existing session retention and is removed with the
  session transcript after 30 days.

## Success Criteria

- Caption latency is unchanged; first topic assignment is visible without
  blocking the caption, and topic decisions settle within the bounded detector
  timeout.
- Silence completion occurs after the 12-second cutoff without closing during a
  partial utterance or host pause.
- Refresh reconstructs topics and returns to the selected lane, disclosure, and
  opaque transcript anchor without storing transcript content.
- Duplicate/replayed finals, stale topic events, late snapshots, AI failure, and
  gateway restart cannot duplicate, lose, or reactivate a completed topic.
- Chrome 320/768/1024/1440px and 200% zoom pass keyboard, accessibility, clean
  console, and zero participant microphone-request checks. Safari remains a
  preproduction manual gate.

## Exclusions

- Participant audio playback, microphone, or floor control.
- Host manual topic editing or publish approval.
- Cross-session topic search and finance-specific market data.
- Email delivery, production migration, external messages, and deployment.
