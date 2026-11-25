// Log-bucketed latency histogram with bounded memory. A 10,000-user run produces millions of
// duration values; keeping them all to sort for a p99 does not scale, and averaging percentiles
// across seconds is wrong. Buckets 1% wide keep any quantile within about 0.5% of the exact value.

export class LogHistogram {
  /**
   * @param {{precision?: number, floor?: number}} [options]
   *   precision: relative bucket width; floor: smallest distinguishable value (ms).
   */
  constructor({ precision = 0.01, floor = 0.01 } = {}) {
    this.precision = precision;
    this.floor = floor;
    this.logBase = Math.log1p(precision);
    /** @type {Map<number, number>} */
    this.buckets = new Map();
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }

  /** @param {number} value */
  add(value) {
    if (!Number.isFinite(value) || value < 0) return;
    const index = value <= this.floor ? 0 : 1 + Math.floor(Math.log(value / this.floor) / this.logBase);
    this.buckets.set(index, (this.buckets.get(index) ?? 0) + 1);
    this.count += 1;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
  }

  /** @param {LogHistogram} other */
  merge(other) {
    if (other.precision !== this.precision || other.floor !== this.floor) {
      throw new Error('Cannot merge histograms with different bucket layouts');
    }
    for (const [index, n] of other.buckets) {
      this.buckets.set(index, (this.buckets.get(index) ?? 0) + n);
    }
    this.count += other.count;
    this.sum += other.sum;
    this.min = Math.min(this.min, other.min);
    this.max = Math.max(this.max, other.max);
    return this;
  }

  get mean() {
    return this.count === 0 ? null : this.sum / this.count;
  }

  /**
   * Nearest-rank quantile, reported as the geometric middle of its bucket and clamped to the
   * observed range, so p(100) is the true maximum and p(0) the true minimum.
   * @param {number} q between 0 and 1
   * @returns {number | null}
   */
  quantile(q) {
    if (this.count === 0) return null;
    if (q <= 0) return this.min;
    if (q >= 1) return this.max;
    const rank = Math.ceil(q * this.count);
    let seen = 0;
    const indexes = [...this.buckets.keys()].sort((a, b) => a - b);
    for (const index of indexes) {
      seen += this.buckets.get(index);
      if (seen >= rank) {
        const value = index === 0 ? this.floor : this.floor * Math.exp((index - 0.5) * this.logBase);
        return Math.min(this.max, Math.max(this.min, value));
      }
    }
    return this.max;
  }
}
