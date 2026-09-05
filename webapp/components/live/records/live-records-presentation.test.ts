import ts from "typescript";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  formatRecordDate,
  getRecordStatusPresentation,
  getSummaryStatusPresentation,
  getVisibleRecordTopics,
  normalizeRecordSearch,
} from "./live-records-presentation";
import { formatSystemRecordTime } from "../../../lib/system-language/records-messages";

test("record search is normalized and topic disclosure remains bounded", () => {
  assert.equal(normalizeRecordSearch("  2026년  실적  "), "2026년 실적");
  const topics = Array.from({ length: 1_000 }, (_, index) => ({ id: `topic-${index}`, title: `주제 ${index}` }));
  const initial = getVisibleRecordTopics(topics, 12);
  assert.equal(initial.length, 12);
  assert.equal(initial[11]?.id, "topic-11");
  assert.equal(getVisibleRecordTopics(topics, 24).length, 24);
});

test("record status contracts always pair a Korean label with a semantic state", () => {
  assert.deepEqual(getRecordStatusPresentation("live"), { label: "진행 중", state: "live" });
  assert.deepEqual(getRecordStatusPresentation("stopped"), { label: "종료", state: "ok" });
  assert.deepEqual(getRecordStatusPresentation("failed"), { label: "확인 필요", state: "error" });
  assert.deepEqual(getSummaryStatusPresentation("ready"), { label: "요약 완료", state: "ok" });
  assert.deepEqual(getSummaryStatusPresentation("running"), { label: "요약 중", state: "pending" });
  assert.deepEqual(getSummaryStatusPresentation("permanent_failed"), { label: "요약 확인 필요", state: "error" });
});

test("record dates are compact and invalid values never leak into the list", () => {
  assert.equal(formatRecordDate(null), "일정 없음");
  assert.equal(formatRecordDate("invalid"), "일정 없음");
  assert.match(formatRecordDate("2026-08-21T12:34:00.000Z"), /2026\. 8\. 21\./u);
});

test("records list and detail expose admin workflows without eager transcript DOM", () => {
  const list = readFileSync(new URL("./LiveRecordsList.tsx", import.meta.url), "utf8");
  const detail = readFileSync(new URL("./LiveRecordDetail.tsx", import.meta.url), "utf8");
  assert.match(list, /type="search"/u);
  assert.match(list, /aria-label=\{t\("라이브콜 기록 검색"\)\}/u);
  assert.match(list, /recordListSkeleton/u);
  assert.match(list, /data-state=\{record\.summaryState\.state\}/u);
  assert.match(list, /검색 결과가 없습니다/u);
  assert.match(list, /onRetry/u);
  assert.match(list, /이전[\s\S]*다음/u);
  assert.doesNotMatch(list, />ADMIN</u);
  assert.match(detail, /TranslationLaneTabs/u);
  assert.match(detail, /className=\{styles\.preview\}/u);
  assert.match(detail, /"참여자", "원문", "AI 요약", "수신 신청자"/u);
  assert.match(detail, /role="tablist"/u);
  assert.match(detail, /ArrowRight[\s\S]*ArrowLeft[\s\S]*Home[\s\S]*End/u);
  assert.match(detail, /RecordPeopleTable/u);
  assert.match(detail, /record\.syncState === "failed"[\s\S]*disabled=\{isRetryingSync\} onClick=\{onRetrySync\}>\{t\("동기화"\)\}/u);
  assert.match(detail, /삭제하려면 기록 제목/u);
  assert.match(detail, /deleteConfirmation !== record\.title/u);
  assert.match(detail, /placeholder=\{record\.title\}/u);
  assert.match(detail, /selectedTab === 1 && <RecordOriginalPanel/u);
  assert.match(detail, /ActionWithHelp label=\{t\("내보내기 도움말"\)\} help=\{t\("이 회의의 전체 기록"\)\}/u);
  assert.match(detail, /isExporting \? "준비 중" : "Excel 저장"/u);
  assert.match(detail, /anchor\.download = result\.fileName/u);
  assert.match(detail, /exportInFlightRef\.current/u);
  assert.doesNotMatch(detail, /dangerouslySetInnerHTML/u);
});

