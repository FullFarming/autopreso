import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { validateHostAiHealthRows } from "./quality/host-ai-health";

const host = readFileSync(resolve(process.cwd(), "components/live/LiveHostDashboard.tsx"), "utf8");
const styles = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const liveSurfacePath = resolve(process.cwd(), "components/live/live-lanes/HostLiveLaneSurface.tsx");

test("host AI health enforces four unique rows and accessible recovery actions", () => {
  const action = () => {};
  const rows = validateHostAiHealthRows([
    { id: "source", label: "원문", state: "healthy", stateLabel: "정상" },
    { id: "translation", label: "번역", state: "degraded", stateLabel: "지연", actionLabel: "다시 시작", onAction: action },
    { id: "topic", label: "주제", state: "working", stateLabel: "진행" },
    { id: "recap", label: "요약", state: "unavailable", stateLabel: "대기" },
  ]);
  assert.equal(rows.length, 4);
  assert.throws(() => validateHostAiHealthRows([rows[0], rows[0], rows[2], rows[3]]));
  assert.throws(() => validateHostAiHealthRows([{ ...rows[0], actionLabel: "다시 시작" }, rows[1], rows[2], rows[3]]));
});

test("live host composes shared translation primitives with a bounded inspector", () => {
  const surface = readFileSync(liveSurfacePath, "utf8");
  assert.match(surface, /TranslationViewport/u);
  assert.match(surface, /CaptionEntry/u);
  assert.doesNotMatch(host, /<LanguageSelector/u);
  assert.match(surface, /TranslationToolbar/u);
  assert.match(surface, /className="live-host-translation-composition"/u);
  assert.match(surface, /className="live-host-inspector"/u);
  assert.match(styles, /\.live-host-translation-composition\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(280px, 360px\)/su);
  assert.match(styles, /\.live-host-translation-primary\s*\{[^}]*min-height:\s*60vh/su);
  assert.match(styles, /@media \(max-width: 1199px\)[\s\S]*\.live-host-translation-composition\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/su);
  assert.doesNotMatch(styles, /@media \(max-width: 1023px\)[\s\S]{0,300}\.live-host-translation-composition/u);
});

