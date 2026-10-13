'use strict';
/**
 * Execution engine: runs only approved, executable test cases against the live
 * API, with bounded retries, safe stop, failure classification and defect
 * analysis. Emits 'log', 'case' and 'run' events for the dashboard.
 */
const { EventEmitter } = require('events');
const { TestContext, BlockedError, DependencyError } = require('./context');
const { TransportError } = require('./httpClient');
const { discoverAll } = require('./discovery');
const { RateLimiter } = require('./rateLimiter');
const { DbError } = require('./db');

const STATUS = {
  PASSED: 'Passed',
  FAILED: 'Failed',
  BLOCKED: 'Blocked',
  NOT_EXECUTED: 'Not Executed',
  RUNNING: 'Running',
  QUEUED: 'Queued',
};
const SEVERITY_UNASSIGNED = 'Unassigned — no classification policy supplied';

function runId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `RUN-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

class Engine extends EventEmitter {
  constructor({ client, limiter, config, catalog, store, db = null }) {
    super();
    this.client = client;
    this.db = db;
    this.limiter = limiter;
    this.config = config;
    this.catalog = catalog;
    this.byId = new Map(catalog.map((c) => [c.id, c]));
    this.store = store;
    this.run = null;
    this.stopRequested = false;
    this.logSeq = 0;
  }

  isActive() {
    return !!(this.run && this.run.status === 'running');
  }

  /** Replaces the case definitions (e.g. after a reviewer decision). Refused during a run. */
  setCatalog(catalog) {
    if (this.isActive()) throw Object.assign(new Error('Cannot change case definitions while a run is active'), { code: 409 });
    this.catalog = catalog;
    this.byId = new Map(catalog.map((c) => [c.id, c]));
  }

  /** Validates eligibility and starts a run asynchronously. Returns the run record. */
  start(approvedIds) {
    if (this.isActive()) {
      const e = new Error(`Run ${this.run.runId} is already active`);
      e.code = 409;
      throw e;
    }
    const eligible = approvedIds.filter((id) => this.byId.has(id) && this.byId.get(id).validation === 'automated');
    if (!eligible.length) {
      const e = new Error('No approved, executable test cases. Approve at least one eligible case first.');
      e.code = 400;
      throw e;
    }
    this.stopRequested = false;
    const id = runId();
    this.run = {
      runId: id,
      status: 'running',
      phase: 'preparation',
      startedAt: new Date().toISOString(),
      endedAt: null,
      partial: true,
      eligibleIds: eligible,
      config: {
        apiBaseUrl: this.config.apiBaseUrl,
        maxRetries: this.config.maxRetries,
        maxAttempts: this.config.maxRetries + 1,
        rateLimitPerSecond: this.config.rateLimitPerSecond,
        concurrency: this.config.concurrency,
        requestTimeoutMs: this.config.requestTimeoutMs,
      },
      results: Object.fromEntries(eligible.map((cid) => [cid, { caseId: cid, status: STATUS.QUEUED, attempts: [], retryCount: 0 }])),
      logs: [],
      defects: [],
      discovery: null,
      rateLimit: null,
      error: null,
    };
    this.emit('run', this.summary());
    this._execute().catch((err) => {
      this.run.status = 'error';
      this.run.error = err.stack || String(err);
      this._log(null, 'run', 'error', `Execution error: ${err.message}`);
      this._finish();
    });
    return this.summary();
  }

  stop() {
    if (!this.isActive()) return false;
    if (!this.stopRequested) {
      this.stopRequested = true;
      this._log(null, 'stop', 'warn', 'Stop requested: no new test cases or retries will start; in-flight read-only requests are allowed to complete and are recorded.');
      this.emit('run', this.summary());
    }
    return true;
  }

  _log(caseId, stage, status, message) {
    if (!this.run) return;
    const entry = { seq: ++this.logSeq, ts: new Date().toISOString(), runId: this.run.runId, caseId: caseId || null, stage, status, message };
    this.run.logs.push(entry);
    this.emit('log', entry);
  }

  async _execute() {
    const run = this.run;
    this._log(null, 'run', 'info', `Run ${run.runId} started with ${run.eligibleIds.length} approved executable case(s). Max ${run.config.maxAttempts} attempts per case; shared limit ${run.config.rateLimitPerSecond} request(s)/s.`);

    // Preparation: fresh API + database discovery for this run.
    this._log(null, 'preparation', 'info', 'Preparation: fetching OpenAPI contract and probing database access (read-only).');
    const discovery = await discoverAll(this.client, this.db, {
      retries: this.config.maxRetries,
      backoffMs: this.config.retryBackoffMs,
      onEvent: (e) => this._log(null, 'preparation', e.error || e.status >= 500 ? 'warn' : 'info',
        e.db ? `Database discovery query (${e.purpose}) → ${e.rows} row(s) in ${e.ms} ms`
          : e.error ? `Discovery request ${e.path} (attempt ${e.attempt}) failed: ${e.error}` : `Discovery request GET ${e.path} (attempt ${e.attempt}) → HTTP ${e.status} in ${e.durationMs} ms`),
    });
    run.discovery = { api: discovery.api, db: discovery.db, startedAt: discovery.startedAt, finishedAt: discovery.finishedAt };
    this.emit('discovery', discovery);
    this._log(null, 'preparation', discovery.api.contract.available ? 'info' : 'error', discovery.api.contract.available
      ? `Contract available: ${discovery.api.contract.title} ${discovery.api.contract.version} (OpenAPI ${discovery.api.contract.openapi}).`
      : `Contract NOT available (${discovery.api.contract.status || discovery.api.contract.error}). Contract-dependent cases will be Blocked.`);
    const dbd = discovery.db;
    this._log(null, 'preparation', dbd.connected ? 'info' : 'error', dbd.connected
      ? `Database connected: ${dbd.database} (${dbd.version}) via ${this.config.db.ssh.enabled ? 'SSH tunnel' : 'direct TCP'}, read-only. Tables: ${dbd.tables.map((t) => `${t.name}${t.rowCount !== null ? '(' + t.rowCount + ')' : t.sensitive ? '(not read)' : ''}`).join(', ')}. Foreign keys: ${dbd.relationships.map((r) => r.from + '→' + r.to).join(', ') || 'none'}.`
      : `Database NOT available: ${dbd.error}. Database-dependent cases will be Blocked.`);

    const prep = { spec: discovery.spec, discovery, runId: run.runId, db: this.db, dbConfig: this.config.db };
    const refCache = new Map();
    const queue = [...run.eligibleIds];
    run.phase = 'executing';
    this.emit('run', this.summary());

    const worker = async () => {
      while (queue.length && !this.stopRequested) {
        const caseId = queue.shift();
        await this._runCase(this.byId.get(caseId), prep, refCache);
        this.store.saveRun(run);
      }
    };
    await Promise.all(Array.from({ length: this.config.concurrency }, worker));

    for (const cid of run.eligibleIds) {
      const r = run.results[cid];
      if (r.status === STATUS.QUEUED) {
        r.status = STATUS.NOT_EXECUTED;
        r.finalReason = 'Not started: run was stopped before this case began.';
        this._log(cid, 'result', 'info', 'Final result recorded: Not Executed (run stopped before this case started).');
        this.emit('case', r);
      }
    }
    run.status = this.stopRequested ? 'stopped' : 'completed';
    this._finish();
  }

  _finish() {
    const run = this.run;
    run.endedAt = new Date().toISOString();
    run.phase = 'done';
    run.partial = run.status !== 'completed' || run.eligibleIds.some((id) => run.results[id].status === STATUS.NOT_EXECUTED);
    const startMs = Date.parse(run.startedAt);
    const grants = this.limiter.grantsBetween(startMs, Date.now() + 1);
    const dbGrants = grants.filter((g) => g.label.startsWith('DB '));
    run.rateLimit = {
      configuredPerSecond: this.config.rateLimitPerSecond,
      requestsIssued: grants.length,
      dbQueries: dbGrants.length,
      httpRequests: grants.length - dbGrants.length,
      maxObservedInAnyOneSecondWindow: RateLimiter.maxInAnyWindow(grants.map((g) => g.t), 1000),
      maxDbQueriesInAnyOneSecondWindow: RateLimiter.maxInAnyWindow(dbGrants.map((g) => g.t), 1000),
    };
    this._log(null, 'run', run.status === 'completed' ? 'pass' : 'warn',
      `Run ${run.status}. ${run.rateLimit.httpRequests} HTTP request(s) + ${run.rateLimit.dbQueries} DB queries; max ${run.rateLimit.maxObservedInAnyOneSecondWindow} operations (max ${run.rateLimit.maxDbQueriesInAnyOneSecondWindow} DB queries) in any 1-second window (limit ${this.config.rateLimitPerSecond}).`);
    this.store.saveRun(run);
    this.emit('run', this.summary());
  }

  async _runCase(def, prep, refCache) {
    const run = this.run;
    const result = run.results[def.id];
    result.status = STATUS.RUNNING;
    result.startedAt = new Date().toISOString();
    this.emit('case', result);
    const log = (stage, status, msg) => this._log(def.id, stage, status, msg);
    log('case', 'info', `Test case started: ${def.scenario}`);

    const maxAttempts = this.config.maxRetries + 1;
    for (let n = 1; n <= maxAttempts; n++) {
      if (n > 1) {
        log('retry', 'warn', `Retry started: attempt ${n} of ${maxAttempts} (retry ${n - 1} of ${this.config.maxRetries}).`);
        await new Promise((r) => setTimeout(r, this.config.retryBackoffMs));
      }
      const attempt = await this._attempt(def, prep, refCache, n, log);
      result.attempts.push(attempt);
      result.retryCount = result.attempts.length - 1;
      this.emit('case', result);

      if (attempt.outcome === 'passed') break;
      log('failure', attempt.outcome === 'blocked' ? 'blocked' : 'fail', `Failure detected (attempt ${n}): ${attempt.outcomeLabel}.`);
      log('failure', 'info', `Failure reason identified at stage "${attempt.failureStage}": ${attempt.failureReason}`);
      if (!attempt.retryable) {
        log('retry', 'info', `Not retried: ${attempt.notRetriedBecause}`);
        break;
      }
      if (this.stopRequested) {
        result.retriesInterrupted = true;
        log('retry', 'warn', `Remaining retries cancelled by stop request after attempt ${n} of ${maxAttempts}.`);
        break;
      }
    }
    this._finalise(def, result);
  }

  async _attempt(def, prep, refCache, n, log) {
    const ctx = new TestContext({ client: this.client, caseDef: def, attempt: n, prep, refCache, log });
    const startedAt = new Date().toISOString();
    let outcome;
    let failureReason = '';
    let failureCategory = '';
    let retryable = false;
    let notRetriedBecause = '';
    try {
      await def.run(ctx);
      ctx.dbEnd();
      const failed = ctx.assertions.filter((a) => !a.passed);
      if (!ctx.assertions.length) {
        outcome = 'framework-error';
        failureCategory = 'Test-framework error';
        failureReason = 'Test produced no assertions; refusing to report a pass without evidence.';
        notRetriedBecause = 'framework errors are not resolved by retrying.';
      } else if (failed.length) {
        outcome = 'failed';
        failureCategory = 'Assertion failure';
        failureReason = failed.map((a) => `${a.name} (expected ${a.expected}; actual ${a.actual})`).join(' | ');
        retryable = true;
      } else {
        outcome = 'passed';
      }
    } catch (err) {
      ctx.dbEnd('interrupted by error');
      if (err instanceof BlockedError) {
        outcome = 'blocked';
        failureCategory = err.category;
        failureReason = err.message;
        notRetriedBecause = 'the blocking condition was established during run preparation and cannot be resolved by retrying this case.';
      } else if (err instanceof DependencyError) {
        outcome = 'dependency';
        failureCategory = 'Dependency unavailable';
        failureReason = err.message;
        retryable = true;
      } else if (err instanceof DbError && err.kind === 'connection') {
        outcome = 'connectivity';
        failureCategory = 'Database connectivity';
        failureReason = err.message;
        retryable = true;
      } else if (err instanceof DbError && err.kind === 'config') {
        outcome = 'blocked';
        failureCategory = 'Database configuration';
        failureReason = err.message;
        notRetriedBecause = 'missing database configuration is not resolved by retrying.';
      } else if (err instanceof TransportError) {
        outcome = 'connectivity';
        failureCategory = 'Connectivity';
        failureReason = err.message;
        retryable = true;
      } else {
        outcome = 'framework-error';
        failureCategory = 'Test-framework error';
        failureReason = `${err.name}: ${err.message}`;
        notRetriedBecause = 'framework errors are not resolved by retrying.';
      }
    }
    const labels = {
      passed: 'Passed',
      failed: 'Assertion failure',
      blocked: 'Blocked',
      dependency: 'Dependency unavailable',
      connectivity: 'Connectivity error',
      'framework-error': 'Test-framework error',
    };
    return {
      attempt: n,
      kind: n === 1 ? 'Initial attempt' : `Retry ${n - 1}`,
      startedAt,
      endedAt: new Date().toISOString(),
      outcome,
      outcomeLabel: labels[outcome],
      failureCategory,
      failureReason,
      failureStage: outcome === 'passed' ? '' : outcome === 'failed' ? (ctx.assertions.find((a) => !a.passed) || {}).stage || 'assertion' : ctx.stage,
      retryable,
      notRetriedBecause,
      assertions: ctx.assertions,
      requests: ctx.requests,
      dbQueries: ctx.dbQueries,
      inputs: ctx.inputs,
      notes: ctx.notes,
    };
  }

  _finalise(def, result) {
    const attempts = result.attempts;
    const last = attempts[attempts.length - 1];
    result.endedAt = new Date().toISOString();
    result.finalReason = last.failureReason;
    result.failureStage = last.failureStage;
    result.failureCategory = last.failureCategory;
    const earlierFailures = attempts.slice(0, -1).filter((a) => a.outcome !== 'passed');

    if (last.outcome === 'passed') {
      result.status = STATUS.PASSED;
      result.intermittent = earlierFailures.length > 0;
      if (result.intermittent) {
        result.intermittentNote = `Passed on attempt ${last.attempt} after ${earlierFailures.length} failed attempt(s); failure history preserved.`;
        this._addDefect(def, result, 'Unverified suspicion — intermittent failure', earlierFailures);
      }
    } else if (last.outcome === 'failed') {
      result.status = STATUS.FAILED;
      const reproducible = attempts.length === this.config.maxRetries + 1 && attempts.every((a) => a.outcome === 'failed') &&
        new Set(attempts.map((a) => a.assertions.filter((x) => !x.passed).map((x) => x.name).join('|'))).size === 1;
      let verification;
      if (result.retriesInterrupted) verification = 'Unverified suspicion — retries interrupted by stop';
      else if (!reproducible) verification = 'Unverified suspicion — failure not consistent across attempts';
      else if (def.defectBasis === 'contract' || def.defectBasis === 'documentation' || def.defectBasis === 'requirement') verification = `Confirmed defect — reproduced in ${attempts.length}/${attempts.length} attempts against ${def.defectBasis} evidence`;
      else verification = `Suspected defect — reproduced in ${attempts.length}/${attempts.length} attempts, but the expectation is derived (${def.defectBasis}) and needs human confirmation`;
      this._addDefect(def, result, verification, attempts);
    } else {
      result.status = STATUS.BLOCKED;
      result.blockedCategory = last.failureCategory;
    }
    this._log(def.id, 'case', 'info', `Test case completed after ${attempts.length} attempt(s).`);
    this._log(def.id, 'result', result.status === STATUS.PASSED ? 'pass' : result.status === STATUS.FAILED ? 'fail' : 'blocked',
      `Final result recorded: ${result.status}${result.intermittent ? ' (intermittent — earlier attempt(s) failed)' : ''}${result.status !== STATUS.PASSED ? ` — ${result.failureCategory}` : ''}.`);
    this.emit('case', result);
  }

  _addDefect(def, result, verification, failingAttempts) {
    const run = this.run;
    const ref = failingAttempts[failingAttempts.length - 1];
    const failed = ref.assertions.filter((a) => !a.passed);
    const bug = {
      bugId: `BUG-${run.runId.slice(4, 19)}-${String(run.defects.length + 1).padStart(2, '0')}`,
      caseId: def.id,
      endpoint: def.endpoint,
      summary: `${def.scenario}: ${failed.length ? failed.map((a) => a.name).join('; ') : ref.failureReason}`,
      expected: def.expected,
      expectedSource: def.evidence.join(' | '),
      actual: failed.map((a) => `${a.name}: ${a.actual}`).join(' | ') || ref.failureReason,
      failedAssertions: failed,
      stepsToReproduce: reproSteps(ref.requests, this.config.apiBaseUrl),
      requests: ref.requests,
      dbEvidence: failed.filter((a) => a.stage === 'db-validation'),
      dbQueries: ref.dbQueries || [],
      failureStage: ref.failureStage,
      severity: SEVERITY_UNASSIGNED,
      priority: SEVERITY_UNASSIGNED,
      retryHistory: result.attempts.map((a) => ({ attempt: a.attempt, kind: a.kind, outcome: a.outcomeLabel, at: a.startedAt, reason: a.failureReason })),
      verification,
      confirmed: verification.startsWith('Confirmed'),
    };
    run.defects.push(bug);
    result.bugId = bug.bugId;
    this._log(def.id, 'failure', bug.confirmed ? 'fail' : 'warn', `${bug.bugId} recorded: ${verification}.`);
  }

  summary() {
    if (!this.run) return null;
    const { logs, ...rest } = this.run;
    return { ...rest, stopRequested: this.stopRequested, logCount: logs.length };
  }
}

function reproSteps(requests, baseUrl) {
  if (!requests || !requests.length) return ['No HTTP request was completed in the failing attempt.'];
  return requests.map((r, i) => `${i + 1}. curl -s -i "${r.url}"   → observed HTTP ${r.status}${r.label ? ` (${r.label})` : ''}`)
    .concat([`Base URL: ${baseUrl}. No authentication headers are required for these read-only endpoints.`]);
}

module.exports = { Engine, STATUS, SEVERITY_UNASSIGNED };
