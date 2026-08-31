import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("desktop and mobile records routes reuse one controller and responsive surface", () => {
  const desktop = readFileSync(new URL("../../../app/records/page.tsx", import.meta.url), "utf8");
  const mobile = readFileSync(new URL("../../../app/m/records/page.tsx", import.meta.url), "utf8");
  const controller = readFileSync(new URL("./LiveRecordsRoute.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./live-records.module.css", import.meta.url), "utf8");

  assert.match(desktop, /<LiveRecordsRoute\s*\/>/u);
  assert.match(mobile, /<LiveRecordsRoute\s*\/>/u);
  assert.doesNotMatch(`${desktop}\n${mobile}`, /fetch\(|records-client/u);
  assert.equal((controller.match(/await fetchLiveRecordPage\(/gu) ?? []).length, 1,
    "the shared controller keeps one list request call");
  assert.match(styles, /@media \(max-width: 360px\)/u);
  assert.match(styles, /\.list,\s*\.detail\s*\{\s*width:\s*100%/u);
});
