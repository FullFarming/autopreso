import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { isHostSessionPage } from "../auth/host-session-pages";
import { consoleMessages } from "../../lib/system-language/console-messages";
import { hostMessages } from "../../lib/system-language/host-messages";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const shell = read("components/console/ConsoleShell.tsx");
const users = read("components/console/UsersPanel.tsx");
const sessions = read("components/console/SessionsPanel.tsx");
const engine = read("components/console/EnginePanel.tsx");
const dialog = read("components/console/ConfirmDialog.tsx");
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
  assert.match(users, /aria-pressed=\{/u, "filter chips are plain toggles");
  assert.match(users, /<select/u, "role select and reject reason select");
  assert.match(sessions, /href=\{`\/records\/\$\{/u, "the session row links to its record instead of a tr click handler");
  assert.doesNotMatch(sessions, /<tr[^>]*onClick/u);
  assert.match(sessions, /className="console-num"/u);
});

test("the engine page deploys through a confirm dialog and renders per-session results when the PUT returns them", () => {
  assert.match(engine, /\/api\/console\/sessions\?range=7d/u, "active-session count comes from the sessions route");
  assert.match(engine, /countActiveSessions\(/u);
  assert.match(engine, /t\("배포"\)/u);
  assert.doesNotMatch(engine, /t\("저장"\)/u, "the primary action is 배포, not 저장");
  assert.match(engine, /t\("진행 중인 세션 \{count\}개가 즉시 전환됩니다\."/u);
  assert.match(engine, /<ConfirmDialog/u);
  assert.match(engine, /results/u);
  assert.match(engine, /role="status"/u);
  assert.match(engine, /filterTranslationOptions\(/u);
  assert.match(engine, /languageModesFor\(/u);
  assert.match(engine, /isEngineDirty\(/u);
  assert.match(engine, /disabled=\{[^}]*available === false/u, "unavailable catalog entries are disabled options");
  assert.match(engine, /legacyPasswordLoginEnabled/u);
  assert.match(engine, /method: "PUT"/u);
});

test("the confirm dialog is a native dialog opened with showModal, cancel first and focused, escape closes", () => {
  assert.match(dialog, /<dialog/u);
  assert.match(dialog, /\.showModal\(\)/u);
  assert.match(dialog, /onCancel=\{/u);
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
    assert.doesNotMatch(source, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${name}: no emoji icons`);
    assert.doesNotMatch(source, /console\.(log|info|warn|error)\(/u, name);
  }
  // Every write re-reads from the server: there is no local row patching before the response arrives.
  assert.match(users, /await loadProfiles\(/u);
  assert.doesNotMatch(users, /setProfiles\(\(current\) => current\.map/u);
});

test("the dashboard rail offers the console only to admins, and the session keeper covers console routes", () => {
  const railStart = dashboard.indexOf('<aside className="live-host-rail">');
  const railEnd = dashboard.indexOf("</aside>", railStart);
  const rail = dashboard.slice(railStart, railEnd);
  assert.match(rail, /href="\/records"/u);
  assert.match(rail, /isConsoleAdmin && <a href="\/console">\{t\("콘솔"\)\}<\/a>/u);
  assert.ok(rail.indexOf('href="/records"') < rail.indexOf('href="/console"'), "the console link follows 라이브콜 기록");
  assert.match(dashboard, /fetch\("\/api\/auth\/session", \{[^}]*credentials: "same-origin"/u);
  assert.match(dashboard, /role === "admin"/u);
  for (const language of ["ko", "en", "ja"] as const) assert.ok(hostMessages[language]["콘솔"], language);
  assert.equal(isHostSessionPage("/console"), true);
  assert.equal(isHostSessionPage("/console/users"), true);
  assert.equal(isHostSessionPage("/consoles"), false);
});
