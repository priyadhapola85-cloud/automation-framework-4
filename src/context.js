'use strict';
/**
 * Per-attempt execution context handed to each test case's run() function.
 * Records every request/response as evidence, every assertion with its
 * expected/actual values, generated (synthetic) inputs, and the current stage.
 */
const { toEvidence, maskField, maskPII } = require('./httpClient');
const { validate } = require('./schemaValidator');
const { LIST_PATH } = require('./discovery');

/** Execution cannot proceed for a reason retrying will not fix (missing access, config, data). */
class BlockedError extends Error {
  constructor(message, category = 'Dependency unavailable') {
    super(message);
    this.name = 'BlockedError';
    this.category = category;
  }
}
/** Reference/dependency data temporarily unavailable; retryable. */
class DependencyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DependencyError';
  }
}

const isDbPath = (p) => p.startsWith('/api/v1/db/') || p === '/health';
const DB_SAMPLE_ROWS = 3;

class TestContext {
  constructor({ client, caseDef, attempt, prep, refCache, log }) {
    this.client = client;
    this.caseDef = caseDef;
    this.attempt = attempt;
    this.prep = prep; // run preparation: { spec, discovery, runId, db }
    this.refCache = refCache;
    this.localRefs = new Map();
    this.log = log;
    this.requests = [];
    this.dbQueries = [];
    this.assertions = [];
    this.inputs = [];
    this.notes = [];
    this.stage = 'setup';
    this.dbActive = false;
  }

  get spec() {
    if (!this.prep.spec) throw new BlockedError('OpenAPI contract was not available during run preparation', 'Missing contract');
    return this.prep.spec;
  }

  /** Resolved schema of a documented parameter (from the live contract). */
  param(path, name) {
    const op = this.spec.paths[path] && this.spec.paths[path].get;
    const p = op && (op.parameters || []).find((x) => x.name === name);
    if (!p) throw new BlockedError(`Parameter "${name}" is not documented for GET ${path} in the live contract`, 'Missing contract');
    return p.schema || {};
  }

  /** Enum values of a parameter whose schema is anyOf[$ref enum, null]. */
  paramEnum(path, name) {
    const s = this.param(path, name);
    const parts = s.anyOf || [s];
    for (const part of parts) {
      const target = part.$ref ? part.$ref.slice(2).split('/').reduce((n, k) => n && n[k], this.spec) : part;
      if (target && target.enum) return target.enum;
    }
    throw new BlockedError(`No enum documented for parameter "${name}"`, 'Missing contract');
  }

  schemaRef(name) {
    if (!this.spec.components.schemas[name]) throw new BlockedError(`Schema ${name} missing from contract`, 'Missing contract');
    return { $ref: `#/components/schemas/${name}` };
  }

  setStage(stage) {
    this.stage = stage;
  }

  async get(path, { query, headers, label } = {}) {
    const prev = this.stage;
    this.stage = 'request';
    const kind = isDbPath(path) ? 'DB request' : 'API request';
    const onSend = (p) => this.log('request', 'info', `${kind} sent: GET ${p.length > 160 ? p.slice(0, 157) + '…' : p}${label ? ' — ' + label : ''}`);
    const r = await this.client.get(path, { query, headers, label: `${this.caseDef.id} ${label || ''}`.trim(), onSend });
    const ev = toEvidence(r);
    ev.label = label || '';
    this.requests.push(ev);
    this.log('response', r.status >= 500 ? 'warn' : 'info', `Response received: HTTP ${r.status} in ${r.durationMs} ms${r.jsonError ? ' (body is not valid JSON)' : ''}`);
    this.stage = prev === 'request' ? 'assertion' : prev;
    return r;
  }

  /** Records an assertion. Does not throw; the engine fails the attempt if any check failed. */
  check(name, passed, { expected, actual, source } = {}) {
    if (this.stage === 'setup' || this.stage === 'request') this.stage = 'assertion';
    const a = { name, passed: !!passed, expected: fmt(expected), actual: fmt(actual), source: source || '', stage: this.dbActive ? 'db-validation' : 'assertion' };
    this.assertions.push(a);
    this.log('assertion', passed ? 'pass' : 'fail', `Assertion ${passed ? 'passed' : 'FAILED'}: ${name}${passed ? '' : ` — expected ${a.expected}; actual ${a.actual}`}`);
    return !!passed;
  }

  checkStatus(r, expected, source) {
    return this.check(`HTTP status is ${expected}`, r.status === expected, { expected, actual: r.status, source });
  }

  checkJsonContentType(r, source) {
    const ct = r.headers['content-type'] || '';
    return this.check('Content-Type is application/json', /^application\/json\b/i.test(ct), { expected: 'application/json', actual: ct || '(none)', source });
  }

  checkSchema(name, schema, value, source) {
    const errors = validate(schema, value, this.spec);
    return this.check(`Response conforms to ${name}`, errors.length === 0, {
      expected: `0 schema violations against ${name}`,
      actual: errors.length ? `${errors.length} violation(s): ${errors.slice(0, 8).join('; ')}${errors.length > 8 ? ' …' : ''}` : '0 violations',
      source,
    });
  }

  /** 422 + HTTPValidationError body shape (the contract's declared validation-error response). */
  check422(r, source) {
    this.checkStatus(r, 422, source);
    if (r.status === 422) {
      this.checkSchema('HTTPValidationError', this.schemaRef('HTTPValidationError'), r.json, 'OpenAPI: 422 response schema HTTPValidationError');
      const locs = r.json && Array.isArray(r.json.detail) ? r.json.detail.map((d) => (d.loc || []).join('.')).join(', ') : '';
      this.note(`Observed validation error location(s): ${locs || '(none)'} — informational, not asserted (contract does not define loc values).`);
    }
  }

