'use strict';
/**
 * Central sliding-window rate limiter.
 *
 * Every outbound request the framework makes (API calls and database-evidence
 * calls alike) must call `acquire()` on the single shared instance before it is
 * sent. Acquisitions are serialised through a promise chain, so concurrent
 * workers, retries, discovery refreshes and observation probes cannot bypass it.
 *
 * Guarantee: for any half-open interval of `windowMs` milliseconds, at most
 * `maxPerWindow` grants are issued (grant[i + max] - grant[i] >= windowMs).
 */
class RateLimiter {
  constructor({ maxPerWindow = 2, windowMs = 1000, marginMs = 5, now = Date.now, historyLimit = 20000 } = {}) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.marginMs = marginMs;
    this.now = now;
    this.historyLimit = historyLimit;
    this.recent = [];   // grant times inside the current window
    this.grants = [];   // {t, label} history for verification
    this.tail = Promise.resolve();
  }

  acquire(label = '') {
    const next = this.tail.then(() => this._take(label));
    // Keep the chain alive even if a waiter is abandoned.
    this.tail = next.catch(() => {});
    return next;
  }

  async _take(label) {
    for (;;) {
      const t = this.now();
      this.recent = this.recent.filter((g) => t - g < this.windowMs);
      if (this.recent.length < this.maxPerWindow) {
        this.recent.push(t);
        this.grants.push({ t, label });
        if (this.grants.length > this.historyLimit) this.grants.splice(0, this.grants.length - this.historyLimit);
        return t;
      }
      const waitMs = this.recent[0] + this.windowMs - t + this.marginMs;
      await new Promise((r) => setTimeout(r, Math.max(1, waitMs)));
    }
  }

  /** Grants issued in [from, to]. */
  grantsBetween(from, to = Infinity) {
    return this.grants.filter((g) => g.t >= from && g.t <= to);
  }

  /** Largest number of grants observed inside any windowMs-long window. */
  static maxInAnyWindow(times, windowMs = 1000) {
    const ts = [...times].sort((a, b) => a - b);
    let best = 0;
    let lo = 0;
    for (let hi = 0; hi < ts.length; hi++) {
      while (ts[hi] - ts[lo] >= windowMs) lo++;
      best = Math.max(best, hi - lo + 1);
    }
    return best;
  }
}

module.exports = { RateLimiter };