test("records controller keeps archive deletion recoverable and never fabricates privacy consent", () => {
  const route = readFileSync(new URL("./LiveRecordsRoute.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("./records-client.ts", import.meta.url), "utf8");
  assert.match(route, /삭제 취소/u);
  assert.match(route, /restoreLiveRecord/u);
  assert.match(client, /\/restore/u);
  assert.match(route, /privacyConsent:\s*participant\.consents\.privacy/u);
  assert.doesNotMatch(route, /privacyAcceptedAt:\s*participant\.joinedAt/u);
  assert.match(route, /RecordSummaryPanel summary=\{detail\.summary\}/u);
  assert.match(route, /isRetryingSync=\{isRetryingSync\}/u);
  assert.match(route, /isDeleting=\{isDeleting\}/u);
  assert.match(route, /setIsRetryingSync\(true\)[\s\S]*finally[\s\S]*setIsRetryingSync\(false\)/u);
  assert.match(route, /setIsDeleting\(true\)[\s\S]*finally[\s\S]*setIsDeleting\(false\)/u);
});

test("record language requests are session-lane keyed and stale responses cannot replace the selected lane", () => {
  const route = readFileSync(new URL("./LiveRecordsRoute.tsx", import.meta.url), "utf8");
  assert.match(route, /detailCacheRef/u);
  assert.match(route, /detailRequestGenerationRef/u);
  assert.match(route, /recordDetailCacheKey/u);
  assert.match(route, /requestGeneration !== detailRequestGenerationRef\.current/u);
  assert.match(route, /selectedDetailKeyRef\.current !== cacheKey/u);
  assert.match(route, /상세 기록을 불러오는 중/u);
});

test("record surfaces preserve NOVA focus, touch, responsive, and reduced-motion contracts", () => {
  const styles = readFileSync(new URL("./live-records.module.css", import.meta.url), "utf8");
  assert.match(styles, /min-height:\s*44px/u);
  assert.match(styles, /margin-left:\s*24px/u);
  assert.match(styles, /width:\s*calc\(100% - 24px\)/u);
  assert.match(styles, /\.statusChip/u);
  assert.match(styles, /\.statusDot/u);
  assert.match(styles, /\.recordListSkeleton/u);
  assert.match(styles, /outline:\s*2px solid var\(--nova-system-default\)/u);
  assert.match(styles, /@media \(max-width: 767px\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}|gradient|9999px/iu);
});


test("host originals render one speaker header per turn and preserve correction disclosure per fragment", () => {
  const panel = readFileSync(new URL("./RecordContentPanels.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./live-records.module.css", import.meta.url), "utf8");
  assert.match(panel, /readingTurns.map\(\(turn\) => <li/u);
  assert.match(panel, /RecordSpeakerIdentity speaker=\{recordedSpeakers.get\(turn.key\)\}[\s\S]*turn.startedAt/u);
  assert.match(panel, /turn.paragraphs.map/u);
  assert.match(panel, /paragraph.fragments.map/u);
  assert.match(panel, /data-source-utterance-id=\{fragment.id\}/u);
  assert.match(panel, /fragment.isCorrected && fragment.rawText !== fragment.text/u);
  assert.match(panel, /data-original-for=\{fragment.id\}/u);
  assert.match(panel, /최초 전사 보기/u);
  assert.match(styles, /\.transcriptParagraphs[^}]*gap: 16px/u);
  assert.match(styles, /\.transcriptList[^}]*gap: 32px/u);
  assert.doesNotMatch(panel, /effectiveText.replace|rawText.replace/u);
});

test("host originals keep one paragraph per speaker turn and stamp every utterance with its own time marker", () => {
  const panel = readFileSync(new URL("./RecordContentPanels.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./live-records.module.css", import.meta.url), "utf8");
  // One <p> per turn: the model guarantees paragraphs.length === 1, the renderer must not add a second <p> path.
  assert.equal((panel.match(/<p>\{paragraph.fragments.map/gu) ?? []).length, 1);
  assert.match(panel, /<time dateTime=\{fragment.startedAt\} className=\{styles.fragmentTime\}>/u);
  assert.match(panel, /formatSystemRecordTime\(fragment.startedAt, language, \{ seconds: true \}\)/u);
  assert.match(panel, /import \{ recordsMessages, formatSystemRecordDate, formatSystemRecordTime \} from "@\/lib\/system-language\/records-messages"/u);
  assert.match(styles, /\.fragmentTime \{[^}]*font-variant-numeric: tabular-nums;[^}]*color: var\(--nova-fg-secondary\);[^}]*user-select: none;[^}]*\}/u);
  assert.doesNotMatch(styles, /\.fragmentTime[^}]*(content:|url\(|emoji)/u);
  const instant = "2026-08-31T01:04:12.000Z";
  for (const [language, locale] of [["ko", "ko-KR"], ["en", "en-US"], ["ja", "ja-JP"]] as const) {
    assert.equal(formatSystemRecordTime(instant, language, { seconds: true }), new Intl.DateTimeFormat(locale, {
      timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(new Date(instant)));
    assert.equal(formatSystemRecordTime(instant, language), new Intl.DateTimeFormat(locale, {
      timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit",
    }).format(new Date(instant)));
    assert.equal(formatSystemRecordTime("not-a-date", language, { seconds: true }), null);
  }
});

