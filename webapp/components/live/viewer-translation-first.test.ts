import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contrastRatio, createCssColorResolver, readCssDeclaration } from "./css-contrast-test-helper";
import test from "node:test";

const viewer = readFileSync(resolve(process.cwd(), "components/live/LiveViewer.tsx"), "utf8");
const viewerContract = readFileSync(resolve(process.cwd(), "components/live/viewer-controller-contract.ts"), "utf8");
const participantButton = readFileSync(resolve(process.cwd(), "components/live/ParticipantSpeakButton.tsx"), "utf8");
const styles = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const consent = readFileSync(resolve(process.cwd(), "components/live/consent/ParticipantConsentFields.tsx"), "utf8");
const consentCopy = readFileSync(resolve(process.cwd(), "components/live/consent/consent-notice-presentation.ts"), "utf8");
const consentStyles = readFileSync(resolve(process.cwd(), "components/live/consent/participant-consent-fields.module.css"), "utf8");

test("participant live surface composes the shared translation-first components", () => {
  for (const component of ["TranslationViewport", "CaptionEntry", "TranslationToolbar", "ControlDrawer"]) {
    assert.match(viewer, new RegExp(`<${component}\\b`, "u"));
  }
  assert.doesNotMatch(viewer, /<LanguageSelector\b/u);
  assert.match(viewer, /finalAnnouncement=/u);
  assert.match(viewer, /data-viewer-surface="caption-first"/u);
  assert.match(viewer, /data-compact=\{compact \|\| undefined\}/u);
  assert.match(viewer, /className="live-viewer-translation-layout viewer-notebook"/u);
  assert.match(styles, /\.live-viewer-translation-layout\s*\{[^}]*grid-template-rows:\s*auto minmax\(70vh,\s*1fr\)/u);
  assert.match(styles, /\.live-viewer-shell\.is-compact\s+\.live-viewer-translation-layout\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/u);
});

test("participant viewer opts every lane into caption-first preview with explicit compact density", () => {
  const topicLane = readFileSync(resolve(process.cwd(), "components/live/quality/ViewerTopicLane.tsx"), "utf8");

  assert.match(topicLane, /const previewCaption = captions\.at\(-1\)/u);
  assert.match(topicLane, /captionFirstPreview=\{previewCaption\?\.text \?\? ""\}/u);
  assert.match(topicLane, /previewLabel=\{`\$\{lane\.label\} 현재 자막`\}/u);
  assert.match(topicLane, /density="compact"/u);
  assert.match(topicLane, /listLabel=\{`\$\{lane\.label\} 자막 목록`\}/u);
});

test("participant speaking floor is capability-gated and keeps translated audio absent", () => {
  assert.match(viewer, /participantSpeakingEnabled/u);
  assert.match(viewer, /prepareSpeakCapture/u);
  assert.match(viewer, /speak-start/u);
  assert.match(viewer, /speak-end/u);
  assert.match(viewer, /live-speak-sheet/u);
  assert.match(viewer, /<ParticipantSpeakButton/u);
  assert.match(participantButton, /live-speak-trigger/u);
  assert.match(viewer, /<canvas/u);
  assert.match(viewer, /@phosphor-icons\/react/u);
  assert.doesNotMatch(viewer, /audio-control|enqueueInterpretationAudio|Translated audio/u);
});

test("speaking sheet shows registered identity, exposes one stop action, and has no live settings", () => {
  const sheetStart = viewer.indexOf('className="live-speak-sheet"');
  const sheetEnd = viewer.indexOf('</section>', sheetStart);
  assert.ok(sheetStart >= 0 && sheetEnd > sheetStart);
  const sheet = viewer.slice(sheetStart, sheetEnd);
  assert.match(sheet, /viewer\.self/u);
  assert.match(sheet, /발언 종료/u);
  assert.doesNotMatch(sheet, /재생|일시 정지|시간 이동|녹음|발언권 설정|Q&A 초대|언어 설정/u);
  assert.match(viewer, /aria-modal="true"/u);
  assert.match(participantButton, /aria-pressed=\{state !== "idle"\}/u);
});

