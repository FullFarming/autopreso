import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  buildHostInviteShareText,
  mergePolledHostSession,
  resolveHostParticipantPresentation,
  resolveHostSurface,
} from "./host-surface";
import type { LiveSession } from "@/lib/live-contract";

const source = readFileSync(resolve(process.cwd(), "components/live/LiveHostDashboard.tsx"), "utf8");
const liveSurface = readFileSync(resolve(process.cwd(), "components/live/quality/HostLiveSurface.tsx"), "utf8");
const styles = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

test("host surfaces are mutually exclusive", () => {
  assert.equal(resolveHostSurface({ hasSession: false, hasEndedSession: false, isEditingSession: false, sessionStatus: null }), "setup");
  assert.equal(resolveHostSurface({ hasSession: true, hasEndedSession: false, isEditingSession: false, sessionStatus: "preparing" }), "invite");
  assert.equal(resolveHostSurface({ hasSession: true, hasEndedSession: false, isEditingSession: false, sessionStatus: "live" }), "live");
  assert.equal(resolveHostSurface({ hasSession: true, hasEndedSession: false, isEditingSession: false, sessionStatus: "paused" }), "live");
  assert.equal(resolveHostSurface({ hasSession: true, hasEndedSession: false, isEditingSession: true, sessionStatus: "live" }), "setup");
  assert.equal(resolveHostSurface({ hasSession: false, hasEndedSession: true, isEditingSession: false, sessionStatus: null }), "ended");
});

test("reopening a saved session never captures audio or rotates an invitation", () => {
  const recovery = source.slice(source.indexOf("const recoverSession = useCallback"), source.indexOf("const openStageWindow = useCallback"));
  assert.doesNotMatch(recovery, /connectBroadcast|startBroadcast|action: "create"/u);
  assert.match(recovery, /action: "read-if-open"/u);
  assert.match(recovery, /setIsAutomaticStartEnabled\(false\)/u);
  assert.match(recovery, /existing\.admissionOpenUntil/u);
  assert.match(recovery, /saved\.id\}\/restore/u);
  assert.match(recovery, /shouldRenewExpiredAccess = false/u);
  assert.match(recovery, /isExpired && shouldRenewExpiredAccess !== true/u);
  assert.match(recovery, /buildAdmissionJoinUrl\(window\.location\.origin, inviteResult\.admissionCode\)/u);
  assert.doesNotMatch(recovery, /url: `\$\{window\.location\.origin\}\/watch`/u);
});

