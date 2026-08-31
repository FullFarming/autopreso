import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("viewer has one lane control and a top-right shared connection status", () => {
  const viewer = read("./LiveViewer.tsx");
  const surface = read("./quality/ViewerLiveSurface.tsx");
  assert.match(viewer, /GatewayConnectionStatus/u);
  assert.match(surface, /TranslationLaneTabs/u);
  assert.doesNotMatch(viewer, /<LanguageSelector/u,
    "TranslationLaneTabs must be the only viewer language control");
  assert.doesNotMatch(viewer, /\/health/u,
    "rendering connection state must never warm the gateway");
  assert.match(viewer, /useReducer\(transitionGatewayConnectionState, "idle"\)/u);
  assert.match(viewer, /type: "socket-opened"/u);
  assert.match(viewer, /type: "socket-closed"/u);
  assert.match(viewer, /type: "retry"/u);
  assert.match(viewer, /type: "viewer-session"/u);
  assert.match(viewer, /<GatewayConnectionStatus state=\{gatewayConnectionState\}/u);
  assert.doesNotMatch(viewer, /return "connected";[\s\S]{0,120}GatewayConnectionStatus/u);
  assert.ok(viewer.indexOf("await subscribed") < viewer.indexOf('type: "socket-opened"'),
    "connected may be published only after authenticate and subscribe complete");
});

test("demo uses the same single lane control and contains its 320px toolbar", () => {
  const demo = read("../../app/m/watch/demo/page.tsx");
  const styles = read("../../app/globals.css");
  assert.doesNotMatch(demo, /LanguageSelector/u);
  assert.equal((demo.match(/<TranslationLaneTabs/gu) ?? []).length, 1);
  assert.match(styles, /\.live-viewer-topic-demo \[role="toolbar"\]/u);
  assert.match(styles, /flex-wrap:\s*wrap/u);
  assert.match(styles, /max-width:\s*100%/u);
});

test("viewer admission composes three independent consent purposes", () => {
  const viewer = read("./LiveViewer.tsx");
  assert.match(viewer, /ParticipantConsentFields/u);
  assert.match(viewer, /privacyConsent/u);
  assert.match(viewer, /summaryDeliveryConsent/u);
  assert.match(viewer, /marketingConsent/u);
  assert.match(viewer, /hasValidProfile && privacyConsent/u);
  assert.match(viewer, /consentNoticeVersions/u);
  assert.match(viewer, /privacy:\s*PARTICIPANT_CONSENT_NOTICES\.privacy\.version/u);
  assert.match(viewer, /summaryDelivery:\s*PARTICIPANT_CONSENT_NOTICES\.summaryDelivery\.version/u);
  assert.match(viewer, /marketing:\s*PARTICIPANT_CONSENT_NOTICES\.marketing\.version/u);
});

test("host and viewer accept the frozen 200 participant boundary", () => {
  const host = read("./LiveHostDashboard.tsx");
  const viewerContract = read("./viewer-controller-contract.ts");
  assert.match(host, /id="live-capacity"[^>]*max=\{200\}/u);
  assert.match(host, /1명에서 200명까지/u);
  assert.match(host, /value >= 1 && value <= 200/u);
  assert.match(host, /최대 참여자는 1명에서 200명 사이로 설정해 주세요/u);
  assert.match(viewerContract, /Number\(value\.session\.maxViewers\) <= 200/u);
});

test("host exposes the shared status as the final live toolbar item", () => {
  const host = read("./LiveHostDashboard.tsx");
  const surface = read("./live-lanes/HostLiveLaneSurface.tsx");
  assert.match(host, /HostLiveLaneSurface/u);
  assert.match(surface, /GatewayConnectionStatus/u);
  const toolbarStart = surface.indexOf("<TranslationToolbar");
  const toolbarEnd = surface.indexOf("</TranslationToolbar>", toolbarStart);
  const toolbar = surface.slice(toolbarStart, toolbarEnd);
  assert.ok(toolbar.lastIndexOf("GatewayConnectionStatus") > toolbar.lastIndexOf("live-host-immediate-controls"));
  assert.match(surface, /TranslationLaneTabs/u);
});

test("records route composes the ADMIN list and selected detail controller seam", () => {
  const page = read("../../app/records/page.tsx");
  const route = read("./records/LiveRecordsRoute.tsx");
  const detail = read("./records/LiveRecordDetail.tsx");
  const originals = read("./records/RecordContentPanels.tsx");
  assert.match(page, /LiveRecordsRoute/u);
  assert.match(route, /LiveRecordsList/u);
  assert.match(route, /LiveRecordDetail/u);
  assert.match(route, /RecordSummaryPanel summary=\{detail\.summary\}/u);
  assert.match(detail, /"참여자", "원문", "AI 요약", "수신 신청자"/u);
  assert.match(detail, /RecordPeopleTable/u);
  assert.match(detail, /RecordOriginalPanel/u);
  assert.match(originals, /fetchLiveRecordOriginals/u);
  assert.match(originals, /nextAfterSourceSeq/u);
  assert.doesNotMatch(route, /MeetingMinutes|transcript\.utterances\.map/u);
  const routeWithoutSystemTextImport = route.replace(/^import \{ useSystemText \} from "@\/components\/system-language\/SystemLanguageProvider";\r?\n/mu, "");
  assert.match(route, /import \{ useSystemText \} from "@\/components\/system-language\/SystemLanguageProvider"/u);
  assert.doesNotMatch(routeWithoutSystemTextImport, /localStorage|sessionStorage|provider|model|token/iu);
});
