import assert from "node:assert/strict";
import test from "node:test";

import { joinLiveSessionInputSchema } from "./live-input-validation";
import { LiveAdmissionError } from "./live-admission-store";
import { enforceLiveConsentRateLimit, type RateLimitStore } from "./live-rate-limit";
import {
  CONSENT_NOTICE_VERSION_MAX_CODEPOINTS,
  createOptionalConsentAuditTransitions,
  joinConsentInputSchema,
  normalizeConsentNoticeVersion,
  participantConsentUpdateInputSchema,
} from "./live-consent-validation";

test("join consent requires privacy and keeps optional purposes independent", () => {
  const input = {
    privacyConsent: true,
    summaryConsent: false,
    marketingConsent: true,
    consentNoticeVersions: {
      privacy: "privacy-2026-08-15",
      summaryDelivery: "summary-2026-08-15",
      marketing: "marketing-2026-08-15",
    },
  };

  assert.deepEqual(joinConsentInputSchema.parse(input), input);
  assert.equal(joinConsentInputSchema.safeParse({ ...input, privacyConsent: false }).success, false);
  assert.equal(joinConsentInputSchema.safeParse({ ...input, privacyConsent: undefined }).success, false);
  assert.equal(joinConsentInputSchema.safeParse({ ...input, summaryConsent: "false" }).success, false);
  assert.equal(joinConsentInputSchema.safeParse({ ...input, marketingConsent: 1 }).success, false);
  assert.equal(joinConsentInputSchema.safeParse({ ...input, participantId: crypto.randomUUID() }).success, false);
});

test("Live join composes the required privacy and optional consent contract", () => {
  const input = {
    accessCode: "123456",
    email: "viewer@example.com",
    displayName: "Viewer",
    company: "",
    department: "",
    jobTitle: "",
    deviceId: "device-identifier-12345",
    accessToken: "a".repeat(20),
    privacyConsent: true,
    summaryConsent: false,
    marketingConsent: false,
    consentNoticeVersions: {
      privacy: "privacy-v1",
      summaryDelivery: "summary-v1",
      marketing: "marketing-v1",
    },
  };
  assert.equal(joinLiveSessionInputSchema.safeParse(input).success, true);
  assert.equal(joinLiveSessionInputSchema.safeParse({ ...input, privacyConsent: false }).success, false);
  assert.equal(joinLiveSessionInputSchema.safeParse({ ...input, marketingConsent: undefined }).success, false);
  assert.equal(joinLiveSessionInputSchema.safeParse({
    ...input,
    consentNoticeVersions: { ...input.consentNoticeVersions, marketing: "<script>" },
  }).success, false);
});

test("notice versions match the canonical ASCII identifier boundary", () => {
  assert.equal(normalizeConsentNoticeVersion("  Privacy-2026.08  "), "Privacy-2026.08");
  assert.equal(
    normalizeConsentNoticeVersion("a".repeat(CONSENT_NOTICE_VERSION_MAX_CODEPOINTS)),
    "a".repeat(CONSENT_NOTICE_VERSION_MAX_CODEPOINTS),
  );

  for (const value of [
    "",
    " ",
    "a".repeat(CONSENT_NOTICE_VERSION_MAX_CODEPOINTS + 1),
    "notice version",
    "notice<script>",
    "notice\nversion",
    "notice\u200Bversion",
    "notice\u202Eversion",
    "notice🎉",
    "NOE\u0308L-2026.08",
    "개인정보-2026-08",
    ".privacy-v1",
  ]) {
    assert.throws(() => normalizeConsentNoticeVersion(value), value);
  }
});

test("optional consent update is strict and cannot withdraw required privacy", () => {
  const update = {
    summaryConsent: false,
    marketingConsent: true,
    consentNoticeVersions: {
      summaryDelivery: "summary-2026-08-15",
      marketing: "marketing-2026-08-15",
    },
  };
  assert.deepEqual(participantConsentUpdateInputSchema.parse(update), update);

  for (const hostile of [
    { ...update, privacyConsent: false },
    { ...update, sessionId: crypto.randomUUID() },
    { ...update, participantId: crypto.randomUUID() },
    { ...update, summaryConsent: null },
    { ...update, consentNoticeVersions: { ...update.consentNoticeVersions, privacy: "privacy-v1" } },
  ]) assert.equal(participantConsentUpdateInputSchema.safeParse(hostile).success, false);
});

test("optional consent transitions audit grants and withdrawals but ignore reconnects", () => {
  const current = {
    summaryDelivery: { accepted: true, noticeVersion: "summary-v1" },
    marketing: { accepted: false, noticeVersion: "marketing-v1" },
  };
  const next = participantConsentUpdateInputSchema.parse({
    summaryConsent: false,
    marketingConsent: true,
    consentNoticeVersions: {
      summaryDelivery: "summary-v2",
      marketing: "marketing-v2",
    },
  });

  assert.deepEqual(createOptionalConsentAuditTransitions(current, next), [
    { purpose: "summaryDelivery", accepted: false, noticeVersion: "summary-v2", transition: "withdrawn" },
    { purpose: "marketing", accepted: true, noticeVersion: "marketing-v2", transition: "granted" },
  ]);
  assert.deepEqual(createOptionalConsentAuditTransitions({
    summaryDelivery: { accepted: false, noticeVersion: "summary-v2" },
    marketing: { accepted: true, noticeVersion: "marketing-v2" },
  }, next), []);
});

test("consent mutations use one opaque participant and session rate-limit bucket", async () => {
  const calls: Parameters<RateLimitStore["consumeRateLimit"]>[0][] = [];
  let isAllowed = true;
  const store: RateLimitStore = {
    async consumeRateLimit(input) {
      calls.push(input);
      return isAllowed;
    },
  };
  const userId = "11111111-1111-7111-8111-111111111111";
  const sessionId = "22222222-2222-4222-8222-222222222222";

  await enforceLiveConsentRateLimit(userId, sessionId, store);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, "live-consent-participant-session");
  assert.equal(calls[0].limit, 20);
  assert.equal(calls[0].windowSeconds, 60 * 60);
  assert.match(calls[0].keyHash, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(calls[0]).includes(userId), false);
  assert.equal(JSON.stringify(calls[0]).includes(sessionId), false);

  isAllowed = false;
  await assert.rejects(
    () => enforceLiveConsentRateLimit(userId, sessionId, store),
    (error: unknown) => error instanceof LiveAdmissionError
      && error.code === "CONSENT_RATE_LIMITED"
      && error.status === 429
      && error.message === "동의 변경 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  );
  await assert.rejects(
    () => enforceLiveConsentRateLimit("private@example.com", sessionId, store),
    (error: unknown) => error instanceof LiveAdmissionError && error.code === "INVALID_RATE_LIMIT_KEY",
  );
});