test("join requires email and name while keeping company profile optional", () => {
  for (const field of ["email", "display-name", "company", "department", "job-title"]) {
    assert.match(viewer, new RegExp(`id="live-${field}"[^>]*name="`, "u"));
  }
  assert.match(viewer, /id="live-email"[^>]*type="email"[^>]*autoComplete="email"/u);
  assert.match(viewer, /id="live-display-name"[^>]*autoComplete="name"/u);
  assert.match(viewer, /<details className="live-join-optional-profile"/u);
  assert.match(consent, /name="privacyConsent"[^>]*type="checkbox"[^>]*required/u);
  assert.match(consent, /name="summaryDeliveryConsent"[^>]*type="checkbox"/u);
  assert.match(viewer, /const \[summaryDeliveryConsent, setSummaryDeliveryConsent\] = useState\(false\)/u);
  assert.match(viewerContract, /self:\s*LiveAttendeeSelfProfile/u);
  assert.match(viewer, /setEmail\(result\.self\.email\)/u);
  assert.match(viewer, /setDisplayName\(result\.self\.displayName\)/u);
});

test("QR omits code while direct join requires a stable six-digit access code", () => {
  assert.match(viewer, /!isInviteJoin\s*&&\s*\(/u);
  assert.match(viewer, /id="live-access-code"[^>]*name="accessCode"[^>]*pattern="\[0-9\]\{6\}"/u);
  assert.match(viewer, /accessCode:\s*normalizedAdmissionCode/u);
  assert.doesNotMatch(viewer, /admissionCode:/u);
});

test("join alert, consent, language, and drawer controls retain accessible targets", () => {
  const translationStyles = styles.slice(styles.indexOf("/* Participant translation-first composition."));
  assert.match(viewer, /role="alert"/u);
  assert.match(consentStyles, /min-height:\s*44px/u);
  assert.match(styles, /\.live-viewer-shell[^}]*:focus-visible[^}]*outline:\s*2px solid var\(--nova-system-default/u);
  assert.doesNotMatch(translationStyles, /#[0-9a-f]{3,8}/iu);
  assert.doesNotMatch(translationStyles, /gradient\(/iu);
});

test("participant status metadata keeps WCAG AA contrast on every viewport", () => {
  assert.match(styles, /\.live-viewer-stage \.live-eyebrow,\s*\.live-viewer-stage \.live-connection-state\s*\{\s*color:\s*var\(--nova-fg-secondary,\s*var\(--on-dark-soft\)\)/u);
  assert.match(styles, /\.live-viewer-shell\.is-compact \.live-viewer-stage \.live-eyebrow,\s*\.live-viewer-shell\.is-compact \.live-viewer-stage \.live-connection-state\s*\{\s*color:\s*var\(--nova-fg-secondary,\s*var\(--on-dark-soft\)\)/u);
  assert.match(styles, /\.live-join-credit\s*\{[^}]*color:\s*var\(--nova-fg-secondary,\s*var\(--on-dark-soft\)\)/u);
  const resolveColor = createCssColorResolver(styles, [".live-viewer-shell"]);
  const foreground = resolveColor(readCssDeclaration(styles, ".live-viewer-stage .live-connection-state", "color"));
  const background = resolveColor("var(--dark)");
  assert.ok(contrastRatio(foreground, background) >= 4.5);
});

test("join validation consent and admission errors use approved Korean copy", () => {
  for (const copy of [
    "올바른 이메일 주소를 입력해 주세요.",
    "회사명은 100자 이하로 입력해 주세요.",
    "부서는 80자 이하로 입력해 주세요.",
    "직급은 100자 이하로 입력해 주세요.",
    "호스트가 공유한 6자리 인증코드를 입력해 주세요.",
    "회의 요약 이메일 수신",
    "참여 인원이 가득 찼습니다.",
    "참여가 마감되었거나 QR 초대가 만료되었습니다.",
  ]) assert.match(`${viewer}\n${viewerContract}\n${consent}\n${consentCopy}`, new RegExp(copy, "u"));
});

test("nova typography and caption tokens are defined once and speak controls move like iOS", () => {
  // 5A: the t-scale referenced 36+ times across CSS modules must be DEFINED -
  // undefined custom properties silently invalidate their declarations.
  for (const token of [
    "--nova-font-size-t1:", "--nova-line-height-t1:", "--nova-font-size-t3:", "--nova-line-height-t3:",
    "--nova-font-size-t4:", "--nova-font-size-t5:", "--nova-font-size-t6:",
    "--nova-font-size-t7:", "--nova-font-size-st13:",
    "--nova-line-height-t4:", "--nova-line-height-t5:", "--nova-line-height-t6:",
    "--nova-line-height-t7:", "--nova-line-height-st13:",
    "--nova-caption-size:", "--nova-caption-size-compact:",
    "--nova-scrim:", "--nova-status-live:", "--nova-status-warn:",
    "--nova-hover:", "--nova-press:", "--nova-radius-xs:", "--nova-system-subtle:",
    "--nova-spring-rapid:",
  ]) {
    assert.ok(styles.includes(token), `${token} must be defined in globals.css`);
  }

  // 5A: the semantic alias block is defined once for all four dark surfaces,
  // not copy-pasted per shell.
  assert.match(styles, /\.live-records-route,\s*\n?\.live-host-shell,\s*\n?\.live-host-translation-surface,\s*\n?\.live-viewer-shell \{/u);

  // T-F: presses release with an iOS-like spring overshoot; the mic icon pops
  // on activation and the record control morphs in.
  assert.match(styles, /--nova-ease-back:\s*cubic-bezier\(0\.34,\s*1\.56,\s*0\.64,\s*1\)/u);
  assert.match(styles, /nova-icon-pop/u);
  assert.match(styles, /nova-record-in/u);
});

test("participant fixed language tabs cannot be overridden by source or bilingual display settings", () => {
  const feed = readFileSync(resolve(process.cwd(), "components/live/ViewerReadingFeed.tsx"), "utf8");
  assert.doesNotMatch(viewer, /transcriptMode|TRANSCRIPT_MODE_LABELS|live-mode-chip|자막 표시 모드/u);
  assert.doesNotMatch(feed, /caption.displayMode|caption.sourceText/u);
  assert.match(feed, /lang=\{caption.language \?\? language\}/u);
  assert.match(viewer, /buildTranslationLanes\(null, languages\)/u);
  assert.match(viewer, /resolveViewerSpeakerColor/u);
});

test("viewer speaker name palette keeps WCAG AA contrast on the dark caption surface", () => {
  const speakerModule = readFileSync(resolve(process.cwd(), "components/live/SpeakerCaption.tsx"), "utf8");
  const palette = speakerModule.match(/VIEWER_SPEAKER_COLORS = \[([^\]]+)\]/u)?.[1] ?? "";
  const colors = palette.match(/#[0-9a-fA-F]{6}/gu) ?? [];
  assert.ok(colors.length >= 6, "viewer palette must exist with at least 6 colors");
  const resolveColor = createCssColorResolver(styles, [".live-viewer-shell"]);
  const background = resolveColor("var(--nova-surface-raised)");
  for (const color of colors) {
    assert.ok(contrastRatio(resolveColor(color), background) >= 4.5, `${color} must pass 4.5:1 on the layered surface`);
  }
});


test("participant notebook keeps live reading continuous and microphone permission independent of Q&A text", () => {
  const feed = readFileSync(resolve(process.cwd(), "components/live/ViewerReadingFeed.tsx"), "utf8");
  const policy = viewer.match(/const canUseSpeakingFloor =[^;]+;/u)?.[0] ?? "";
  assert.match(policy, /participantSpeakingEnabled === true/u);
  assert.match(policy, /!isSessionEnded && sessionStatus === "live"/u);
  assert.doesNotMatch(policy, /activeSection|qa/u);
  const capsule = viewer.slice(viewer.indexOf('className="viewer-microphone-slot"'));
  assert.match(capsule, /canUseSpeakingFloor && <ParticipantSpeakButton/u);
  const speakButton = readFileSync(resolve(process.cwd(), "components/live/ParticipantSpeakButton.tsx"), "utf8");
  assert.match(speakButton, /aria-label=/u);
  assert.match(speakButton, /CircleNotch, Record, Stop/u);
  assert.match(capsule, /state=\{speakState\}/u);
  assert.doesNotMatch(capsule, /발언하기|최신 자막을 보고 있어요|요약받기/u);
  assert.match(feed, /data-caption-state=/u);
  assert.match(feed, /caption.isFinal \? "final" : "partial"/u);
  assert.doesNotMatch(feed, /Avatar|CompletedTopicAccordion|CurrentTopicPanel/u);
  assert.match(styles, /\.viewer-notebook \.viewer-microphone-capsule,\s*\.viewer-notebook \.viewer-recap-cta[^}]*width: 100%/u);
  assert.match(styles, /\.viewer-notebook \.viewer-microphone-capsule[^}]*border-radius: var\(--nova-radius-pill\)/u);
});


test("notebook defines heading tokens and content inset instead of inheriting ordinary UI size", () => {
  assert.match(styles, /\.live-viewer-shell \.viewer-notebook[^}]*padding: 24px/u);
  assert.match(styles, /--nova-font-size-t1: 30px; --nova-line-height-t1: 40px/u);
  assert.match(styles, /--nova-font-size-t3: 22px; --nova-line-height-t3: 31px/u);
  const minutes = readFileSync(resolve(process.cwd(), "components/live/ParticipantMeetingMinutes.tsx"), "utf8");
  assert.match(minutes, /summary.chapters.map[^;]*<details className="viewer-topic-summary"/u);
  assert.match(minutes, /전체 발언 원문 보기/u);
  assert.match(minutes, /종료 시각 미확인/u);
});


test("live notebook has one caption scroller and ended notebook returns to document scrolling", () => {
  assert.match(viewer, /data-reading-state=\{isSessionEnded \? "ended" : "live"\}/u);
  assert.match(styles, /data-reading-state="live"[^}]*\[role="tabpanel"\][^}]*overflow: hidden/u);
  assert.match(styles, /data-reading-state="live"[^}]*\.viewer-reading-scroll[^}]*overflow-y: auto/u);
  assert.match(styles, /data-reading-state="ended"\] \{[^}]*position: relative;[^}]*height: auto;[^}]*overflow: visible/u);
});

