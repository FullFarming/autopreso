import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createElement, type ComponentType } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

import { formatHostGlossaryLabel, hostMessages } from "./host-messages";
import { formatSystemText, type SystemLanguage, type SystemTextValues } from "../system-language";
import { getGatewayConnectionPresentation } from "../../components/live/status/gateway-connection-presentation";

test("host chrome has complete English and Japanese catalogs with identical placeholders", () => {
  const koreanKeys = Object.keys(hostMessages.ko).sort();
  for (const language of ["en", "ja"] as const) {
    assert.deepEqual(Object.keys(hostMessages[language]).sort(), koreanKeys);
    for (const key of koreanKeys) {
      assert.ok(hostMessages[language][key].trim(), key);
      assert.deepEqual(hostMessages[language][key].match(/\{\w+\}/gu)?.sort() ?? [], hostMessages.ko[key].match(/\{\w+\}/gu)?.sort() ?? [], key);
    }
  }
  assert.equal(hostMessages.en["세션 만들기"], "Create session");
  assert.equal(hostMessages.ja["세션 만들기"], "セッションを作成");
  assert.equal(hostMessages.ko["세션 만들기"], "세션 만들기");
});

test("rendered host connection and countdown controls follow all three locales without changing actions", () => {
  let language: SystemLanguage = "ko";
  const t = (key: string, values?: SystemTextValues) => formatSystemText(hostMessages, language, key, values);
  function loadComponent(file: string, name: string): ComponentType<Record<string, unknown>> {
    const source = readFileSync(new URL(`../../components/live/status/${file}`, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const loaded: { exports: Record<string, unknown> } = { exports: {} };
    const imports: Record<string, unknown> = {
      "react/jsx-runtime": jsxRuntime,
      "@/components/system-language/SystemLanguageProvider": { useSystemText: () => t },
      "@/lib/system-language/host-messages": { hostMessages },
      "./gateway-connection-presentation": { getGatewayConnectionPresentation },
      "./gateway-connection-status.module.css": { default: {} },
      "./scheduled-gateway-countdown.module.css": { default: {} },
    };
    new Function("require", "module", "exports", compiled)((id: string) => {
      if (!Object.hasOwn(imports, id)) throw new Error(`Unexpected component import: ${id}`);
      return imports[id];
    }, loaded, loaded.exports);
    const component = loaded.exports[name];
    assert.equal(typeof component, "function");
    return component as ComponentType<Record<string, unknown>>;
  }
  const Connection = loadComponent("GatewayConnectionStatus.tsx", "GatewayConnectionStatus");
  const Countdown = loadComponent("ScheduledGatewayCountdown.tsx", "ScheduledGatewayCountdown");
  let actions = 0;
  const props = { remainingMilliseconds: 60_000, state: "action-required", onRetry: () => actions++, onCancel: () => actions++ };
  for (const locale of ["ko", "en", "ja"] as const) {
    language = locale;
    const connection = renderToStaticMarkup(createElement(Connection, { state: "connected" }));
    const countdown = renderToStaticMarkup(createElement(Countdown, props));
    assert.ok(connection.includes(hostMessages[locale]["실시간 연결"]));
    assert.ok(connection.includes(hostMessages[locale]["연결됨"]));
    assert.ok(countdown.includes(hostMessages[locale]["다시 시도"]));
    assert.ok(countdown.includes(hostMessages[locale]["자동 시작 취소"]));
    assert.doesNotMatch(countdown, /00:01:00|role="timer"/u);
    for (const state of ["countdown", "warming"]) {
      const waiting = renderToStaticMarkup(createElement(Countdown, { ...props, state }));
      assert.match(waiting, /role="timer"/u);
      assert.ok(waiting.includes("00:01:00"));
    }
    for (const state of ["connecting", "confirming", "cancelled"]) {
      const pending = renderToStaticMarkup(createElement(Countdown, { ...props, state }));
      assert.doesNotMatch(pending, /00:01:00|role="timer"/u);
    }
  }
  assert.equal(actions, 0);
  props.onRetry();
  props.onCancel();
  assert.equal(actions, 2);
});

test("glossary metadata translates while the selected user glossary name remains exact", () => {
  const t = (key: string, values?: SystemTextValues) => formatSystemText(hostMessages, "en", key, values);
  assert.equal(formatHostGlossaryLabel("세션 만들기 · 활성 버전 2 · 총 3개", t), "세션 만들기 · Active version 2 · 3 total");
  assert.equal(formatHostGlossaryLabel("2개 선택", t), "2 selected");
  assert.equal(formatHostGlossaryLabel("2개 적용", t), "2 applied");
});

test("host localization never becomes a dependency of connection or scheduled work", () => {
  const source = readFileSync(new URL("../../components/live/LiveHostDashboard.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("host.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effects = 0;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["useEffect", "useCallback"].includes(node.expression.text)) {
      const dependencies = node.arguments[1];
      if (dependencies) assert.doesNotMatch(dependencies.getText(tree), /\b(?:t|systemLanguage|languageLocale)\b/u);
      assert.doesNotMatch(node.arguments[0]?.getText(tree) ?? "", /\bt\(/u);
      effects++;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(effects > 10);
  assert.match(source, /useSystemText\(hostMessages\)/u);
  assert.match(source, /value=\{title\}/u);
  assert.match(source, /value=\{agendaText\}/u);
  assert.match(source, /captions=\{hostCaptions\}/u);
  const domainFunction = source.slice(source.indexOf("function buildLiveSessionDomainText"), source.indexOf("const OUTPUT_OPTIONS"));
  assert.doesNotMatch(domainFunction, /\bt\(/u);
  assert.match(source, /REQUIRED_SESSION_LANGUAGES = \["en", "ko"\]/u);
});

test("every explicit host translation key exists without translating user and AI content", () => {
  for (const file of ["LiveHostDashboard.tsx", "live-lanes/HostLiveLaneSurface.tsx", "quality/HostLiveSurface.tsx", "quality/HostAiHealthDisclosure.tsx", "status/GatewayConnectionStatus.tsx", "status/ScheduledGatewayCountdown.tsx"]) {
    const source = readFileSync(new URL(`../../components/live/${file}`, import.meta.url), "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) assert.ok(Object.hasOwn(hostMessages.ko, argument.text), `${file}: ${argument.text}`);
        if (argument) assert.doesNotMatch(argument.getText(tree), /\b(?:session\.title|recoverable\.title|speech\.text|caption\.text|hostSummary|hostTranscript|agendaText)\b/u);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
});
