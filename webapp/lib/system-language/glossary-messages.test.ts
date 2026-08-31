import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { glossaryMessages, formatGlossaryStatus, formatGlossaryLanguageTag } from "./glossary-messages";
import { formatSystemText } from "../system-language";

test("glossary catalogs cover all three languages and preserve interpolation parameters", () => {
  const keys = Object.keys(glossaryMessages.ko).sort();
  for (const language of ["en", "ja"] as const) {
    assert.deepEqual(Object.keys(glossaryMessages[language]).sort(), keys);
    for (const key of keys) {
      assert.ok(glossaryMessages[language][key]?.trim(), key);
      assert.deepEqual(glossaryMessages[language][key].match(/\{\w+\}/gu)?.sort() ?? [], glossaryMessages.ko[key].match(/\{\w+\}/gu)?.sort() ?? [], key);
    }
  }
});

test("glossary display translates status metadata without changing user text", () => {
  const t = (key: string, values?: Record<string, string | number>) => formatSystemText(glossaryMessages, "en", key, values);
  assert.equal(formatGlossaryStatus("버전 3을 활성화했습니다.", t), "Version 3 is now active.");
  assert.equal(formatGlossaryStatus("같은 용어의 번역이 충돌합니다: 용어집 편집, NOI", t), "Conflicting translations: 용어집 편집, NOI");
  assert.equal(formatGlossaryLanguageTag("원문 ko", t), "Source ko");
  assert.equal(formatGlossaryLanguageTag("ko", t), "ko");
  assert.equal(formatGlossaryStatus("Private glossary name", t), "Private glossary name");
});

test("glossary localization stays out of domain actions and existing fetch dependencies", () => {
  const directory = new URL("../../components/live/glossary/", import.meta.url);
  const files = readdirSync(directory).filter((file) => file.endsWith(".tsx"));
  for (const file of files) {
    const source = readFileSync(new URL(file, directory), "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (["useEffect", "useCallback"].includes(node.expression.text) && node.arguments[1]) {
          assert.doesNotMatch(node.arguments[1].getText(tree), /\b(?:t|systemLanguage|systemLocale)\b/u);
        }
        if (node.expression.text === "t" && ts.isStringLiteral(node.arguments[0])) {
          assert.ok(Object.hasOwn(glossaryMessages.ko, node.arguments[0].text), `${file}: ${node.arguments[0].text}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    assert.doesNotMatch(source, /\bt\((?:term\.(?:source|target)|preset\.name|preview\.name|props\.preset\.(?:name|domain)|prompt|pasted)\)/u);
  }
  for (const file of ["glossary-client.ts", "glossary-controller.ts", "glossary-registration.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(file, directory), "utf8"), /system-language|useSystemText/u);
  }
});

test("rendered glossary rows translate actions while preserving source, translation and alias values", () => {
  let language: "ko" | "en" | "ja" = "ko";
  const t = (key: string, values?: Record<string, string | number>) => formatSystemText(glossaryMessages, language, key, values);
  const source = readFileSync(new URL("../../components/live/glossary/GlossaryTermRows.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded: { exports: Record<string, unknown> } = { exports: {} };
  const imports: Record<string, unknown> = {
    "react/jsx-runtime": jsxRuntime,
    "@/components/system-language/SystemLanguageProvider": { useSystemText: () => t },
    "@/lib/system-language/glossary-messages": { glossaryMessages },
    "./glossary.module.css": { default: {} },
  };
  new Function("require", "module", "exports", compiled)((id: string) => {
    if (!Object.hasOwn(imports, id)) throw new Error(`Unexpected import: ${id}`);
    return imports[id];
  }, loaded, loaded.exports);
  assert.equal(typeof loaded.exports.GlossaryTermRows, "function");
  const Rows = loaded.exports.GlossaryTermRows as React.ComponentType<Record<string, unknown>>;
  let actions = 0;
  const action = () => actions++;
  const props = {
    window: { items: [{ index: 0, term: { id: "term-1", source: "용어집 편집", target: "Original translation", aliases: ["입력 용어"], status: "candidate" } }], totalMatchCount: 1, hasPrevious: false, hasNext: false },
    drafts: {}, onAddTerm: action, onRemoveTerm: action, onApproveCandidate: action, onRejectCandidate: action, onChangeDraft: action, onPrevious: action, onNext: action,
  };
  for (const locale of ["ko", "en", "ja"] as const) {
    language = locale;
    const html = renderToStaticMarkup(React.createElement(Rows, props));
    assert.ok(html.includes(glossaryMessages[locale]["후보 승인"]));
    assert.ok(html.includes(glossaryMessages[locale]["이전 50개 보기"]));
    for (const value of ["용어집 편집", "Original translation", "입력 용어"]) assert.ok(html.includes(`value="${value}"`));
  }
  assert.equal(actions, 0);
});