test("live headers stay fixed: the shell is viewport-locked and only the caption feed scrolls", () => {
  // The NOVA toolbar and the meeting heading must never scroll away while
  // captions accumulate — the shell pins to 100dvh, every non-caption row
  // keeps its size, and scrolling is delegated to .viewer-reading-scroll.
  assert.match(styles, /\.live-viewer-shell\[data-reading-state="live"\] \{[^}]*height: 100dvh;[^}]*overflow: hidden/u);
  assert.match(styles, /data-reading-state="live"[^}]*\.viewer-notebook \{[^}]*height: 100%;[^}]*overflow: hidden/u);
  assert.match(styles, /data-reading-state="live"[^}]*\.viewer-notebook > :not\(\.live-viewer-caption-region\) \{[^}]*flex-shrink: 0/u);
  assert.match(styles, /data-reading-state="live"[^}]*\.live-viewer-caption-region \{[^}]*flex: 1 1 0;[^}]*min-height: 0/u);
  assert.match(styles, /data-reading-state="live"[^}]*\.viewer-reading-scroll \{[^}]*max-height: none/u);
});


test("unchanged caption props isolate the reading feed from speaker meter parent renders", () => {
  const feed = readFileSync(resolve(process.cwd(), "components/live/ViewerReadingFeed.tsx"), "utf8");
  assert.match(feed, /export const ViewerReadingFeed = memo\(function ViewerReadingFeed/u);
  assert.match(viewer, /const selectedLaneInputs = useMemo<CaptionLaneInput\[\]>\(/u);
  assert.match(viewer, /\[captionsByLanguage, selectedLane\]/u);
  assert.match(viewer, /\[selectedLaneInputs, selectedLane\]/u);
  const presentation = viewer.slice(viewer.indexOf("const selectedLaneInputs"), viewer.indexOf("const selectTranslationLane"));
  assert.doesNotMatch(presentation, /speakLevel|setTimeout|setInterval/u);
  assert.match(feed, /data-caption-state=\{failed \? "failed" : caption.isFinal \? "final" : "partial"\}/u);
});

test("target cache writes invalidate presentation while original uses its independent canonical ledger", () => {
  const writes = [...viewer.matchAll(/captionsByLanguageRef\.current\s*=/gu)];
  assert.equal(writes.length, 1, "cache writes must pass through the React state synchronization boundary");
  assert.match(viewer, /const replaceCaptionCache = useCallback\([^;]+captionsByLanguageRef\.current = nextCache;\s*setCaptionsByLanguage\(nextCache\)/u);
  assert.equal([...viewer.matchAll(/replaceCaptionCache\(nextCache\)/gu)].length, 2, "both snapshots and websocket events publish their cache");
  assert.match(viewer, /captionCacheSessionIdRef\.current = currentViewer\.session\.id;\s*replaceCaptionCache\(\{\}\)/u);
  const presentation = viewer.slice(viewer.indexOf("const selectedLaneInputs"), viewer.indexOf("const selectedLaneCaptions"));
  assert.match(presentation, /captionsByLanguage\[selectedLane.language\]/u);
  assert.doesNotMatch(presentation, /captionsByLanguageRef/u);
  assert.doesNotMatch(viewer, /Object\.values\(captionsByLanguage\)\.flat\(\)/u);
  assert.match(viewer, /sourceLedger.map\(presentViewerSourceEvent\)/u);
  assert.match(viewer, /loadViewerSourceSnapshot/u);
});
