import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("participant consent keeps privacy required and optional purposes independent", () => {
  const source = readFileSync(new URL("./ParticipantConsentFields.tsx", import.meta.url), "utf8");
  assert.match(source, /name="privacyConsent"[\s\S]*required/u);
  assert.match(source, /name="summaryDeliveryConsent"/u);
  assert.match(source, /name="marketingConsent"/u);
  assert.match(source, /aria-describedby=/u);
  assert.match(source, /<details/u);
  assert.doesNotMatch(source, /<label[\s\S]*?<a/u,
    "notice disclosure must not be nested inside the checkbox label");
  assert.match(source, /notices\.privacy\.version/u);
  assert.match(source, /notices\.summaryDelivery\.version/u);
  assert.match(source, /notices\.marketing\.version/u);
  assert.match(source, /<summary>\{t\("내용 보기"\)\}<\/summary>/u,
    "native disclosure keeps the notice keyboard operable without custom handlers");
  assert.doesNotMatch(source, /checked=\{[^}]*privacy[^}]*summary|checked=\{[^}]*summary[^}]*marketing/iu);
});

test("consent controls preserve 44px targets, focus, zoom flow, and semantic tokens", () => {
  const styles = readFileSync(new URL("./participant-consent-fields.module.css", import.meta.url), "utf8");
  assert.match(styles, /min-height:\s*44px/u);
  assert.match(styles, /outline:\s*2px solid var\(--nova-system-default\)/u);
  assert.match(styles, /grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}|gradient/iu);
});