test("host reading identity does not merge unknown speakers or participants without ids", () => {
  const panel = readFileSync(new URL("./RecordContentPanels.tsx", import.meta.url), "utf8");
  assert.match(panel, /speakerKey: getRecordSpeakerPresentation\(sessionId, item\).key/u);
  assert.match(panel, /speaker: getRecordSpeakerPresentation\(sessionId, item\).displayName/u);
  assert.match(panel, /seq: item.sourceSeq/u);
});

test("only demonstration numbering is removed and original pagination is retained", () => {
  const fixture = readFileSync(new URL("./demo/records-demo-fixture.ts", import.meta.url), "utf8");
  const demo = readFileSync(new URL("./demo/LiveRecordsDemo.tsx", import.meta.url), "utf8");
  assert.match(fixture, /effectiveText: sampleOriginals\[index % sampleOriginals.length\]/u);
  assert.match(fixture, /오늘은 2026년 2분기/u);
  assert.match(fixture, /length: 75/u);
  assert.match(fixture, /length: 45/u);
  assert.match(demo, /sourceSeq > cursor\).slice\(0, 50\)/u);
});

test("automatic summary refresh cannot revert a language switch or abort a manual read", () => {
  const route = readFileSync(new URL("./LiveRecordsRoute.tsx", import.meta.url), "utf8");
  const start = route.indexOf("  useEffect(() => {\n    if (!detail || error ||");
  const effect = route.slice(start, route.indexOf("  const presentation =", start));
  assert.ok(start >= 0);
  const code = ts.transpileModule(effect, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let timer: (() => void) | undefined;
  let cleanup: (() => void) | undefined;
  const refreshed: string[] = [];
  const selectedDetailKeyRef = { current: "meeting:ko" };
  const detailRequestPendingRef = { current: false };
  const dependencies = {
    useEffect: (callback: () => (() => void) | undefined) => { cleanup = callback(); },
    detail: { record: { sessionId: "meeting" }, selectedLanguage: "ko", summaryStates: { ko: { status: "running" } } },
    error: "", displayedDetailKey: "meeting:ko", selectedDetailKey: "meeting:ko", selectedDetailKeyRef, detailRequestPendingRef,
    document: { hidden: false }, setTimeout: (callback: () => void) => { timer = callback; return 1; }, clearTimeout: () => { timer = undefined; },
    openDetail: (_id: string, language: string) => { refreshed.push(language); },
  };
  const run = () => new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
  run(); selectedDetailKeyRef.current = "meeting:en"; assert.ok(timer); timer();
  assert.deepEqual(refreshed, [], "a stale KO timer must not select KO after EN was selected");
  cleanup?.(); selectedDetailKeyRef.current = "meeting:ko"; run();
  detailRequestPendingRef.current = true; assert.ok(timer); timer();
  assert.deepEqual(refreshed, [], "a same-language manual request must not be aborted by automatic refresh");
  detailRequestPendingRef.current = false; assert.ok(timer); timer();
  assert.deepEqual(refreshed, ["ko"], "automatic refresh resumes once the current selection is idle");
  cleanup?.(); assert.equal(timer, undefined);
});
