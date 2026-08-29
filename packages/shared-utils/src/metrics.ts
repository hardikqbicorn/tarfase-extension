/**
 * Dependency-free Prometheus-compatible metrics registry. Kept minimal on
 * purpose: services expose /metrics in the standard text exposition format,
 * so any Prometheus/Grafana/OTel-collector scrape works without pulling a
 * heavyweight client into every service image.
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(",");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string
  ) {}
  abstract expose(): string;
}

export class Counter extends Metric {
  private values = new Map<string, number>();

  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    }
    for (const [key, value] of this.values) {
      lines.push(key ? `${this.name}{${key}} ${value}` : `${this.name} ${value}`);
    }
    return lines.join("\n");
  }
}

export class Gauge extends Metric {
  private values = new Map<string, number>();

  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), value);
  }

  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  dec(labels: Labels = {}, amount = 1): void {
    this.inc(labels, -amount);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    }
    for (const [key, value] of this.values) {
      lines.push(key ? `${this.name}{${key}} ${value}` : `${this.name} ${value}`);
    }
    return lines.join("\n");
  }
}

export class Histogram extends Metric {
  private buckets: number[];
  private counts = new Map<string, number[]>();
  private sums = new Map<string, number>();
  private totals = new Map<string, number>();

  constructor(name: string, help: string, buckets?: number[]) {
    super(name, help);
    this.buckets = (buckets ?? [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]).slice().sort(
      (a, b) => a - b
    );
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    if (!this.counts.has(key)) {
      this.counts.set(key, new Array(this.buckets.length).fill(0));
      this.sums.set(key, 0);
      this.totals.set(key, 0);
    }
    const bucketCounts = this.counts.get(key)!;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) bucketCounts[i] += 1;
    }
    this.sums.set(key, this.sums.get(key)! + value);
    this.totals.set(key, this.totals.get(key)! + 1);
  }

  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, bucketCounts] of this.counts) {
      const prefix = key ? `${key},` : "";
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(`${this.name}_bucket{${prefix}le="${this.buckets[i]}"} ${bucketCounts[i]}`);
      }
      lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${this.totals.get(key)}`);
      lines.push(
        key ? `${this.name}_sum{${key}} ${this.sums.get(key)}` : `${this.name}_sum ${this.sums.get(key)}`
      );
      lines.push(
        key
          ? `${this.name}_count{${key}} ${this.totals.get(key)}`
          : `${this.name}_count ${this.totals.get(key)}`
      );
    }
    return lines.join("\n");
  }
}

export class MetricsRegistry {
  private metrics: Metric[] = [];

  counter(name: string, help: string): Counter {
    const metric = new Counter(name, help);
    this.metrics.push(metric);
    return metric;
  }

  gauge(name: string, help: string): Gauge {
    const metric = new Gauge(name, help);
    this.metrics.push(metric);
    return metric;
  }

  histogram(name: string, help: string, buckets?: number[]): Histogram {
    const metric = new Histogram(name, help, buckets);
    this.metrics.push(metric);
    return metric;
  }

  /** Renders the Prometheus text exposition format. */
  expose(): string {
    return this.metrics.map((m) => m.expose()).join("\n\n") + "\n";
  }
}
