import assert from "node:assert/strict";
import test from "node:test";

import { shouldDisplayLiveCaption } from "../src/live-caption-display-policy.js";

test("gateway-only desktop displays host translations in both utterance directions", () => {
  for (const [sourceLanguage, language] of [["ko", "en"], ["en", "ko"]]) {
    const caption = { sourceLanguage, language, speakerRole: "host" };
    for (const displayLanguage of ["ko", "en"]) {
      assert.equal(shouldDisplayLiveCaption(caption, displayLanguage, "gateway"), true);
      assert.equal(shouldDisplayLiveCaption(caption, displayLanguage, "hybrid"), false);
    }
  }
});

test("missing or invalid producer ownership fails closed for host and participant captions", () => {
  for (const speakerRole of ["host", "participant"]) {
    const caption = { sourceLanguage: "ko", language: "en", speakerRole };
    for (const producerKind of [undefined, null, "", "none", "local", "GATEWAY", {}, []]) {
      assert.equal(Reflect.apply(shouldDisplayLiveCaption, null, [caption, "en", producerKind]), false);
    }
  }
});

test("explicit producer modes preserve participant translations and reject source or failed output", () => {
  const participant = {
    sourceLanguage: "ko", language: "en", speakerRole: "participant",
    speaker: { isParticipant: true, participantId: "viewer-fixture" },
  };
  for (const producerKind of ["gateway", "hybrid"]) {
    assert.equal(shouldDisplayLiveCaption(participant, "ko", producerKind), true);
    for (const caption of [
      { ...participant, origin: "source" },
      { ...participant, translationStatus: "failed" },
      { ...participant, language: "ko" },
      { ...participant, language: "ja" },
      { ...participant, sourceLanguage: "und" },
      { ...participant, speakerRole: "host", origin: "source" },
    ]) assert.equal(shouldDisplayLiveCaption(caption, "ko", producerKind), false);
  }
});

const independentCaption = {
  language: "en", sourceLanguage: null, sourceText: null, speakerRole: "host",
  translationStatus: "translated",
  translationCapture: {
    kind: "independent-live-translation",
    streamGeneration: "00000000-0000-4000-8000-000000000001",
    captureEpoch: "00000000-0000-4000-8000-000000000002",
    captureStartedAt: "2026-09-01T00:00:00.000Z",
    captureEndedAt: "2026-09-01T00:00:01.000Z",
    finalization: "application-sentence-boundary",
  },
};

test("independent translation uses an observed direction without inventing authoritative source language", () => {
  for (const [observedSourceLanguage, language] of [["ko", "en"], ["en", "ko"]]) {
    const caption = { ...independentCaption, observedSourceLanguage, language };
    for (const displayLanguage of ["ko", "en"]) {
      assert.equal(shouldDisplayLiveCaption(caption, displayLanguage, "gateway"), true);
      assert.equal(shouldDisplayLiveCaption({ ...caption, language: observedSourceLanguage }, displayLanguage, "gateway"), false);
      assert.equal(shouldDisplayLiveCaption(caption, displayLanguage, "hybrid"), false);
      assert.equal(shouldDisplayLiveCaption({ ...caption, speakerRole: "participant" }, displayLanguage, "hybrid"), true);
    }
    assert.equal(caption.sourceLanguage, null);
  }
});

test("independent output with no known observed direction follows the selected display target only", () => {
  for (const observedSourceLanguage of [undefined, null, "und", "unknown", "ja", "EN", {}, []]) {
    const caption = { ...independentCaption, observedSourceLanguage };
    assert.equal(shouldDisplayLiveCaption(caption, "en", "gateway"), true);
    assert.equal(shouldDisplayLiveCaption(caption, "ko", "gateway"), false);
    assert.equal(shouldDisplayLiveCaption(caption, "ja", "gateway"), false);
  }
  assert.equal(shouldDisplayLiveCaption({ ...independentCaption,
    translationCapture: { ...independentCaption.translationCapture, captureStartedAt: null } }, "en", "gateway"), true);
  assert.equal(shouldDisplayLiveCaption({ ...independentCaption,
    translationCapture: { ...independentCaption.translationCapture,
      captureStartedAt: "2026-09-01T00:00:00.123456Z", captureEndedAt: "2026-09-01T00:00:01.123456Z" } }, "en", "gateway"), true);
});

test("independent display rejects malformed provenance or fabricated original links", () => {
  const capture = independentCaption.translationCapture;
  for (const translationCapture of [
    {}, [], { ...capture, kind: "source" }, { ...capture, streamGeneration: "invalid" },
    { ...capture, captureEpoch: "invalid" }, { ...capture, finalization: "provider-final" },
    { ...capture, captureStartedAt: "invalid" }, { ...capture, captureEndedAt: null },
    { ...capture, captureEndedAt: "2020-01-01T00:00:00.000Z" },
    { ...capture, unexpectedSourceId: "fabricated" },
  ]) assert.equal(shouldDisplayLiveCaption({ ...independentCaption, translationCapture }, "en", "gateway"), false);
  for (const fields of [
    { origin: "source" }, { sourceText: "unverified source" }, { sourceLanguage: "ko" },
    { authoritativeSourceId: capture.streamGeneration }, { sourceStartedAt: capture.captureStartedAt },
    { translationStatus: "failed" },
  ]) assert.equal(shouldDisplayLiveCaption({ ...independentCaption, ...fields }, "en", "gateway"), false);
});
