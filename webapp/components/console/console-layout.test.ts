import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { isHostSessionPage } from "../auth/host-session-pages";
import { CONSOLE_ERROR_MESSAGE_KEYS, consoleMessages } from "../../lib/system-language/console-messages";
import { hostMessages } from "../../lib/system-language/host-messages";
import { ConsoleRequestError, consoleErrorKey, consoleFetch } from "./console-client";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const shell = read("components/console/ConsoleShell.tsx");
const users = read("components/console/UsersPanel.tsx");
const sessions = read("components/console/SessionsPanel.tsx");
const engine = read("components/console/EnginePanel.tsx");
const dialog = read("components/console/ConfirmDialog.tsx");
const client = read("components/console/console-client.ts");
const layout = read("app/console/layout.tsx");
const index = read("app/console/page.tsx");
const dashboard = read("components/live/LiveHostDashboard.tsx");
const css = read("app/globals.css");
const panels = { shell, users, sessions, engine, dialog };

test("the server layout guards with the cookie-value admin check and redirects by error class", () => {
  assert.doesNotMatch(layout, /"use client"/u);
  assert.match(layout, /requireAdminFromCookieValue\(\(await cookies\(\)\)\.get\(SESSION_COOKIE\)\?\.value\)/u);
  assert.match(layout, /instanceof AuthorizationError\) redirect\("\/admin"\)/u);
  assert.match(layout, /instanceof AuthenticationError\) redirect\("\/login"\)/u);
  assert.match(layout, /export const dynamic = "force-dynamic"/u);
  assert.match(layout, /<ConsoleShell/u);
  assert.match(index, /redirect\("\/console\/users"\)/u);
  for (const page of ["users", "sessions", "engine"]) {
    assert.match(read(`app/console/${page}/page.tsx`), new RegExp(`<${page[0].toUpperCase()}${page.slice(1)}Panel\\s*/>`, "u"), page);
  }
});

test("the shell reuses the host rail with users, sessions, engine in order, marks the active page, and links back to live", () => {
  assert.match(shell, /className="live-host-shell console-shell"/u);
  assert.match(shell, /<aside className="live-host-rail">/u);
  const usersIndex = shell.indexOf('"/console/users"');
  const sessionsIndex = shell.indexOf('"/console/sessions"');
  const engineIndex = shell.indexOf('"/console/engine"');
  assert.ok(usersIndex > -1 && usersIndex < sessionsIndex && sessionsIndex < engineIndex, "nav order is users, sessions, engine");
  assert.match(shell, /aria-current=\{[^}]*"page"[^}]*\}/u);
  assert.match(shell, /href="\/admin"/u);
  assert.match(shell, /console-badge/u);
  // M-4: the pending count is part of the Link's accessible name - visually hidden text inside the
  // Link, never an aria-label on a plain span (which assistive tech ignores on a non-interactive element).
  assert.doesNotMatch(shell, /className="console-badge"[^>]*aria-label=/u);
  assert.match(shell, /<span className="console-badge" aria-hidden="true">\{badge\}<\/span>/u);
  assert.match(shell, /<span className="console-sr-only">\{t\("대기 중인 가입 \{count\}건", \{ count: badge \}\)\}<\/span>/u);
  assert.match(css, /\.console-sr-only\s*\{[^}]*position:\s*absolute;[^}]*clip:\s*rect\(0 0 0 0\)/u);
  assert.match(css, /@media \(max-width: 1023px\)\s*\{[^@]*\.console-shell \.live-host-rail nav\s*\{[^}]*flex-direction:\s*row;[^}]*overflow-x:\s*auto/u);
});

