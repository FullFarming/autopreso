import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { formatSystemText, type SystemLanguage, type SystemMessages, type SystemTextValues } from "../../../lib/system-language";
import { formatSystemRecordDate, formatSystemRecordTime, recordsMessages } from "../../../lib/system-language/records-messages";
import { authMessages } from "../../../lib/system-language/auth-messages";
import * as hostSessionClient from "../../../lib/auth/host-session-client";
import * as loginRetry from "../../../app/(login)/login/login-retry";
import * as loginCardModel from "../../../components/auth/login-card-model";
import { loginMessages } from "../../../lib/system-language/login-messages";

const componentFiles = ["./LiveRecordsList.tsx", "./LiveRecordDetail.tsx", "./LiveRecordsRoute.tsx", "./RecordContentPanels.tsx", "./RecordPeopleTable.tsx", "../../GlassTopBar.tsx", "../../../app/(login)/login/page.tsx", "../../../components/auth/LoginCard.tsx",
  "../MeetingMinutes.tsx", "../MeetingSummaryCard.tsx", "../quality/MeetingTopicPresentation.tsx", "../earnings/EarningsCallHeader.tsx", "../earnings/EarningsCallContext.tsx", "../earnings/EarningsSectionNav.tsx", "../earnings/SelectedTranscriptSearch.tsx", "../earnings/GlossaryMatchDisclosure.tsx", "../earnings/GroundedPostCallIndex.tsx"];

test("records and login dictionaries cover three languages with identical interpolation contracts", () => {
  const placeholders = (text: string) => [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/gu)].map((match) => match[1]).sort();
  for (const language of ["en", "ja"] as const) {
    assert.deepEqual(Object.keys(recordsMessages[language]), Object.keys(recordsMessages.ko));
    for (const [key, message] of Object.entries(recordsMessages[language])) {
      assert.ok(message.trim(), `${language}: ${key}`);
      assert.notEqual(message, key, `${language}: untranslated ${key}`);
      assert.deepEqual(placeholders(message), placeholders(key), `${language}: ${key}`);
    }
  }
  assert.equal(formatSystemText(recordsMessages, "en", "삭제하려면 기록 제목 “{title}”을 입력하세요.", { title: "검색<script>" }), "Enter the record title “검색<script>” to delete it.");
});

