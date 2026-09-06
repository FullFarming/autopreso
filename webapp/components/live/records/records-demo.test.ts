import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isDevelopmentRecordDemoRequest } from "../../../lib/security/development-record-demo";

test("only exact GET demo pages in development bypass authentication", () => {
  for (const path of ["/records/demo", "/m/records/demo"]) {
    assert.equal(isDevelopmentRecordDemoRequest(path, "GET", "development"), true);
    for (const environment of ["production", "test", undefined, ""]) {
      assert.equal(isDevelopmentRecordDemoRequest(path, "GET", environment), false);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "get"]) {
      assert.equal(isDevelopmentRecordDemoRequest(path, method, "development"), false);
    }
  }
  for (const path of ["/records", "/records/demo/", "/records/demo/export", "/m/records/demo/evil", "/api/live-records/demo", "/records/%64emo", "/RECORDS/demo"]) {
    assert.equal(isDevelopmentRecordDemoRequest(path, "GET", "development"), false);
  }
});

test("local records demo is blocked in production before creating its workbook", () => {
  const route = readFileSync(new URL("../../../app/records/demo/page.tsx", import.meta.url), "utf8");
  const mobile = readFileSync(new URL("../../../app/m/records/demo/page.tsx", import.meta.url), "utf8");
  assert.match(route, /NODE_ENV === "production"\) notFound\(\)/u);
  assert.ok(route.indexOf('NODE_ENV === "production"') < route.indexOf("const workbook = await buildLiveRecordWorkbook"));
  assert.match(mobile, /records\/demo\/page/u);
});

test("local preview uses explicit fixture adapters without replacing production fetch", () => {
  const demo = readFileSync(new URL("./demo/LiveRecordsDemo.tsx", import.meta.url), "utf8");
  const detail = readFileSync(new URL("./LiveRecordDetail.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("./LiveRecordsRoute.tsx", import.meta.url), "utf8");
  assert.match(demo, /예시 데이터 · 로컬 시연/u);
  assert.match(demo, /dataSource=\{dataSource\}/u);
  assert.match(detail, /dataSource = defaultDataSource/u);
  assert.doesNotMatch(`${demo}\n${route}`, /globalThis\.fetch|window\.fetch\s*=|fetch\s*=/u);
  assert.doesNotMatch(route, /demo|fixture|dataSource=/u);
  assert.match(demo, /new Blob/u);
  assert.doesNotMatch(demo, /fetch\(|supabase|sendMail|\/api\//u);
});
