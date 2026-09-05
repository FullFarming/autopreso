import { buildSpeakerPhotoUrl } from "../../../packages/caption-core/speaker-profile.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { formatViewerSystemStatus, viewerMessages } from "./viewer-messages";
import { formatSystemText } from "../system-language";
import * as systemLanguage from "../system-language";

test("participant system copy covers Korean, English and Japanese without translating meeting content", () => {
  const keys = Object.keys(viewerMessages.ko).sort();
  assert.deepEqual(Object.keys(viewerMessages.en).sort(), keys);
  assert.deepEqual(Object.keys(viewerMessages.ja).sort(), keys);
  for (const key of keys) {
    for (const language of ["en", "ja"] as const) {
      assert.ok(viewerMessages[language][key]?.trim(), `${language}: ${key}`);
      assert.deepEqual(viewerMessages[language][key].match(/\{\w+\}/gu)?.sort() ?? [], viewerMessages.ko[key].match(/\{\w+\}/gu)?.sort() ?? []);
    }
  }
  assert.equal(viewerMessages.en["라이브 참여"], "Join live call");
  assert.equal(viewerMessages.ja["원문"], "原文");
  assert.match(viewerMessages.en["이 회의의 원문과 요약은 종료 후 6시간 동안 확인할 수 있어요."], /6 hours/u);
});

test("system language only enters display code and cannot recreate viewer connections or change consent purposes", () => {
  const viewer = readFileSync(new URL("../../components/live/LiveViewer.tsx", import.meta.url), "utf8");
  assert.match(viewer, /useSystemText\(viewerMessages\)/u);
  for (const dependencies of viewer.matchAll(/\},\s*\[([^\]]*)\]\)/gu)) {
    assert.doesNotMatch(dependencies[1], /\bsystemLanguage\b|\bsystemLocale\b|\bt\b/u);
  }
  assert.doesNotMatch(viewer, /fetch\([^)]*(?:systemLanguage|systemLocale)|setLanguage\(systemLanguage\)/u);
  for (const file of ["ViewerReadingFeed.tsx", "ParticipantMeetingMinutes.tsx"]) {
    const source=readFileSync(new URL(`../../components/live/${file}`,import.meta.url),"utf8");
    assert.doesNotMatch(source,/t\((?:caption\.text|entry\.text|summary\.overview|chapter\.summary|topic\.summary)\)/u);
  }
  const notices=readFileSync(new URL("../../components/live/consent/consent-notice-presentation.ts",import.meta.url),"utf8");
  for(const version of ["privacy-v1","summary-delivery-v1","marketing-v1"])assert.ok(notices.includes(version));
});

test("interpolated status uses the current system language without rewriting connection state", () => {
  const status = "Reconnecting · retrying in 1.5s";
  assert.equal(formatViewerSystemStatus(status, (key, values) => formatSystemText(viewerMessages, "en", key, values)), status);
  assert.equal(formatViewerSystemStatus(status, (key, values) => formatSystemText(viewerMessages, "ja", key, values)), "再接続中・1.5秒後に再試行");
  assert.equal(formatSystemText(viewerMessages,"en","{current}/{maximum}명 참여",{current:3,maximum:50}),"3/50 participants");
});

test("actual participant reading controls render in three locales while speech and its language stay exact", () => {
  function loadModule(path: string, imports: Record<string, unknown>) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const loaded: { exports: Record<string, unknown> } = { exports: {} };
    const available = { "react": React, "react/jsx-runtime": jsxRuntime, ...imports };
    new Function("require", "module", "exports", compiled)((id: string) => {
      if (!Object.hasOwn(available, id)) throw new Error(`Unexpected component import: ${id}`);
      return available[id as keyof typeof available];
    }, loaded, loaded.exports);
    return loaded.exports;
  }
  const provider = loadModule("../../components/system-language/SystemLanguageProvider.tsx", { "../../lib/system-language": systemLanguage });
  const identity = loadModule("../../components/live/SpeakerIdentity.tsx", {
    "../../../packages/caption-core/speaker-profile.js": { buildSpeakerPhotoUrl },
    "./SpeakerRosterEditor.module.css": { default: { identity: "identity", organization: "organization" } },
  });
  const feed = loadModule("../../components/live/ViewerReadingFeed.tsx", {
    "@/components/system-language/SystemLanguageProvider": provider,
    "@/lib/system-language/viewer-messages": { viewerMessages },
    "./SpeakerIdentity": identity,
  });
  assert.equal(typeof provider.SystemLanguageProvider, "function");
  assert.equal(typeof feed.ViewerReadingFeed, "object");
  const Provider = provider.SystemLanguageProvider as React.ComponentType<{ initialLanguage: systemLanguage.SystemLanguage; children: React.ReactNode }>;
  const Feed = feed.ViewerReadingFeed as React.ComponentType<Record<string, unknown>>;
  const minutes = loadModule("../../components/live/ParticipantMeetingMinutes.tsx", {
    "@/components/system-language/SystemLanguageProvider": provider,
    "@/lib/system-language/viewer-messages": { viewerMessages },
    "@/lib/system-language": systemLanguage,
    "./meeting-minutes-model": { formatMinuteTime: (instant: string) => instant },
    "./ViewerRecapRequest": { ViewerRecapRequest: () => null },
    "./SummarySkeleton": loadModule("../../components/live/SummarySkeleton.tsx", {}),
  });
  const Minutes = minutes.ParticipantMeetingMinutes as React.ComponentType<Record<string, unknown>>;
  for (const locale of ["ko", "en", "ja"] as const) {
    const content = React.createElement(Feed, { language: "ko", kind: "source", captions: [{
      id: "source-1", text: "라이브 참여", language: "ko", speakerLabel: "참여자", isFinal: false,
    }] });
    const html = renderToStaticMarkup(React.createElement(Provider, { initialLanguage: locale, children: content }));
    assert.ok(html.includes(viewerMessages[locale]["실시간 원문"]));
    assert.ok(html.includes(viewerMessages[locale]["작성 중"]));
    assert.ok(html.includes(viewerMessages[locale]["참여자"]));
    assert.match(html, /lang="ko" class="viewer-caption-text">라이브 참여</u);
    const records = React.createElement(Minutes, {
      sessionId: "session-1", email: "test@example.com", summary: null, transcript: [], topics: [],
      isTranscriptLoaded: true, summaryError: "", transcriptError: "", isLoading: false, isExpired: false, onRetry() {},
      recordingGaps: [{ id: "gap-1", startedAt: "2026-09-01T00:00:00.000Z", endedAt: null, reason: "source_recording_failed" }],
    });
    const recordsHtml = renderToStaticMarkup(React.createElement(Provider, { initialLanguage: locale, children: records }));
    assert.ok(recordsHtml.includes(viewerMessages[locale]["원문 기록 중단"]));
    assert.ok(recordsHtml.includes(viewerMessages[locale]["종료 시각 미확인"]));
    assert.ok(recordsHtml.includes(viewerMessages[locale]["아래 구간의 발언 원문은 기록되지 않았어요."]));
    assert.ok(!recordsHtml.includes(viewerMessages[locale]["미디어 연결 중단"]), "source-only recording failure must not claim media failure");
    assert.match(recordsHtml, /dateTime="2026-09-01T00:00:00.000Z"/iu);
  }
});
