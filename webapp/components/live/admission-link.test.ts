import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import { buildAdmissionJoinUrl, parseAdmissionLinkHash } from "./admission-link";

const inviteToken = "a".repeat(43);

test("restored admission links carry only a six-digit fragment on the mobile participant route", () => {
  const url = new URL(buildAdmissionJoinUrl("https://nova.test", "001234"));
  assert.equal(url.origin, "https://nova.test");
  assert.equal(url.pathname, "/m/watch");
  assert.equal(url.search, "");
  assert.equal(url.hash, "#code=001234");
  assert.deepEqual(parseAdmissionLinkHash(url.hash), { kind: "code", accessCode: "001234", canonicalHash: "#code=001234" });
  assert.equal(buildAdmissionJoinUrl("http://localhost:3000", "123456"), "http://localhost:3000/m/watch#code=123456");
});

test("admission URL construction rejects non-origin input and never coerces malformed codes", () => {
  for (const origin of ["javascript:alert(1)", "file:///tmp/nova", "//nova.test", "https://user:secret@nova.test", "https://nova.test/private", "https://nova.test?token=secret", "https://nova.test#invite=secret", "not a URL"]) {
    assert.throws(() => buildAdmissionJoinUrl(origin, "123456"));
  }
  for (const code of ["", "12345", "1234567", " 123456", "123456 ", "12-3456", "１２３４５６", "12345\n", "1e2345"]) {
    assert.throws(() => buildAdmissionJoinUrl("https://nova.test", code));
  }
});

test("fragment normalization accepts decoded ASCII credentials and removes unrelated fields", () => {
  assert.deepEqual(parseAdmissionLinkHash("#code=%30%30%31%32%33%34&next=https://evil.test&accessToken=secret"), { kind: "code", accessCode: "001234", canonicalHash: "#code=001234" });
  assert.deepEqual(parseAdmissionLinkHash(`#invite=${inviteToken}&viewerToken=secret`), { kind: "invite", inviteToken, canonicalHash: `#invite=${inviteToken}` });
  assert.deepEqual(parseAdmissionLinkHash(""), { kind: "none", canonicalHash: "" });
  assert.deepEqual(parseAdmissionLinkHash("#"), { kind: "none", canonicalHash: "" });
  assert.deepEqual(parseAdmissionLinkHash("#next=/admin"), { kind: "none", canonicalHash: "" });
});

test("one valid invite keeps precedence over a code and invalid invites cannot fall back to codes", () => {
  for (const code of ["001234", "invalid"]) {
    assert.deepEqual(parseAdmissionLinkHash(`#code=${code}&invite=${inviteToken}`), { kind: "invite", inviteToken, canonicalHash: `#invite=${inviteToken}` });
  }
  for (const hash of ["#invite=&code=001234", "#invite=invalid&code=001234"]) {
    assert.deepEqual(parseAdmissionLinkHash(hash), { kind: "invalid", canonicalHash: "" });
  }
});

test("duplicate and malformed credentials fail closed and cannot survive canonical sharing", () => {
  for (const hash of ["#code=123456&code=123456", "#code=123456&%63ode=654321", `#invite=${inviteToken}&invite=${inviteToken}`, `#invite=${inviteToken}&code=123456&code=123456`, "#code=", "#code=12345", "#code=1234567", "#code=１２３４５６", "#code=123456%0A", "#code=%ZZ", "#code=123+456", "#code=%2531%2532%2533%2534%2535%2536", `#invite=${"a".repeat(44)}`]) {
    assert.deepEqual(parseAdmissionLinkHash(hash), { kind: "invalid", canonicalHash: "" }, hash);
  }
});

test("the initial viewer fragment only prefills once and preserves input edited before the effect", () => {
  const source = readFileSync(new URL("./LiveViewer.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("viewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.ArrowFunction | undefined;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect"
      && ts.isArrowFunction(node.arguments[0]) && node.arguments[0].getText(tree).includes("parseAdmissionLinkHash(window.location.hash)")) {
      assert.equal(node.arguments[1]?.getText(tree), "[]");
      assert.equal(initializer, undefined);
      initializer = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(initializer, "a single mount-only fragment reader must prefill the admission form");
  const effect = ts.transpileModule(`(${initializer.getText(tree)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  assert.doesNotMatch(effect, /fetch\(|join\(|redeem|localStorage|sessionStorage|setPrivacyConsent|setEmail|setDisplayName/u);
  let admissionCode = "";
  let pendingInvite = "";
  let error = "";
  const replacements: string[] = [];
  const window = {
    location: { pathname: "/m/watch", search: "?language=en", hash: "#code=001234&token=secret" },
    navigator: { userAgent: "test", maxTouchPoints: 0 },
    history: { replaceState: (_state: null, _title: string, destination: string) => replacements.push(destination) },
  };
  const requestedLanguageRef = { current: "" };
  const initialize = new Function("window", "getViewerSurfaceRedirect", "requestedLanguageRef", "parseAdmissionLinkHash", "setAdmissionCode", "setPendingInviteToken", "setError", `return ${effect}`)(
    window, () => null, requestedLanguageRef, parseAdmissionLinkHash,
    (update: (current: string) => string) => { admissionCode = update(admissionCode); },
    (value: string) => { pendingInvite = value; }, (value: string) => { error = value; },
  );
  initialize();
  assert.equal(admissionCode, "001234");
  assert.equal(pendingInvite, "");
  assert.equal(error, "");
  assert.equal(requestedLanguageRef.current, "en");
  assert.deepEqual(replacements, ["/m/watch?language=en#code=001234"]);
  admissionCode = "654321";
  initialize();
  assert.equal(admissionCode, "654321");
  window.location.hash = `#invite=${inviteToken}&code=001234&token=secret`;
  initialize();
  assert.equal(pendingInvite, inviteToken);
  assert.equal(admissionCode, "654321");
  assert.equal(replacements.at(-1), `/m/watch?language=en#invite=${inviteToken}`);
  window.location.hash = "#code=invalid";
  initialize();
  assert.equal(replacements.at(-1), "/m/watch?language=en");
  assert.ok(error);
  admissionCode = "";
  window.location.search = "?code=111111";
  window.location.hash = "";
  initialize();
  assert.equal(admissionCode, "", "query codes must not prefill or redeem admission");
  assert.doesNotMatch(source, /addEventListener\(["']hashchange["']/u);
});