test("the 1024 host workspace stacks its inspector while 1440 keeps the bounded two-column layout", () => {
  const desktopWorkspace = Math.min(1120, 1440 - 220 - 64);
  const desktopPrimary = desktopWorkspace - 360 - 16;
  assert.ok(desktopPrimary / desktopWorkspace >= 0.6);
  assert.match(styles, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(280px, 360px\)/u);
  assert.match(styles, /@media \(max-width: 1199px\)[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/u);
});

test("host exposes four safe AI health rows without provider or participant-audio controls", () => {
  assert.match(host, /HostAiHealthDisclosure/u);
  for (const label of ["원문 자막", "번역", "주제 분류", "회의 요약"]) assert.match(host, new RegExp(label, "u"));
  assert.doesNotMatch(host, /Gemini fixed|translated audio|Speaker-aware translated audio/iu);
  assert.doesNotMatch(host, /<LanguageSelector/u);
  assert.match(host, /<MeetingMinutes/u);
});

test("attention-required AI health opens by default and announces one actionable state", () => {
  const disclosure = readFileSync(resolve(process.cwd(), "components/live/quality/HostAiHealthDisclosure.tsx"), "utf8");
  assert.match(disclosure, /open=\{requiresAttention \? true : undefined\}/u);
  assert.match(disclosure, /role="status"[^>]*aria-live="polite"/u);
  assert.match(disclosure, /degraded|unavailable/u);
});

test("host live presentation is extracted from the state controller", () => {
  const surface = readFileSync(liveSurfacePath, "utf8");
  assert.match(host, /<HostLiveLaneSurface/u);
  assert.match(surface, /TranslationViewport/u);
  assert.match(surface, /HostAiHealthDisclosure/u);
  assert.ok(surface.split("\n").length < 400);
});

test("live transport and recovery actions remain immediately visible", () => {
  const surface = readFileSync(liveSurfacePath, "utf8");
  assert.match(surface, /className="live-host-immediate-controls"/u);
  assert.match(surface, />\s*\{t\("자막 다시 연결"\)\}\s*</u);
  assert.match(surface, />\s*\{t\("자막 일시 정지"\)\}\s*</u);
  assert.match(surface, />\s*\{t\("자막 계속"\)\}\s*</u);
  assert.match(surface, />\s*\{t\("세션 종료…"\)\}\s*</u);
  assert.match(surface, />\s*\{t\("마이크 다시 연결"\)\}\s*</u);
  assert.match(surface, /<GatewayConnectionStatus state=\{props\.connectionState\}/u);
});

test("setup prioritizes schedule and language while advanced options stay disclosed", () => {
  const title = host.indexOf('id="live-session-title"');
  const date = host.indexOf('id="live-session-date"');
  const time = host.indexOf('id="live-session-start-time"');
  const language = host.indexOf('<LanguagePicker label={t("세션 언어")}');
  const preview = host.indexOf('className="live-host-preview"');
  const advanced = host.indexOf('className="live-setup-advanced"');
  assert.ok(title >= 0 && date > title && time > date && language > time && advanced > language);
  assert.ok(preview > title, "setup preview stays beside the primary fields");
  assert.match(host, /<summary>\{t\("고급 설정"\)\}<\/summary>/u);
  assert.match(host.slice(advanced, host.indexOf("</details>", advanced)), /스테이지 커버/u);
  assert.doesNotMatch(host, /live-qr-placeholder|Mobile access preview/u);
  assert.doesNotMatch(host, /description:\s*"/u);
  assert.doesNotMatch(host, /guest chooses to play it/u);
});

test("host preconfigures participant speaking before the live surface", () => {
  assert.match(host, /const \[participantSpeakingEnabled, setParticipantSpeakingEnabled\] = useState\(false\)/u);
  assert.match(host, /name="participantSpeakingEnabled"/u);
  assert.match(host, /aria-label=\{t\("참여자 발언"\)\}/u);
  assert.match(host, /participantSpeakingEnabled,\s*$/mu);
  const liveSurface = host.slice(host.indexOf('hostSurface === "live"'));
  assert.doesNotMatch(liveSurface, /발언권 설정|Q&A 초대|언어 설정/u);
});

test("host setup uses SEED shell, field, status, and list contracts", () => {
  assert.match(host, /data-seed-shell="live-host-setup"/u);
  assert.match(host, /data-seed-field="sessionTitle"/u);
  assert.match(host, /data-seed-field="schedule"/u);
  assert.match(host, /data-seed-status=\{error \? "error" : "idle"\}/u);
  assert.match(host, /data-seed-list="sessionPreview"/u);
  assert.match(host, /className=\{`live-setting-row/u);
  assert.match(styles, /\.live-host-preview/u);
  assert.match(styles, /\.live-setting-row/u);
  assert.match(styles, /\.live-wizard-footer\s*\{[^}]*position:\s*sticky/su);
});

test("host-only roster exposes consent identity as responsive rows", () => {
  assert.match(host, /resolveHostParticipantPresentation\(participant\)/u);
  assert.match(host, /presentation\.identity/u);
  assert.match(host, /presentation\.company/u);
  assert.match(host, /presentation\.department/u);
  assert.match(host, /presentation\.jobTitle/u);
  assert.match(host, /presentation\.hasSummaryConsent/u);
  assert.match(host, /className="live-participant-list"/u);
  assert.match(host, /<li key=\{participant\.participantId\}/u);
  assert.doesNotMatch(host, /<table className="live-participant-table"/u);
  assert.match(styles, /\.live-participant-list/u);
  assert.match(styles, /\.live-participant-row/u);
});

test("host translation styles keep semantic tokens, accessible targets, and reduced motion", () => {
  const start = styles.indexOf("/* Host translation-first composition */");
  const end = styles.indexOf("/* End host translation-first composition */", start);
  assert.ok(start >= 0 && end > start);
  const contract = styles.slice(start, end);
  assert.doesNotMatch(contract, /#[0-9a-f]{3,8}\b/iu);
  assert.doesNotMatch(contract, /gradient\(/iu);
  assert.match(contract, /min-height:\s*44px/u);
  assert.match(contract, /outline:\s*2px solid var\(--nova-system-default/u);
  assert.match(contract, /prefers-reduced-motion:\s*reduce/u);
});

test("host dashboard handles a 4410 takeover, offers wake lock and a microphone device picker", () => {
  // 4410 REPLACED: no auto-reconnect; recovery banner + manual restart.
  assert.match(host, /onReplaced/u);
  assert.match(host, /replaced-by-other-host/u);
  assert.match(host, /다른 기기에서 호스트로 접속/u);
  // Wake Lock keeps the screen on while broadcasting; visibility warns.
  assert.match(host, /wakeLock/u);
  assert.match(host, /visibilitychange/u);
  assert.match(host, /화면이 백그라운드/u);
  // Microphone device picker replaces the hardcoded default-only capture.
  assert.match(host, /enumerateDevices/u);
  assert.match(host, /audioDeviceId/u);
});

// 2026-08-22: PC layout pass — the invite surface packs its left column into
// live-invite-main so the QR column no longer stretches empty grid rows, the
// event-context panel stops leaking light-theme tokens onto the dark shell,
// and mid-width screens collapse two-column compositions before they cramp.
test("host dashboard keeps a PC-first invite layout without light-theme leaks", () => {
  assert.match(host, /className="live-invite-main"/u);
  assert.match(styles, /\.live-invite-main\s*\{[^}]*align-content:\s*start/su);
  assert.match(styles, /\.live-host-shell \.live-context-panel\s*\{[^}]*var\(--nova-/su);
  assert.match(styles, /@media \(max-width: 1180px\)/u);
  assert.doesNotMatch(styles, /\.live-session-panel \.live-admission-code\s*\{[^}]*grid-row:\s*2 \/ span 3/su);
});