test("enlarged invitation is a presentation control outside the scaled workspace", () => {
  assert.match(source, /onClick=\{\(\) => setIsInviteQrOpen\(true\)\}/u);
  assert.match(source, /<\/WorkspaceViewport>\s*\{isInviteQrOpen && session && <InviteQrDialog/u);
  assert.match(source, /invitation=\{currentInvite\}/u);
  assert.match(source, /onClose=\{\(\) => setIsInviteQrOpen\(false\)\}/u);
});

test("polled host session keeps the newest version and server state", () => {
  const current: LiveSession = {
    id: "session-1",
    hostId: "host-1",
    title: "Current",
    scheduledAt: null,
    sessionType: "presentation",
    outputMode: "captions",
    voiceProvider: "gemini",
    maxViewers: 10,
    glossaryPack: "general_cre",
    status: "preparing",
    languages: ["en"],
    viewerCount: 0,
    version: 1,
    participantSpeakingEnabled: false,
    admissionOpenUntil: null,
    expiresAt: "2026-08-15T10:00:00.000Z",
  };
  const latest: LiveSession = {
    ...current,
    title: "Latest",
    sessionType: "meeting",
    maxViewers: 25,
    status: "live",
    languages: ["ko", "en"],
    viewerCount: 3,
    version: 4,
    admissionOpenUntil: "2026-08-15T09:30:00.000Z",
  };

  assert.deepEqual(mergePolledHostSession(current, latest), latest);
  assert.equal(mergePolledHostSession(null, latest), null);
  assert.equal(mergePolledHostSession({ ...current, id: "other" }, latest)?.id, "other");
});

test("invite share text carries both the link and access code in one share", () => {
  const shareText = buildHostInviteShareText({
    url: "https://portal.example.com/m/watch#invite=abc",
    admissionCode: "001234",
    expiresAtLabel: "10:30 AM",
  });

  assert.match(shareText, /https:\/\/portal\.example\.com\/m\/watch#invite=abc/u);
  assert.match(shareText, /인증 코드: 001234/u);
  assert.match(shareText, /초대 유효 시간: 10:30 AM/u);
});

test("legacy nullable participant identity and consent timestamp render safely", () => {
  const legacy = resolveHostParticipantPresentation({
    participantId: "participant-legacy",
    displayName: "Legacy guest",
    email: null,
    company: null,
    department: "",
    jobTitle: "",
    summaryConsentAt: null,
    joinedAt: "2026-08-15T00:00:00.000Z",
    lastSeenAt: "2026-08-15T00:01:00.000Z",
    isPresent: true,
    utteranceCount: 0,
    speakingSeconds: 0,
    lastSpokeAt: null,
  });
  assert.deepEqual(legacy, {
    identity: "Legacy guest",
    company: "—",
    department: "—",
    jobTitle: "—",
    hasSummaryConsent: false,
  });

  assert.equal(resolveHostParticipantPresentation({
    ...{
      participantId: "participant-email",
      displayName: "Email guest",
      email: "guest@example.com",
      company: "NOVA",
      department: "Advisory",
      jobTitle: "Director",
      joinedAt: "2026-08-15T00:00:00.000Z",
      lastSeenAt: "2026-08-15T00:01:00.000Z",
      isPresent: true,
      utteranceCount: 1,
      speakingSeconds: 1,
      lastSpokeAt: "2026-08-15T00:01:00.000Z",
    },
    summaryConsentAt: "2026-08-15T00:00:30.000Z",
  }).hasSummaryConsent, true);
});

test("dashboard connects the deterministic recovery decision once", () => {
  assert.match(source, /resolveHostSessionRecovery/u);
  assert.match(source, /recoveryDiscoveryPromiseRef/u);
  assert.match(source, /recoveryAttemptSessionIdRef/u);
  assert.match(source, /restoreSessionIdentity\(existing\)/u);
  assert.match(source, /recoveryRefreshKey/u);
});

test("leaving the page detaches audio while only explicit ending sends stop", () => {
  const cleanup = source.slice(source.indexOf('window.addEventListener("pagehide"') - 750, source.indexOf("const hostSurface ="));
  assert.match(cleanup, /client\.disconnect\(\)/u);
  assert.doesNotMatch(cleanup, /client\.stop\(\)|method: "DELETE"/u);
  assert.equal(source.match(/client\.stop\(\)/gu)?.length, 1);
  const ending = source.slice(source.indexOf("const stopSession"), source.indexOf("// StrictMode"));
  assert.match(ending, /client\.stop\(\)/u);
  assert.match(ending, /method: "DELETE"/u);
});

test("dashboard shares guest access as one invitation that includes the code", () => {
  assert.match(source, /buildHostInviteShareText/u);
  assert.match(source, /shareHostInvitation\(mode, buildHostInviteShareText/u);
  assert.match(source, /encodeURIComponent\(buildHostInviteShareText/u);
  assert.match(source, /초대 링크와 인증코드를 복사했습니다/u);
  assert.match(source, /inviteSharePendingRef\.current \|\| isBusy/u);
  assert.equal(source.match(/\{inviteActions\}/gu)?.length, 2);
});

test("stage handoff revalidates the invitation at click time", () => {
  const start = source.indexOf("const openStageWindow = useCallback");
  const end = source.indexOf("const stopSession", start);
  const stageAction = source.slice(start, end);
  assert.match(stageAction, /getCurrentHostInvite\(invite, session, admission, Date\.now\(\)\)/u);
  assert.match(stageAction, /encodeURIComponent\(stageInvite\.url\)/u);
  assert.match(stageAction, /encodeURIComponent\(stageInvite\.admissionCode\)/u);
  assert.doesNotMatch(stageAction, /encodeURIComponent\(invite\./u);
});

test("session setup fields expose stable browser and label identifiers", () => {
  for (const field of [
    { label: "세션 제목", id: "live-session-title", name: "sessionTitle" },
    { label: "날짜", id: "live-session-date", name: "sessionDate" },
    { label: "시작 시간", id: "live-session-start-time", name: "startTime" },
  ]) {
    assert.match(source, new RegExp(
      `<label[^>]*htmlFor="${field.id}"[^>]*>[\\s\\S]{0,120}<span>\\{t\\("${field.label}"\\)\\}</span>[\\s\\S]{0,180}<input[^>]*id="${field.id}"[^>]*name="${field.name}"`,
      "u",
    ));
  }
});

test("browser-blocked audio preserves the live session and exposes one accessible reconnect action", () => {
  assert.match(source, /instanceof LiveAudioRecoveryError/u);
  assert.match(source, /setAudioRecoveryStatus\(requestError\.status\)/u);
  assert.match(liveSurface, /className="accent-btn live-audio-recovery-action"/u);
  assert.match(liveSurface, /aria-live="polite"[\s\S]*마이크 다시 연결/u);
  assert.equal(liveSurface.match(/>\s*\{t\("마이크 다시 연결"\)\}\s*<\/button>/gu)?.length, 1);
});

test("dashboard routes each presentation group through the resolved host surface", () => {
  assert.match(source, /data-host-surface=\{hostSurface\}/u);
  assert.match(source, /hostSurface === "setup" &&[\s\S]*data-host-surface-panel="setup"/u);
  assert.match(source, /hostSurface === "invite"[\s\S]*data-host-surface-panel="invite"/u);
  assert.match(source, /hostSurface === "live" &&[\s\S]*<HostLiveLaneSurface/u);
  assert.match(liveSurface, /data-host-surface-panel="live"/u);
  assert.match(source, /hostSurface === "ended" &&[\s\S]*data-host-surface-panel="ended"/u);
  assert.doesNotMatch(source, /\{isConfiguring &&/u);
});

test("each host surface exposes a primary action slot", () => {
  for (const surface of ["setup", "invite", "live", "ended"]) {
    assert.match(surface === "live" ? liveSurface : source, new RegExp(`data-host-primary="${surface}"`, "u"));
  }
});

test("every host rail action keeps the 44px minimum target at all breakpoints", () => {
  const railActionRules = [...styles.matchAll(/\.live-host-rail button,\s*\.live-host-rail a\s*\{[^}]*min-height:\s*(\d+)px/gu)];
  assert.ok(railActionRules.length >= 2, "base and compact rail rules must both declare a target height");
  for (const rule of railActionRules) assert.ok(Number(rule[1]) >= 44, rule[0]);
});

test("host surface styles use tokens and honor focus and reduced motion", () => {
  const start = styles.indexOf("/* Host surface state contract */");
  const end = styles.indexOf("/* End host surface state contract */", start);
  assert.ok(start >= 0 && end > start);
  const contractStyles = styles.slice(start, end);
  assert.doesNotMatch(contractStyles, /#[0-9a-f]{3,8}\b/iu);
  assert.match(contractStyles, /var\(--/u);
  assert.match(contractStyles, /:focus-visible/u);
  assert.match(contractStyles, /prefers-reduced-motion: reduce/u);
  assert.match(contractStyles, /\.live-audio-recovery-action/u);
  assert.match(contractStyles, /min-height:\s*44px/u);
});