  block(message, category) {
    throw new BlockedError(message, category);
  }

  /** Discloses a generated (synthetic) input used for negative testing. */
  input(label, value, note) {
    this.inputs.push({ label, value: String(value).length > 120 ? String(value).slice(0, 117) + '…' : String(value), note: note || 'Generated test input — not a business record' });
  }

  note(message) {
    this.notes.push(message);
  }

  dbStart(description) {
    this.dbActive = true;
    this.stage = 'db-validation';
    this.log('db-validation', 'info', `Database validation started: ${description}`);
  }

  dbEnd(summary = '') {
    if (!this.dbActive) return;
    this.dbActive = false;
    this.log('db-validation', 'info', `Database validation completed${summary ? ': ' + summary : ''}`);
    this.stage = 'assertion';
  }

  /** Reference data shared within a run; refreshed when a case is retried. */
  async ref(name) {
    if (this.localRefs.has(name)) return this.localRefs.get(name);
    const prev = this.stage;
    this.stage = 'reference-data';
    let entry;
    if (this.attempt === 1 && this.refCache.has(name)) {
      entry = await this.refCache.get(name);
      // Attach the evidence of the original fetch so this case's result is self-contained.
      for (const ev of entry.evidence) this.requests.push({ ...ev, label: `${ev.label} [reused reference data, fetched by ${entry.fetchedBy}]` });
      for (const ev of entry.dbEvidence) this.dbQueries.push({ ...ev, purpose: `${ev.purpose} [reused reference data, fetched by ${entry.fetchedBy}]` });
      this.note(`Reference data "${name}" reused from earlier in this run (fetched by ${entry.fetchedBy} at ${entry.at}).`);
    } else {
      const before = this.requests.length;
      const beforeDb = this.dbQueries.length;
      const p = this._fetchRef(name).then((value) => ({ value, evidence: this.requests.slice(before), dbEvidence: this.dbQueries.slice(beforeDb), fetchedBy: `${this.caseDef.id} attempt ${this.attempt}`, at: new Date().toISOString() }));
      this.refCache.set(name, p);
      p.catch(() => this.refCache.delete(name));
      entry = await p;
    }
    this.stage = prev;
    this.localRefs.set(name, entry.value);
    return entry.value;
  }

  /** Throws a retryable dependency error (e.g. reference data temporarily inconsistent). */
  dependency(message) {
    throw new DependencyError(message);
  }

  async _fetchRef(name) {
    switch (name) {
      case 'listing': {
        const max = this.param(LIST_PATH, 'limit').maximum;
        if (!Number.isInteger(max)) this.block('Contract does not define a maximum for "limit"; cannot page through the full listing', 'Missing contract');
        const all = [];
        for (let skip = 0; skip < 100000; skip += max) {
          const r = await this.get(LIST_PATH, { query: { skip, limit: max }, label: `reference: full listing page skip=${skip}` });
          if (r.status !== 200 || !Array.isArray(r.json)) throw new DependencyError(`Reference listing unavailable: GET ${r.path} returned HTTP ${r.status}`);
          all.push(...r.json);
          if (r.json.length < max) break;
        }
        return all;
      }
      case 'db:count':
        return Number((await this.dbQuery('SELECT COUNT(*) AS n FROM streamers', [], 'streamers row count'))[0].n);
      case 'db:streamers':
        return this.dbQuery('SELECT * FROM streamers ORDER BY id LIMIT ?', [this.prep.dbConfig.snapshotRowLimit], 'streamers rows (real data)');
      case 'db:locations':
        return this.dbQuery('SELECT * FROM locations ORDER BY id', [], 'locations rows (real data)');
      case 'db:earnings':
        return this.dbQuery('SELECT id, streamer_id, date, total, bonus_amount FROM earnings ORDER BY id', [], 'earnings rows (real data)');
      case 'db:audit':
        return this.dbQuery("SELECT id, action, resource_type, resource_id, details, created_at FROM audit_log WHERE resource_type = 'streamer' ORDER BY id", [], 'audit_log streamer events (full history)');
      default:
        throw new Error(`Unknown reference "${name}"`);
    }
  }

  /** Blocks unless the real database was reachable during run preparation. */
  requireDb() {
    const d = this.prep.discovery.db;
    if (!this.prep.db || !d.connected) this.block(`Database not reachable during run preparation: ${d.error || 'not connected'}`, 'Database access');
    return d;
  }

  /** Discovered table metadata; blocks if the table does not exist. */
  dbTable(name) {
    const d = this.requireDb();
    const t = d.tables.find((x) => x.name === name);
    if (!t) this.block(`Table "${name}" not found in database ${d.database}`, 'Database access');
    return t;
  }

  /** Rate-limited read-only query; recorded as evidence (PII masked, sample rows only). */
  async dbQuery(sql, params, purpose) {
    this.requireDb();
    const prev = this.stage;
    this.stage = 'db-query';
    this.log('db-query', 'info', `DB query sent: ${purpose}`);
    const r = await this.prep.db.query(sql, params, `${this.caseDef.id} ${purpose}`);
    this.dbQueries.push({ purpose, sql: r.sql, params: r.params, rows: r.rows.length, ms: r.ms, at: r.at, sample: JSON.stringify(maskPII(r.rows.slice(0, DB_SAMPLE_ROWS))) });
    this.log('db-query', 'info', `DB result received: ${r.rows.length} row(s) in ${r.ms} ms`);
    this.stage = prev;
    return r.rows;
  }

  maskField(field, value) {
    return maskField(field, value);
  }
}

function fmt(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  const s = JSON.stringify(v);
  return s.length > 600 ? s.slice(0, 597) + '...' : s;
}

module.exports = { TestContext, BlockedError, DependencyError };
