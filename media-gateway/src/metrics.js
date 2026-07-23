export class GatewayMetrics {
  #counters = new Map();
  #gauges = new Map();

  increment(name, amount = 1) {
    assertMetric(name, amount);
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + amount);
  }

  set(name, value) {
    assertMetric(name, value);
    this.#gauges.set(name, value);
  }

  render() {
    const lines = [];
    for (const [name, value] of [...this.#counters, ...this.#gauges]) lines.push(`realtime_noel_${name} ${value}`);
    return `${lines.join("\n")}\n`;
  }
}

function assertMetric(name, value) {
  if (!/^[a-z][a-z0-9_]*$/u.test(name) || !Number.isFinite(value)) throw new Error("INVALID_METRIC");
}
