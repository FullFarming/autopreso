import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentHostInvite, getCurrentStageInvite, hasOpenStageAdmission, shareHostInvitation } from "./invite-share";

const now = Date.parse("2026-08-31T00:00:00Z");
const expiresAt = "2026-08-31T01:00:00Z";
const invite = { sessionId: "s1", url: "https://nova.test/m/watch#invite=opaque", admissionCode: "001234", expiresAt };
const session = { id: "s1", status: "live", admissionOpenUntil: expiresAt };
const admission = { code: "001234", openUntil: expiresAt };

test("stage rejects closed, expired or rotated invitations and accepts equivalent timestamp formats", () => {
  assert.equal(hasOpenStageAdmission(session, now), true);
  assert.equal(hasOpenStageAdmission({ ...session, admissionOpenUntil: null }, now), false);
  assert.equal(hasOpenStageAdmission(session, Date.parse(expiresAt)), false);
  assert.equal(getCurrentStageInvite(invite, session, now), invite);
  assert.equal(getCurrentStageInvite(invite, { ...session, admissionOpenUntil: null }, now), null);
  assert.equal(getCurrentStageInvite(invite, { ...session, admissionOpenUntil: "2026-08-31T02:00:00Z" }, now), null);
  assert.equal(getCurrentStageInvite(invite, { ...session, admissionOpenUntil: "2026-08-31T10:00:00+09:00" }, now), invite);
  assert.equal(getCurrentHostInvite(invite, session, { ...admission, openUntil: "2026-08-31T01:00:00.000+00:00" }, now), invite);
});

test("only the current active invitation is shareable without regenerating its token", () => {
  assert.equal(getCurrentHostInvite(invite, session, admission, now), invite);
  for (const invalidSession of [null, { ...session, id: "other" }, { ...session, status: "stopped" },
    { ...session, status: "failed" }, { ...session, admissionOpenUntil: null },
    { ...session, admissionOpenUntil: "2026-08-31T02:00:00Z" }]) {
    assert.equal(getCurrentHostInvite(invite, invalidSession, admission, now), null);
  }
  for (const invalidInvite of [null, { ...invite, admissionCode: "12345" }, { ...invite, expiresAt: "invalid" }]) {
    assert.equal(getCurrentHostInvite(invalidInvite, session, admission, now), null);
  }
  assert.equal(getCurrentHostInvite(invite, session, { ...admission, code: "654321" }, now), null);
  assert.equal(getCurrentHostInvite(invite, session, null, now), null);
  assert.equal(getCurrentHostInvite(invite, session, admission, Date.parse(expiresAt)), null);
});

test("native share, explicit copy and unsupported share preserve the entire invitation", async () => {
  const text = "라이브 초대\nhttps://nova.test/m/watch#invite=opaque\n인증 코드: 001234\n유효 시간: 오전 10시";
  const shared: ShareData[] = [];
  const copied: string[] = [];
  const browser = { share: async (data: ShareData) => { shared.push(data); }, clipboard: { writeText: async (value: string) => { copied.push(value); } } };
  assert.equal(await shareHostInvitation("share", text, browser), "shared");
  assert.equal(shared[0]?.text, text);
  assert.equal(copied.length, 0);
  assert.equal(await shareHostInvitation("copy", text, browser), "copied");
  assert.equal(await shareHostInvitation("share", text, { clipboard: browser.clipboard }), "copied-unsupported");
  assert.equal(await shareHostInvitation("share", text, { ...browser, canShare: () => false }), "copied-unsupported");
  assert.deepEqual(copied, [text, text, text]);
  assert.equal(shared.length, 1);
});

test("cancelled or rejected native shares never copy or report success", async () => {
  let copies = 0;
  const clipboard = { writeText: async () => { copies += 1; } };
  assert.equal(await shareHostInvitation("share", "invitation", { clipboard, share: async () => { throw new DOMException("Cancelled", "AbortError"); } }), "cancelled");
  await assert.rejects(shareHostInvitation("share", "invitation", { clipboard, share: async () => { throw new Error("rejected"); } }), /rejected/u);
  await assert.rejects(shareHostInvitation("copy", "invitation", {}), /복사/u);
  assert.equal(copies, 0);
});
