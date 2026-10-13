'use strict';
/**
 * Unit tests for the framework's OWN logic (rate limiter, read-only client,
 * redaction/masking, schema validator, engine retry/classification/stop).
 *
 * DISCLOSURE: the engine tests use a local in-process HTTP server that returns
 * fixture responses. These fixtures exist only to exercise framework code paths
 * (e.g. an intermittent failure) deterministically. They are never sent to the
 * dashboard and never represent results of testing the real Streamer API.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { RateLimiter } = require('../src/rateLimiter');
const { HttpClient, redactHeaders, maskPII } = require('../src/httpClient');
const { validate } = require('../src/schemaValidator');
const { Engine } = require('../src/engine');
const { Store } = require('../src/store');
const { cases } = require('../src/catalog');

test('rate limiter: concurrent callers never exceed 2 grants in any 1-second window', async () => {
  const limiter = new RateLimiter({ maxPerWindow: 2, windowMs: 1000 });
  const start = Date.now();
  // 3 "workers" + "retries" competing: 9 acquisitions issued at once.
  await Promise.all(Array.from({ length: 9 }, (_, i) => limiter.acquire(`caller-${i}`)));
  const times = limiter.grants.map((g) => g.t);
  assert.equal(times.length, 9);
  assert.ok(RateLimiter.maxInAnyWindow(times, 1000) <= 2, `max in window ${RateLimiter.maxInAnyWindow(times, 1000)}`);
  for (let i = 2; i < times.length; i++) assert.ok(times[i] - times[i - 2] >= 1000, `grant ${i} too early`);
  assert.ok(Date.now() - start >= 4000, '9 grants at 2/s must take at least 4 s');
});

test('rate limiter: maxInAnyWindow counts sliding windows', () => {
  assert.equal(RateLimiter.maxInAnyWindow([0, 500, 999, 1000, 1999], 1000), 3);
  assert.equal(RateLimiter.maxInAnyWindow([0, 1000, 2000], 1000), 1);
});

test('http client refuses non-GET methods (read-only)', async () => {
  const c = new HttpClient({ baseUrl: 'http://127.0.0.1:9', limiter: new RateLimiter() });
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) await assert.rejects(c.request(m, '/x'), /read-only/);
});

test('secrets are redacted and PII is masked in evidence', () => {
  assert.deepEqual(redactHeaders({ 'X-API-Token': 'abc', Authorization: 'Bearer x', Accept: 'json' }), { 'X-API-Token': '[REDACTED]', Authorization: '[REDACTED]', Accept: 'json' });
  const m = maskPII([{ phone: '+91-9876543210', email: 'someone@example.com', name: 'n', details: '{"phone":"91+8764562907"}' }]);
  assert.equal(m[0].phone, '+91*********10');
  assert.equal(m[0].email, 's***@example.com');
  assert.equal(m[0].name, 'n');
  assert.ok(!m[0].details.includes('8764562'));
});

test('schema validator: required, enum, anyOf null, nested $ref, date-time', () => {
  const root = { components: { schemas: {
    Loc: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    S: { type: 'object', required: ['id', 'tier', 'loc'], properties: {
      id: { type: 'string' }, tier: { type: 'string', enum: ['gold'] }, email: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      loc: { $ref: '#/components/schemas/Loc' }, created_at: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
    } },
  } } };
  const ref = { $ref: '#/components/schemas/S' };
  assert.deepEqual(validate(ref, { id: '1', tier: 'gold', email: null, loc: { id: 1 }, created_at: '2026-10-01T20:46:15' }, root), []);
  const errs = validate(ref, { id: 1, tier: 'tin', loc: { id: '1' }, created_at: 'yesterday' }, root);
  assert.equal(errs.length, 4, errs.join('\n'));
});

test('catalog: unique IDs, every case has evidence, NV cases have no run()', () => {
  const ids = cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of cases) {
    assert.ok(c.evidence.length, `${c.id} evidence`);
    assert.ok(c.expected && c.assertionLogic && c.steps.length, `${c.id} fields`);
    if (c.validation === 'needs-validation') {
      assert.equal(c.run, undefined, `${c.id} must not have assertions`);
      assert.ok(c.nvReason, `${c.id} nvReason`);
    } else assert.equal(typeof c.run, 'function', `${c.id} run`);
  }
});

test('DB field comparison (TC-DB-003 logic) on fixture rows: type-aware, FK mapping, detects mismatches', () => {
  const { compareRows, sameValue } = require('../src/catalog');
  const checks = [];
  const ctx = { note() {}, block(m) { throw new Error(m); }, check: (n, p, o) => checks.push({ n, p, o }), maskField: (f, v) => v };
  const col = (name, dataType, nullable = false) => ({ name, dataType, type: dataType, nullable });
  const table = {
    columns: [col('id', 'varchar'), col('name', 'varchar'), col('tier', 'enum'), col('total_calls', 'int'), col('pickup_rate', 'float'), col('created_at', 'datetime', true), col('location_id', 'int')],
    foreignKeys: [{ name: 'fk_loc', column: 'location_id', refTable: 'locations', refColumn: 'id' }],
  };
  const api = [{ id: '1', name: 'a', tier: 'gold', total_calls: 3, pickup_rate: 72.3, created_at: '2026-10-01T20:46:15', location: { id: 2 } }];
  const rows = [{ id: '1', name: 'a', tier: 'silver', total_calls: 3, pickup_rate: 72.30000305, created_at: '2026-10-01 20:46:15', location_id: 2 }];
  compareRows(ctx, api, rows, table);
  assert.equal(checks[0].p, true, 'id sets match');
  const fieldCheck = checks.find((c) => c.n.startsWith('id 1'));
  assert.equal(fieldCheck.p, false);
  assert.match(fieldCheck.o.actual, /^tier: API "gold" vs DB tier "silver"$/, 'only tier differs (float tolerance, datetime normalisation, FK mapping applied)');
  assert.equal(sameValue(72.3, 72.4, col('x', 'float')), false, 'float tolerance is not loose');
  assert.equal(sameValue(null, null, col('x', 'varchar', true)), true);
});

test('reviewer decision turns a Needs Validation case into an executable requirement', () => {
  const { cases, effectiveCase, resolveParams } = require('../src/catalog');
  const nvCases = cases.filter((c) => c.validation === 'needs-validation');
  assert.ok(nvCases.every((c) => Array.isArray(c.decisions) && c.decisions.length), 'every NV case offers expected-behaviour options');
  const def = cases.find((c) => c.id === 'TC-LST-031');
  assert.equal(effectiveCase(def, null), def, 'no decision → unchanged');
  const eff = effectiveCase(def, { optionId: 'threshold', params: { ms: 250 }, at: 'now', comment: '' });
  assert.equal(eff.validation, 'automated');
  assert.equal(eff.defectBasis, 'requirement');
  assert.match(eff.expected, /250 ms/);
  assert.equal(typeof eff.run, 'function');
  assert.ok(resolveParams(def.decisions[0], { ms: -5 }).error, 'out-of-range parameter rejected');
  assert.ok(resolveParams(cases.find((c) => c.id === 'TC-DB-011').decisions[0], { pattern: '(' }).error, 'invalid regex rejected');
});

test('db layer refuses non read-only SQL', async () => {
  const { Database } = require('../src/db');
  const d = new Database({ name: 'x', user: 'u', password: 'p', host: 'h', port: 1, ssh: { enabled: false } }, new RateLimiter());
  for (const sql of ['DELETE FROM streamers', 'UPDATE streamers SET name = 1', 'SELECT 1; DROP TABLE x', 'INSERT INTO t VALUES (1)']) {
    await assert.rejects(d.query(sql), /only single read-only/);
  }
});

// ---------------------------------------------------------------- engine (local fixture server)
function fixtureServer() {
  let flaky = 0;
  const contract = { openapi: '3.1.0', info: { title: 'fixture', version: '0' }, paths: {}, components: { schemas: {} } };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/openapi.json') return json(200, contract);
    if (u.pathname === '/health') return json(200, { streamers_count: 0 });
    if (u.pathname === '/flaky') return (++flaky === 1 ? json(500, {}) : json(200, { ok: true }));
    if (u.pathname === '/ok') return json(200, { ok: true });
    if (u.pathname === '/slow') return setTimeout(() => json(200, { ok: true }), 300);
    return json(500, {});
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function makeEngine(srv, defs) {
  const limiter = new RateLimiter({ maxPerWindow: 100, windowMs: 1000 });
  const client = new HttpClient({ baseUrl: `http://127.0.0.1:${srv.address().port}`, limiter, timeoutMs: 3000 });
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-store-')));
  const config = { apiBaseUrl: client.baseUrl, maxRetries: 3, retryBackoffMs: 0, rateLimitPerSecond: 100, concurrency: 1, requestTimeoutMs: 3000 };
  const base = { validation: 'automated', defectBasis: 'contract', scenario: 's', endpoint: 'e', expected: 'x', evidence: ['fixture'], steps: ['s'] };
  return new Engine({ client, limiter, config, catalog: defs.map((d) => ({ ...base, ...d })), store });
}
const finished = (engine) => new Promise((r) => engine.on('run', (s) => { if (s.status !== 'running') r(s); }));

test('engine: intermittent failure passes with history; consistent failure confirmed after 4 attempts; blocked not retried', async () => {
  const srv = await fixtureServer();
  const engine = makeEngine(srv, [
    { id: 'F-1', async run(ctx) { const r = await ctx.get('/flaky'); ctx.checkStatus(r, 200, 'fixture'); } },
    { id: 'F-2', async run(ctx) { const r = await ctx.get('/always500'); ctx.checkStatus(r, 200, 'fixture'); } },
    { id: 'F-3', async run(ctx) { ctx.block('no access', 'Database access'); } },
    { id: 'F-4', async run() { /* no assertions */ } },
  ]);
  const done = finished(engine);
  engine.start(['F-1', 'F-2', 'F-3', 'F-4']);
  assert.throws(() => engine.start(['F-1']), /already active/);
  await done;
  const r = engine.run.results;
  assert.equal(r['F-1'].status, 'Passed');
  assert.equal(r['F-1'].intermittent, true);
  assert.equal(r['F-1'].attempts.length, 2);
  assert.equal(r['F-1'].attempts[0].outcome, 'failed');
  assert.equal(r['F-2'].status, 'Failed');
  assert.equal(r['F-2'].attempts.length, 4);
  assert.equal(r['F-2'].retryCount, 3);
  assert.equal(r['F-3'].status, 'Blocked');
  assert.equal(r['F-3'].attempts.length, 1);
  assert.equal(r['F-4'].status, 'Blocked', 'a case with no assertions must never pass');
  const f2bug = engine.run.defects.find((d) => d.caseId === 'F-2');
  assert.ok(f2bug.confirmed);
  const f1bug = engine.run.defects.find((d) => d.caseId === 'F-1');
  assert.ok(f1bug && !f1bug.confirmed, 'intermittent issue is an unverified suspicion');
  assert.equal(engine.run.status, 'completed');
  srv.close();
});

test('engine: stop prevents new cases and preserves results', async () => {
  const srv = await fixtureServer();
  const defs = Array.from({ length: 6 }, (_, i) => ({ id: `S-${i}`, async run(ctx) { const r = await ctx.get('/slow'); ctx.checkStatus(r, 200, 'fixture'); } }));
  const engine = makeEngine(srv, defs);
  const done = finished(engine);
  engine.start(defs.map((d) => d.id));
  await new Promise((r) => engine.on('case', (c) => { if (c.status === 'Passed') r(); }));
  engine.stop();
  const s = await done;
  assert.equal(s.status, 'stopped');
  const statuses = Object.values(engine.run.results).map((x) => x.status);
  assert.ok(statuses.includes('Passed'));
  assert.ok(statuses.includes('Not Executed'));
  assert.ok(engine.run.partial);
  srv.close();
});

test('engine: refuses to start without approved executable cases', () => {
  const engine = makeEngine({ address: () => ({ port: 9 }) }, [{ id: 'N-1', validation: 'needs-validation' }]);
  assert.throws(() => engine.start([]), /No approved/);
  assert.throws(() => engine.start(['N-1']), /No approved/);
});
