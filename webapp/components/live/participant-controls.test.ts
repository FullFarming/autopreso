import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { CircleNotch, Record as RecordIcon, Stop } from "@phosphor-icons/react";
import { formatSystemText, type SystemLanguage, type SystemMessages, type SystemTextValues } from "../../lib/system-language";
import { viewerMessages } from "../../lib/system-language/viewer-messages";
import { LANGUAGE_CODES } from "../../lib/languageDetect";
import * as languageLabels from "./language-picker";
import * as presentation from "./translation/topic-presentation";

const require = createRequire(import.meta.url);
function load(file: string, language: SystemLanguage) {
  const dependencies: Record<string, unknown> = {
    "@phosphor-icons/react": { CircleNotch, Record: RecordIcon, Stop },
    "@/components/system-language/SystemLanguageProvider": { useSystemText: (messages: SystemMessages) => (key: string, values?: SystemTextValues) => formatSystemText(messages, language, key, values) },
    "@/lib/system-language/viewer-messages": { viewerMessages },
    "../language-picker": languageLabels,
    "./topic-presentation": presentation,
    "./translation.module.css": { default: {} },
  };
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const output = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
  new Function("require", "module", "exports", code)((id: string) => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id), output, output.exports);
  return output.exports;
}

test("participant language names use autonyms for every supported target without changing routing codes", () => {
  const expected = ["English", "한국어", "日本語", "简体中文 普通话", "繁體中文 國語", "Español", "Português", "Français", "Deutsch", "Русский", "हिन्दी हिंदी", "Bahasa Indonesia", "Tiếng Việt", "Italiano"];
  assert.deepEqual(LANGUAGE_CODES.map(languageLabels.getNativeLanguageLabel), expected);
  assert.equal(languageLabels.getNativeLanguageLabel("en-US"), "English");
  assert.equal(languageLabels.getNativeLanguageLabel("ko-KR"), "한국어");
  assert.equal(languageLabels.getNativeLanguageLabel("unlisted-code"), "unlisted-code");
});

test("actual participant tabs retain source, selected lane and native names in every UI language", () => {
  for (const language of ["ko", "en", "ja"] as const) {
    const { TranslationLaneTabs } = load("./translation/TranslationLaneTabs.tsx", language);
    const props = { participantControls: true, lanes: presentation.buildTranslationLanes("ko", ["ko", "en", "ja"]), selectedLaneId: "translation:en", onChange: () => { throw new Error("Rendering must not change selection"); }, renderPanel: (lane: {id: string}) => createElement("p", null, lane.id) };
    const html = renderToStaticMarkup(createElement(TranslationLaneTabs, props));
    assert.match(html, /data-participant-controls="true"/u);
    for (const label of ["한국어", "English", "日本語", viewerMessages[language]["원문"]]) assert.ok(html.includes(`>${label}</button>`), `${language}: ${label}`);
    assert.match(html, /lang="en"[^>]*aria-selected="true"/u);
    assert.match(html, /<p>translation:en<\/p>/u);
    assert.equal((html.match(/role="tab"/gu) ?? []).length, 4);
    const shared = renderToStaticMarkup(createElement(TranslationLaneTabs, { ...props, participantControls: false }));
    assert.doesNotMatch(shared, /data-participant-controls=/u);
    for (const label of ["한국어", "English", "日本語"]) assert.ok(shared.includes(`>${label}</button>`), `${language}: shared ${label}`);
  }
});

test("actual speaking controls have no visible words and preserve record, connecting, and stop semantics", () => {
  for (const language of ["ko", "en", "ja"] as const) {
    const { ParticipantSpeakButton } = load("./ParticipantSpeakButton.tsx", language);
    for (const state of ["idle", "starting", "speaking"] as const) {
      const html = renderToStaticMarkup(createElement(ParticipantSpeakButton, { state, disabled: state === "idle", onClick: () => undefined }));
      const label = viewerMessages[language][state === "idle" ? "발언 시작" : state === "starting" ? "발언 연결 중" : "발언 종료"];
      assert.ok(html.includes(`aria-label="${label}"`));
      assert.ok(html.includes(`data-speak-state="${state}"`));
      assert.ok(html.includes(`aria-pressed="${state !== "idle"}"`));
      assert.match(html, /<svg[^>]*aria-hidden="true"/u);
      assert.equal(html.replace(/<[^>]*>/gu, "").trim(), "");
      assert.equal(html.includes('disabled=""'), state === "idle");
    }
  }
});

test("participant styles show separate 44px controls and stop animation for reduced motion", () => {
  const tabs = readFileSync(new URL("./translation/translation.module.css", import.meta.url), "utf8");
  const globals = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  assert.match(tabs, /\.laneTabList\[data-participant-controls="true"\]/u);
  assert.match(tabs, /min-height: 44px/u);
  assert.match(tabs, /outline: 2px solid var\(--nova-system-default\)/u);
  assert.match(globals, /viewer-microphone-capsule:not\(:disabled\):hover/u);
  assert.match(globals, /viewer-microphone-capsule:not\(:disabled\):active/u);
  assert.match(globals, /@media \(prefers-reduced-motion: reduce\)[\s\S]*viewer-microphone-capsule[\s\S]*transform: none/u);
});
