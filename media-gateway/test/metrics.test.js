import assert from "node:assert/strict";
import test from "node:test";

import { GatewayMetrics } from "../src/metrics.js";

test("histograms observe values into cumulative buckets and render alongside counters", () => {
  const metrics = new GatewayMetrics();
  metrics.increment("captions_total");
  metrics.observe("caption_publish_latency_ms", 4);
  metrics.observe("caption_publish_latency_ms", 120);
  metrics.observe("caption_publish_latency_ms", 99_999);

  const rendered = metrics.render();
  assert.match(rendered, /realtime_noel_captions_total 1/u);
  assert.match(rendered, /realtime_noel_caption_publish_latency_ms_bucket\{le="5"\} 1/u);
  assert.match(rendered, /realtime_noel_caption_publish_latency_ms_bucket\{le="250"\} 2/u);
  assert.match(rendered, /realtime_noel_caption_publish_latency_ms_bucket\{le="\+Inf"\} 3/u);
  assert.match(rendered, /realtime_noel_caption_publish_latency_ms_sum 100123/u);
  assert.match(rendered, /realtime_noel_caption_publish_latency_ms_count 3/u);
});

test("histogram observations reject invalid names and non-finite values", () => {
  const metrics = new GatewayMetrics();
  assert.throws(() => metrics.observe("Bad-Name", 1), /INVALID_METRIC/u);
  assert.throws(() => metrics.observe("latency_ms", Number.NaN), /INVALID_METRIC/u);
});
