const HISTOGRAM_BUCKET_BOUNDS = Object.freeze([5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000]);

export class GatewayMetrics {
  #counters = new Map();
  #gauges = new Map();
  #histograms = new Map();

  increment(name, amount = 1) {
    assertMetric(name, amount);
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + amount);
  }

  set(name, value) {
    assertMetric(name, value);
    this.#gauges.set(name, value);
  }

  observe(name, value) {
    assertMetric(name, value);
    let histogram = this.#histograms.get(name);
    if (!histogram) {
      histogram = { buckets: HISTOGRAM_BUCKET_BOUNDS.map(() => 0), sum: 0, count: 0 };
      this.#histograms.set(name, histogram);
    }
    histogram.sum += value;
    histogram.count += 1;
    for (let index = 0; index < HISTOGRAM_BUCKET_BOUNDS.length; index += 1) {
      if (value <= HISTOGRAM_BUCKET_BOUNDS[index]) histogram.buckets[index] += 1;
    }
  }

  render() {
    const lines = [];
    for (const [name, value] of [...this.#counters, ...this.#gauges]) lines.push(`realtime_noel_${name} ${value}`);
    for (const [name, histogram] of this.#histograms) {
      for (let index = 0; index < HISTOGRAM_BUCKET_BOUNDS.length; index += 1) {
        lines.push(`realtime_noel_${name}_bucket{le="${HISTOGRAM_BUCKET_BOUNDS[index]}"} ${histogram.buckets[index]}`);
      }
      lines.push(`realtime_noel_${name}_bucket{le="+Inf"} ${histogram.count}`);
      lines.push(`realtime_noel_${name}_sum ${histogram.sum}`);
      lines.push(`realtime_noel_${name}_count ${histogram.count}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

function assertMetric(name, value) {
  if (!/^[a-z][a-z0-9_]*$/u.test(name) || !Number.isFinite(value)) throw new Error("INVALID_METRIC");
}