test("record timestamps keep the Seoul timezone while formatting the system language", () => {
  const instant = "2026-08-31T23:05:00.000Z";
  for (const [language, locale] of [["ko", "ko-KR"], ["en", "en-US"], ["ja", "ja-JP"]] as const) {
    assert.equal(formatSystemRecordDate(instant, language), new Intl.DateTimeFormat(locale, {
      timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(new Date(instant)));
    assert.equal(formatSystemRecordTime(instant, language), new Intl.DateTimeFormat(locale, {
      timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit",
    }).format(new Date(instant)));
    for (const invalid of [null, "", "not-a-date"]) assert.equal(formatSystemRecordDate(invalid, language), recordsMessages[language]["일정 없음"]);
    for (const invalid of [null, undefined, "", "not-a-date"]) assert.equal(formatSystemRecordTime(invalid, language), null);
  }
});

test("production records and login have no untranslated Korean JSX copy or locale-triggered IO dependencies", () => {
  for (const file of componentFiles) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function inspect(node: ts.Node) {
      if (ts.isJsxText(node)) assert.doesNotMatch(node.text.trim(), /[가-힣]/u, `${file}: untranslated JSX`);
      if (ts.isStringLiteral(node) && /[가-힣]/u.test(node.text)) {
        assert.ok(Object.hasOwn(recordsMessages.ko, node.text), `${file}: missing key ${node.text}`);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["useEffect", "useCallback"].includes(node.expression.text)) {
        const dependencies = node.arguments[1];
        if (dependencies) assert.doesNotMatch(dependencies.getText(parsed), /\b(?:language|setLanguage)\b/u, `${file}: interface locale must not trigger IO`);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(parsed);
    assert.doesNotMatch(source, /key=\{(?:language|t\()/u, `${file}: locale must not remount panels`);
    assert.doesNotMatch(source, /SystemLanguageButton/u, `${file}: global menu must not be duplicated`);
  }
});

const require = createRequire(import.meta.url);

function loadComponent(file: string, language: SystemLanguage, additional: Record<string, unknown> = {}) {
  const dependencies: Record<string, unknown> = {
    "@/components/system-language/SystemLanguageProvider": {
      useSystemLanguage: () => ({ language }),
      useSystemText: (messages: SystemMessages) => (key: string, values?: SystemTextValues) => formatSystemText(messages, language, key, values),
    },
    "@/lib/system-language/records-messages": { recordsMessages, formatSystemRecordDate, formatSystemRecordTime },
    "@/lib/system-language/auth-messages": { authMessages },
    "@/lib/auth/host-session-client": hostSessionClient,
    "./login-retry": loginRetry,
    "./live-records.module.css": { default: {} },
    "./earnings.module.css": { default: {} },
    ...additional,
  };
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const output = { exports: {} as Record<string, ComponentType<Record<string, unknown>>> };
  new Function("require", "module", "exports", code)((id: string) => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id), output, output.exports);
  return output.exports;
}

test("actual list and summary renders translate controls while preserving meeting and AI content", () => {
  for (const language of ["ko", "en", "ja"] as const) {
    const { LiveRecordsList } = loadComponent("./LiveRecordsList.tsx", language);
    const list = renderToStaticMarkup(createElement(LiveRecordsList, {
      records: [{ id: "record-1", title: "검색 <script>literal</script>", scheduledAt: null, status: { label: "종료", state: "ok" }, languages: ["ko"], participantCount: 7, summaryState: { label: "요약 완료", state: "ok" } }],
      query: "참여자", activeQuery: "", totalRecords: 1, page: 1, totalPages: 1,
    }));
    assert.ok(list.includes(recordsMessages[language]["라이브콜 기록"]));
    assert.ok(list.includes(recordsMessages[language]["요약 완료"]));
    assert.match(list, /검색 &lt;script&gt;literal&lt;\/script&gt;/u);
    assert.match(list, /value="참여자"/u);
    assert.doesNotMatch(list, /<script>/u);

    const { RecordSummaryPanel } = loadComponent("./RecordContentPanels.tsx", language, {
      "../transcript-reading-model": {}, "./records-client": {},
    });
    const summary = renderToStaticMarkup(createElement(RecordSummaryPanel, {
      status: "ready", summary: { createdAt: "2026-08-31T00:00:00.000Z", summary: {
        title: "AI 요약", overview: "회의의 원래 한국어 내용", chapters: [], decisions: ["주요 결정"],
        actionItems: [{ description: "다음 할 일", owner: "참여자", due: "원문" }], speakerHighlights: [], participationStats: [],
      } },
    }));
    assert.match(summary, /<h2>AI 요약<\/h2>/u);
    assert.match(summary, /회의의 원래 한국어 내용/u);
    assert.match(summary, /<li>주요 결정<\/li>/u);
    assert.match(summary, /<p>다음 할 일<\/p>/u);
    assert.ok(summary.includes(recordsMessages[language]["주요 결정"]));
    assert.ok(summary.includes(formatSystemText(recordsMessages, language, "담당 {owner} · 기한 {due}", { owner: "참여자", due: "원문" })));
  }
});

test("host original panel labels source-only gaps distinctly in all languages even with no transcript", () => {
  const react = require("react") as typeof import("react");
  const gap = { id: "gap-1", startedAt: "2026-09-01T00:00:00.000Z", endedAt: null, reason: "source_recording_failed" };
  for (const language of ["ko", "en", "ja"] as const) {
    let stateIndex = 0;
    const { RecordOriginalPanel } = loadComponent("./RecordContentPanels.tsx", language, {
      react: { ...react, useState: (initial: unknown) => react.useState(++stateIndex === 2 ? [gap] : initial) },
      "../transcript-reading-model": { groupTranscriptReading: () => [] }, "./records-client": {},
    });
    const html = renderToStaticMarkup(createElement(RecordOriginalPanel, { sessionId: "record-1" }));
    assert.ok(html.includes(recordsMessages[language]["원문 기록 중단"]));
    assert.ok(html.includes(recordsMessages[language]["종료 시각 확인 중"]));
    assert.ok(!html.includes(recordsMessages[language]["오디오 처리 중단"]));
    assert.match(html, /dateTime="2026-09-01T00:00:00.000Z"/iu);
  }
});

test("actual login labels and topbar status translate without changing endpoint or credentials", () => {
  for (const language of ["ko", "en", "ja"] as const) {
    const formControls = {
      FormField: ({ label, ...props }: Record<string, unknown>) => createElement("label", null, String(label), createElement("input", props)),
      FormButton: (props: Record<string, unknown>) => createElement("button", props),
      FormError: (props: Record<string, unknown>) => createElement("p", props),
    };
    const { LoginCard } = loadComponent("../../../components/auth/LoginCard.tsx", language, {
      "@/components/ui/FormControls": formControls,
      "@/app/(login)/login/login-retry": loginRetry,
      "@/lib/system-language/login-messages": { loginMessages },
      "@/lib/auth/supabase-browser": { getBrowserSupabase: () => { throw new Error("SUPABASE_PUBLIC_CONFIG_MISSING"); } },
      "./AuthShell": loadComponent("../../../components/auth/AuthShell.tsx", language),
      "./GoogleIcon": loadComponent("../../../components/auth/GoogleIcon.tsx", language),
      "./login-card-model": loginCardModel,
    });
    const login = renderToStaticMarkup(createElement(LoginCard));
    assert.ok(login.includes(loginMessages[language].title));
    assert.ok(login.includes(loginMessages[language].password));
    assert.ok(login.includes(loginMessages[language].googleContinue));
    assert.match(login, /data-auth-action="google"/u);
    assert.match(login, /name="identifier"/u);
    assert.match(login, /name="password"/u);
    assert.match(login, /href="\/watch"/u);
    assert.doesNotMatch(login, /name="name"/u, "sign-in mode asks for credentials only");
    const { default: GlassTopBar } = loadComponent("../../GlassTopBar.tsx", language, { "next/navigation": { useRouter: () => ({}) } });
    const topbar = renderToStaticMarkup(createElement(GlassTopBar, { status: "connecting" }));
    assert.ok(topbar.includes(recordsMessages[language]["연결 중"]));
    assert.ok(topbar.includes(recordsMessages[language]["설정"]));
  }
});

test("meeting summary and earnings chrome server-render in all locales without translating supplied data", () => {
  for (const language of ["ko", "en", "ja"] as const) {
    const { default: MeetingSummaryCard } = loadComponent("../MeetingSummaryCard.tsx", language);
    const summary = renderToStaticMarkup(createElement(MeetingSummaryCard, { summary: {
      title: "회의 요약", overview: "원문", chapters: [{ title: "주제", summary: "검색" }], decisions: ["주요 결정"],
      actionItems: [{ description: "다음 할 일", owner: "참여자", due: "미정" }], speakerHighlights: [{ speaker: "진행자", highlight: "실제 발언 요약" }],
    } }));
    assert.match(summary, /<h2>회의 요약<\/h2>/u);
    assert.match(summary, /<strong>주제<\/strong>/u);
    assert.match(summary, /<strong>진행자<\/strong>/u);
    assert.ok(summary.includes(recordsMessages[language]["AI 회의 요약"]));
    assert.ok(summary.includes(recordsMessages[language]["발언자별 핵심"]));

    const { EarningsCallHeader } = loadComponent("../earnings/EarningsCallHeader.tsx", language, {
      "./earnings-presentation": { SECTION_LABELS: { qa: "질의응답" } },
    });
    const header = renderToStaticMarkup(createElement(EarningsCallHeader, { event: { companyName: "실적 발표", ticker: "NOVA", fiscalPeriod: "2026년 2분기", activeSection: "qa", sectionStartedAt: "2026-08-31T01:00:00.000Z" } }));
    assert.match(header, /<strong>실적 발표 · NOVA<\/strong>/u);
    assert.match(header, /2026년 2분기/u);
    assert.ok(header.includes(recordsMessages[language]["질의응답"].replaceAll("&", "&amp;")));

    const { GlossaryMatchDisclosure } = loadComponent("../earnings/GlossaryMatchDisclosure.tsx", language);
    const glossary = renderToStaticMarkup(createElement(GlossaryMatchDisclosure, { matches: [{ id: "glossary-1", sourceLabel: "용어 일치", targetLabel: "원문", count: 2 }] }));
    assert.match(glossary, /<span>용어 일치<\/span><span>원문<\/span>/u);
    assert.ok(glossary.includes(formatSystemText(recordsMessages, language, "용어 일치 · {count}", { count: 1 })));
  }
});

test("new client topic and section chrome can still server-render without accessing browser globals", () => {
  for (const language of ["ko", "en", "ja"] as const) {
    const { MeetingTopicNavigator, MeetingTopicChapters } = loadComponent("../quality/MeetingTopicPresentation.tsx", language, {
      "../translation": { topicDomId: (id: string) => id, CompletedTopicAccordion: ({ captionCountLabel, ariaLabel }: { captionCountLabel: (count: number) => string; ariaLabel: string }) => createElement("section", { "aria-label": ariaLabel }, captionCountLabel(7)) },
      "./topic-navigation": { buildTopicNavigationModel: (topics: unknown[]) => ({ mode: "select", options: topics }), revealTopicTarget: () => undefined },
    });
    const topics = [{ id: "topic-1", title: "주제를 선택하세요" }];
    const navigator = renderToStaticMarkup(createElement(MeetingTopicNavigator, { topics }));
    assert.match(navigator, /value="topic-1">주제를 선택하세요<\/option>/u);
    assert.ok(navigator.includes(recordsMessages[language]["주제로 이동"]));
    const chapters = renderToStaticMarkup(createElement(MeetingTopicChapters, { topics }));
    assert.ok(chapters.includes(formatSystemText(recordsMessages, language, "자막 {count}개", { count: 7 })));
    const { EarningsSectionNav } = loadComponent("../earnings/EarningsSectionNav.tsx", language, {
      "./earnings-presentation": { SECTION_LABELS: { prepared_remarks: "발표", qa: "질의응답", other: "기타" } },
    });
    const nav = renderToStaticMarkup(createElement(EarningsSectionNav, { activeSection: "qa", targetId: "captions" }));
    assert.ok(nav.includes(recordsMessages[language]["완료"]));
    assert.ok(nav.includes(recordsMessages[language]["현재"]));
    assert.ok(nav.includes(recordsMessages[language]["예정"]));
    assert.match(nav, /href="#captions" aria-current="location"/u);
  }
});