test("tables scroll inside their wrapper, numbers are tabular, rows report busy and inline errors", () => {
  assert.match(css, /\.console-table-wrap\s*\{[^}]*overflow-x:\s*auto/u);
  assert.match(css, /\.console-num[^{]*\{[^}]*font-variant-numeric:\s*tabular-nums/u);
  for (const [name, source] of [["users", users], ["sessions", sessions]] as const) {
    assert.match(source, /className="console-table-wrap"/u, name);
    assert.match(source, /<table/u, name);
  }
  assert.match(users, /aria-busy=\{/u);
  assert.match(users, /role="alert"/u);
  // M-6: under 767 px the rows become grid cards (display: grid strips the implicit table roles), so
  // the semantics are pinned explicitly on every data row and cell.
  assert.match(users, /<tr key=\{row\.id\} role="row"/u);
  assert.equal(users.match(/<td role="cell" data-label=/gu)?.length, 8, "every data cell carries role=cell");
  assert.match(users, /<th scope="col" role="columnheader">/u);
  // I-2: the disable dialog closes on failure too, so the row's inline alert is not hidden behind the backdrop.
  assert.match(users, /finally \{[^}]*setDisableTarget\(null\)/u);
  assert.match(users, /aria-pressed=\{/u, "filter chips are plain toggles");
  assert.match(users, /<select/u, "role select and reject reason select");
  assert.match(sessions, /href=\{`\/records\/\$\{/u, "the session row links to its record instead of a tr click handler");
  assert.doesNotMatch(sessions, /<tr[^>]*onClick/u);
  assert.match(sessions, /className="console-num"/u);
});

test("D1: the engine page has no global engine control; per-user engines are switched from the users table behind a confirm and report per-session results", () => {
  // The dead global select, its 저장/배포 button and its confirm are gone: engine_defaults decides nothing.
  assert.doesNotMatch(engine, /<select/u);
  assert.doesNotMatch(engine, /engine-defaults/u);
  assert.doesNotMatch(engine, /isEngineDirty|reconcileEngineSelection|ConsoleEngineCatalog/u);
  assert.doesNotMatch(engine, /setIsConfirmOpen|deploy\(/u);
  assert.equal(engine.match(/<ConfirmDialog/gu)?.length, 1, "only the legacy-login confirm remains");
  assert.match(engine, /t\("기본 엔진: Soniox 인식\+번역\. 사용자별 엔진은 사용자 탭에서 바꾸며 즉시 적용됩니다\."\)/u);
  assert.match(engine, /href="\/console\/users"/u);
  // The account section (legacy login switch) is untouched.
  assert.match(engine, /legacyPasswordLoginEnabled/u);
  assert.match(engine, /method: "PUT"/u);
  assert.match(engine, /finally \{[^}]*setIsLegacyConfirmOpen\(false\)/u);

  // Users: the voiceProvider select opens a confirm that counts this host's running sessions from the all-time session list.
  assert.match(users, /voiceProvider/u);
  assert.match(users, /console\/sessions\?range=all/u);
  assert.match(users, /countActiveSessionsForHost\(/u);
  assert.equal(users.match(/<ConfirmDialog/gu)?.length, 2, "disable confirm + engine switch confirm");
  assert.match(users, /t\("이 사용자의 진행 중인 세션 \{count\}개가 즉시 전환됩니다\. 다음 세션부터도 이 엔진을 사용합니다\.", \{ count: /u);
  assert.match(users, /t\("진행 중인 세션 수를 확인할 수 없습니다\. 이 사용자의 진행 중인 세션은 모두 즉시 전환됩니다\."\)/u);
  // A cancelled confirm leaves the controlled select on the server value: nothing is patched locally.
  assert.doesNotMatch(users, /setProfiles\(\(current\)/u);
  // Per-session results render inline in the row and are announced; labels never fall through.
  assert.match(users, /role="status"/u);
  assert.match(users, /deployResultLabelKey\(/u);
  assert.match(users, /deployCodeLabelKey\(/u);
  assert.match(users, /finally \{[^}]*setVoiceTarget\(null\)/u, "the engine confirm closes on failure too");
  // The old "next session engine" framing is gone from both panels.
  assert.doesNotMatch(users, /다음 세션 엔진/u);
  assert.doesNotMatch(engine, /다음 세션부터 적용됩니다|다음 세션 설정/u);
});

test("the confirm dialog is a native dialog opened with showModal, cancel first and focused, escape closes", () => {
  assert.match(dialog, /<dialog/u);
  assert.match(dialog, /\.showModal\(\)/u);
  assert.match(dialog, /onCancel=\{/u);
  // I-1: Chromium ignores preventDefault() on a second Escape, so the element can close while React
  // still says open. `close` always resyncs state, otherwise the dialog could never reopen.
  assert.match(dialog, /<dialog[^>]*onClose=\{/u);
  assert.match(dialog, /if \(open\) onCancel\(\)/u);
  const cancelIndex = dialog.indexOf("autoFocus");
  const confirmIndex = dialog.indexOf("console-danger");
  assert.ok(cancelIndex > -1 && confirmIndex > -1 && cancelIndex < confirmIndex, "cancel button precedes the destructive action");
  assert.match(users, /<ConfirmDialog/u);
});

test("every console string goes through the three-language console dictionary and no panel uses emoji or optimistic writes", () => {
  const koreanKeys = Object.keys(consoleMessages.ko);
  assert.ok(koreanKeys.length > 30);
  for (const language of ["en", "ja"] as const) {
    assert.deepEqual(Object.keys(consoleMessages[language]).sort(), [...koreanKeys].sort(), language);
    for (const key of koreanKeys) {
      assert.ok(consoleMessages[language][key].trim(), `${language}: ${key}`);
      assert.notEqual(consoleMessages[language][key], key, `${language}: untranslated ${key}`);
      assert.deepEqual(consoleMessages[language][key].match(/\{\w+\}/gu)?.sort() ?? [], key.match(/\{\w+\}/gu)?.sort() ?? [], key);
    }
  }
  for (const [name, source] of Object.entries(panels)) {
    assert.match(source, /useSystemText\(consoleMessages\)/u, name);
    for (const match of source.matchAll(/\bt\("([^"]+)"/gu)) {
      assert.ok(Object.hasOwn(consoleMessages.ko, match[1]), `${name}: missing console message "${match[1]}"`);
    }
    // Every Korean literal is a dictionary key (so the panel never shows Korean to an en/ja operator), and no Korean sits in JSX text or template strings.
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    for (const match of code.matchAll(/"([^"\n]*[가-힣][^"\n]*)"/gu)) {
      assert.ok(Object.hasOwn(consoleMessages.ko, match[1]), `${name}: Korean literal outside the dictionary "${match[1]}"`);
    }
    // `${t("…")}` inside a template is dictionary copy; only the literal parts must be Korean-free.
    for (const match of code.matchAll(/`[^`]*`/gu)) assert.doesNotMatch(match[0].replace(/\$\{[^}]*\}/gu, ""), /[가-힣]/u, `${name}: Korean inside a template literal`);
    assert.doesNotMatch(code, />[^<{}]*[가-힣][^<{}]*</u, `${name}: raw Korean JSX text`);
    assert.doesNotMatch(source, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${name}: no emoji icons`);
    assert.doesNotMatch(source, /console\.(log|info|warn|error)\(/u, name);
  }
  // Every write re-reads from the server: there is no local row patching before the response arrives.
  assert.match(users, /await loadProfiles\(/u);
  assert.doesNotMatch(users, /setProfiles\(\(current\) => current\.map/u);
  // Every server code the client maps must resolve to a dictionary key, and the guard codes are covered.
  for (const [code, key] of Object.entries(CONSOLE_ERROR_MESSAGE_KEYS)) assert.ok(Object.hasOwn(consoleMessages.ko, key), `${code} -> ${key}`);
  for (const code of ["HOST_AUTH_REQUIRED", "CSRF_REJECTED", "INVALID_REQUEST", "INVALID_RESPONSE", "ADMIN_REQUIRED"]) assert.ok(Object.hasOwn(CONSOLE_ERROR_MESSAGE_KEYS, code), code);
});

test("a 401 from any console request sends the browser to /login and still rejects with the mapped copy", async () => {
  assert.match(client, /status === 401/u);
  assert.match(client, /window\.location\.assign\("\/login"\)/u);
  const assigned: string[] = [];
  const originalFetch = globalThis.fetch;
  const hadWindow = Object.hasOwn(globalThis, "window");
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { location: { assign: (url: string) => { assigned.push(url); } } };
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: "expired", code: "HOST_AUTH_REQUIRED" }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    await assert.rejects(consoleFetch("/api/console/users?status=pending"), (error: unknown) => error instanceof ConsoleRequestError && error.status === 401 && error.code === "HOST_AUTH_REQUIRED");
    assert.deepEqual(assigned, ["/login"]);
    assert.equal(consoleErrorKey(new ConsoleRequestError("expired", "HOST_AUTH_REQUIRED", 401), "fallback"), CONSOLE_ERROR_MESSAGE_KEYS.HOST_AUTH_REQUIRED);
    assert.equal(consoleErrorKey(new ConsoleRequestError("origin", "CSRF_REJECTED", 403), "fallback"), CONSOLE_ERROR_MESSAGE_KEYS.CSRF_REJECTED);
    assert.equal(consoleErrorKey(new ConsoleRequestError("bad", "INVALID_REQUEST", 400), "fallback"), CONSOLE_ERROR_MESSAGE_KEYS.INVALID_REQUEST);
    assert.equal(consoleErrorKey(new ConsoleRequestError("?", "SOMETHING_NEW", 500), "fallback"), "fallback");
    assert.equal(consoleErrorKey(new Error("network"), "fallback"), "fallback");
    // A 403 does not redirect: the admin gate and CSRF refusals are shown inline.
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: "no", code: "ADMIN_REQUIRED" }), { status: 403 })) as typeof fetch;
    await assert.rejects(consoleFetch("/api/console/users?status=pending"), (error: unknown) => error instanceof ConsoleRequestError && error.code === "ADMIN_REQUIRED");
    assert.deepEqual(assigned, ["/login"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (hadWindow) (globalThis as { window?: unknown }).window = originalWindow;
    else delete (globalThis as { window?: unknown }).window;
  }
});

test("the dashboard rail offers the console only to admins, and the session keeper covers console routes", () => {
  const railStart = dashboard.indexOf('<aside className="live-host-rail">');
  const railEnd = dashboard.indexOf("</aside>", railStart);
  const rail = dashboard.slice(railStart, railEnd);
  assert.doesNotMatch(rail, /href="\/records"/u);
  assert.match(dashboard, /href="\/records"/u);
  assert.match(dashboard, /isConsoleAdmin && <a className="glass-btn" href="\/console">/u);
  assert.doesNotMatch(rail, /href="\/console"/u);
  assert.match(dashboard, /fetch\("\/api\/auth\/session", \{[^}]*credentials: "same-origin"/u);
  assert.match(dashboard, /role === "admin"/u);
  for (const language of ["ko", "en", "ja"] as const) assert.ok(hostMessages[language]["콘솔"], language);
  assert.equal(isHostSessionPage("/console"), true);
  assert.equal(isHostSessionPage("/console/users"), true);
  assert.equal(isHostSessionPage("/consoles"), false);
});
