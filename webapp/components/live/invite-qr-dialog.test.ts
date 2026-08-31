import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import type { HostInvitation } from "./invite-share";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./InviteQrDialog.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded: { exports: Record<string, unknown> } = { exports: {} };
new Function("require", "module", "exports", compiled)((name: string) => {
  if (name.endsWith(".module.css")) return { default: {} };
  if (name.includes("SystemLanguageProvider")) return {};
  if (name.includes("invite-messages")) return {};
  if (name === "@/lib/system-language") return {};
  return require(name);
}, loaded, loaded.exports);
const getValidQrInvitation = loaded.exports.getValidQrInvitation as (invitation: HostInvitation | null, now: number) => HostInvitation | null;
const options = loaded.exports.INVITE_QR_OPTIONS as { width: number; margin: number; errorCorrectionLevel: "M"; color: { dark: string; light: string } };
const now = Date.parse("2026-08-31T13:00:00+09:00");
const invitation: HostInvitation = { sessionId: "session-one", url: "https://example.com/watch?invite=public-admission-token", admissionCode: "123456", expiresAt: "2026-08-31T14:00:00+09:00" };

test("QR display rejects absent, expired, malformed and unsafe invitations", () => {
  assert.equal(getValidQrInvitation(invitation, now), invitation);
  assert.equal(getValidQrInvitation(null, now), null);
  for (const invalid of [
    { ...invitation, expiresAt: "invalid" }, { ...invitation, expiresAt: new Date(now).toISOString() },
    { ...invitation, admissionCode: "12345" }, { ...invitation, admissionCode: "<1234>" },
    { ...invitation, url: "javascript:alert(1)" }, { ...invitation, url: "https://user:secret@example.com/watch" },
  ]) assert.equal(getValidQrInvitation(invalid, now), null);
});

test("QR is generated locally at 1024px with a four-module quiet zone and black-white contrast", async () => {
  assert.deepEqual(options, { width: 1024, margin: 4, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
  const qrcode = require("qrcode") as { toDataURL: (value: string, config: typeof options) => Promise<string> };
  const dataUrl = await qrcode.toDataURL(invitation.url, options);
  assert.match(dataUrl, /^data:image\/png;base64,/u);
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.doesNotMatch(source, /\bfetch\s*\(|getUserMedia|new WebSocket|localStorage|sessionStorage/u);
});

test("the dialog keeps native focus containment, opt-in fullscreen and stale QR guards", () => {
  assert.match(source, /\.showModal\(\)/u);
  assert.match(source, /onCancel=/u);
  assert.match(source, /previousFocus\.focus\(\)/u);
  assert.match(source, /requestFullscreen\(\)/u);
  assert.match(source, /qr\.key === invitationKey/u);
  assert.match(source, /clearTimeout/u);
  assert.match(source, /fullscreenchange/u);
  const css = readFileSync(new URL("./InviteQrDialog.module.css", import.meta.url), "utf8");
  assert.match(css, /safe-area-inset/u);
  assert.match(css, /min-height: 44px/u);
  assert.match(css, /outline: 2px solid var\(--nova-web-action\)/u);
});
