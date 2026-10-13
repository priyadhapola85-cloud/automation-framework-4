'use strict';
/**
 * Dashboard server: serves the UI, exposes a small JSON API, and streams live
 * execution events with Server-Sent Events. Binds to localhost by default.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { RateLimiter } = require('./rateLimiter');
const { HttpClient } = require('./httpClient');
const { discoverAll } = require('./discovery');
const { Engine } = require('./engine');
const { Store } = require('./store');
const { Database } = require('./db');
const { TestContext, BlockedError } = require('./context');
const { cases, effectiveCase, resolveParams } = require('./catalog');

const limiter = new RateLimiter({ maxPerWindow: config.rateLimitPerSecond, windowMs: 1000 });
const client = new HttpClient({ baseUrl: config.apiBaseUrl, limiter, timeoutMs: config.requestTimeoutMs });
const store = new Store(config.dataDir);
store.markInterrupted();
const db = new Database(config.db, limiter, (level, msg) => sysLog('database', level, msg));
/** Catalog with reviewer decisions applied (a decided Needs Validation case becomes executable). */
const effectiveCases = () => cases.map((d) => effectiveCase(d, store.validations[d.id]));
const engine = new Engine({ client, limiter, config, catalog: effectiveCases(), store, db });
const byId = new Map(cases.map((c) => [c.id, c]));

const state = { discovery: null, discoveryRunning: false, systemLogs: [], observations: {}, checks: {} };
const sseClients = new Set();
let sysSeq = 0;

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}
engine.on('log', (e) => broadcast('log', e));
engine.on('case', (r) => broadcast('case', r));
engine.on('run', (s) => broadcast('run', s));
engine.on('discovery', (d) => { state.discovery = { ...d, source: `run ${engine.run.runId}` }; broadcast('discovery', publicDiscovery()); });

function sysLog(stage, status, message, caseId = null) {
  const e = { seq: ++sysSeq, ts: new Date().toISOString(), runId: null, caseId, stage, status, message, system: true };
  state.systemLogs.push(e);
  if (state.systemLogs.length > 2000) state.systemLogs.shift();
  broadcast('log', e);
}

async function refreshDiscovery() {
  if (state.discoveryRunning) return;
  state.discoveryRunning = true;
  broadcast('discovery', publicDiscovery());
  sysLog('discovery', 'info', 'Discovery started: OpenAPI contract, service metadata and database access probes (read-only, rate-limited).');
  try {
    const d = await discoverAll(client, db, {
      retries: config.maxRetries,
      backoffMs: config.retryBackoffMs,
      onEvent: (e) => sysLog('discovery', e.error || e.status >= 500 ? 'warn' : 'info', e.db ? `DB query (${e.purpose}) → ${e.rows} row(s) in ${e.ms} ms` : e.error ? `GET ${e.path} (attempt ${e.attempt}) failed: ${e.error}` : `GET ${e.path} (attempt ${e.attempt}) → HTTP ${e.status} in ${e.durationMs} ms`),
    });
    state.discovery = { ...d, source: 'dashboard discovery' };
    sysLog('discovery', d.db.connected ? 'info' : 'warn', `Discovery completed. Contract available: ${d.api.contract.available}. Database: ${d.db.connected ? `connected to ${d.db.database} (${d.db.version})` : 'NOT connected — ' + d.db.error}.`);
  } catch (err) {
    sysLog('discovery', 'error', `Discovery error: ${err.message}`);
  } finally {
    state.discoveryRunning = false;
    broadcast('discovery', publicDiscovery());
  }
}

function publicDiscovery() {
  if (!state.discovery) return { running: state.discoveryRunning, available: false };
  const { spec, snapshot, ...rest } = state.discovery;
  return { running: state.discoveryRunning, available: true, dbConfig: config.dbPublic(), ...rest };
}

function environmentText() {
  return `Live API ${config.apiBaseUrl}; HTTP GET only (read-only); no auth header; MariaDB ${config.db.name || '(not configured)'} via ${config.db.ssh.enabled ? 'SSH tunnel' : 'direct TCP'}, read-only SELECT; shared limit ${config.rateLimitPerSecond} operation(s)/s (API + DB); timeout ${config.requestTimeoutMs} ms; up to ${config.maxRetries} retries (${config.maxRetries + 1} attempts); ${config.concurrency} worker(s); Node.js ${process.version}`;
}

function currentRun(runId) {
  if (runId && (!engine.run || engine.run.runId !== runId)) return store.loadRun(runId);
  if (engine.run) return engine.run;
  const latest = store.listRuns()[0];
  return latest ? store.loadRun(latest.runId) : null;
}

function decisionMeta(def) {
  if (!def.decisions) return undefined;
  return def.decisions.map((o) => {
    const { params } = resolveParams(o, {});
    return { id: o.id, label: o.label(params), expected: o.expected(params), assertion: o.assertion(params), params: o.params || [] };
  });
}

function caseView(def, run) {
  const { run: _r, observe: _o, decisions: _d, ...meta } = def;
  const approval = store.approvalFor(def);
  const result = run && run.results[def.id];
  return {
    ...meta,
    environment: environmentText(),
    preconditions: def.dataSource,
    approval: def.validation === 'needs-validation' && approval.status !== 'rejected' ? { ...approval, status: 'needs-validation' } : approval,
    executable: def.validation === 'automated',
    result: result || null,
    observations: state.observations[def.id] || [],
    decisionOptions: decisionMeta(def),
    reviewerDecision: def.reviewerDecision || null,
    checks: state.checks[def.id] || [],
  };
}

/** Preview check: runs one decision option once against the live API/DB. Not part of any run. */
async function previewCheck(def, option, params) {
  if (!state.discovery || !state.discovery.spec) throw Object.assign(new Error('Discovery has not produced a contract yet; refresh discovery first.'), { code: 503 });
  const label = option.label(params);
  const log = (stage, status, msg) => sysLog(stage === 'request' || stage === 'response' ? 'check' : stage, status, msg, def.id);
  const ctx = new TestContext({ client, caseDef: def, attempt: 1, prep: { spec: state.discovery.spec, discovery: state.discovery, runId: 'CHECK', db, dbConfig: config.db }, refCache: new Map(), log });
  sysLog('check', 'info', `Preview check started for expected behaviour "${label}" (not part of an automation run).`, def.id);
  const rec = { at: new Date().toISOString(), optionId: option.id, label, expected: option.expected(params), outcome: null, reason: '' };
  try {
    await option.run(ctx, params);
    const failed = ctx.assertions.filter((a) => !a.passed);
    rec.outcome = !ctx.assertions.length ? 'Error' : failed.length ? 'Failed' : 'Passed';
    rec.reason = failed.map((a) => `${a.name}: expected ${a.expected}; actual ${a.actual}`).join(' | ');
  } catch (err) {
    rec.outcome = err instanceof BlockedError ? 'Blocked' : 'Error';
    rec.reason = err.message;
  }
  Object.assign(rec, { assertions: ctx.assertions, requests: ctx.requests, dbQueries: ctx.dbQueries, notes: ctx.notes, inputs: ctx.inputs });
  (state.checks[def.id] = state.checks[def.id] || []).unshift(rec);
  state.checks[def.id] = state.checks[def.id].slice(0, 5);
  sysLog('check', rec.outcome === 'Passed' ? 'pass' : rec.outcome === 'Failed' ? 'fail' : 'warn', `Preview check result: ${rec.outcome}${rec.reason ? ' — ' + rec.reason.slice(0, 300) : ''}`, def.id);
  return rec;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(config.publicDir, rel);
  if (!file.startsWith(config.publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

async function observe(def) {
  if (!state.discovery || !state.discovery.spec) throw Object.assign(new Error('Discovery has not produced a contract yet; refresh discovery first.'), { code: 503 });
  const log = (stage, status, msg) => sysLog(stage === 'request' || stage === 'response' ? 'observation' : stage, status, msg, def.id);
  const ctx = new TestContext({ client, caseDef: def, attempt: 1, prep: { spec: state.discovery.spec, discovery: state.discovery, runId: 'OBSERVE', db, dbConfig: config.db }, refCache: new Map(), log });
  sysLog('observation', 'info', 'Observation started (no assertions are executed; status remains Needs Validation).', def.id);
  const rec = { at: new Date().toISOString(), requests: [], notes: [], error: null };
  try {
    await def.observe(ctx);
  } catch (err) {
    rec.error = err instanceof BlockedError ? `Blocked: ${err.message}` : `${err.name}: ${err.message}`;
  }
  rec.requests = ctx.requests;
  rec.dbQueries = ctx.dbQueries;
  rec.notes = ctx.notes;
  rec.inputs = ctx.inputs;
  (state.observations[def.id] = state.observations[def.id] || []).unshift(rec);
  state.observations[def.id] = state.observations[def.id].slice(0, 5);
  sysLog('observation', rec.error ? 'warn' : 'info', `Observation recorded${rec.error ? ' with error: ' + rec.error : ''}.`, def.id);
  return rec;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }
    if (req.method === 'GET' && p === '/api/info') {
      return send(res, 200, { config: { db: config.dbPublic(), apiBaseUrl: config.apiBaseUrl, rateLimitPerSecond: config.rateLimitPerSecond, maxRetries: config.maxRetries, concurrency: config.concurrency, requestTimeoutMs: config.requestTimeoutMs, environment: environmentText() }, discovery: publicDiscovery() });
    }
    if (req.method === 'POST' && p === '/api/discovery/refresh') {
      if (engine.isActive()) return send(res, 409, { error: 'A run is active; its preparation already performs discovery.' });
      refreshDiscovery();
      return send(res, 202, { started: true });
    }
    if (req.method === 'GET' && p === '/api/cases') {
      const run = currentRun(url.searchParams.get('runId'));
      return send(res, 200, { runId: run ? run.runId : null, cases: effectiveCases().map((d) => caseView(d, run)) });
    }
    if (req.method === 'POST' && p === '/api/approvals') {
      const body = await readBody(req);
      const decision = body.decision;
      if (!['approved', 'rejected', 'pending'].includes(decision)) return send(res, 400, { error: 'decision must be approved, rejected or pending' });
      const updated = [];
      const skipped = [];
      const eff = new Map(effectiveCases().map((c) => [c.id, c]));
      for (const id of Array.isArray(body.ids) ? body.ids : []) {
        const def = eff.get(id);
        if (!def) { skipped.push({ id, reason: 'unknown case' }); continue; }
        if (decision === 'approved' && def.validation !== 'automated') { skipped.push({ id, reason: 'Needs Validation cases cannot be approved for execution until their expected behaviour is established' }); continue; }
        store.setApproval(def, decision, typeof body.comment === 'string' ? body.comment.slice(0, 1000) : '');
        updated.push(id);
      }
      broadcast('approvals', { updated, decision });
      return send(res, 200, { updated, skipped });
    }
    if (req.method === 'POST' && p === '/api/runs') {
      const eff = effectiveCases();
      const approved = eff.filter((d) => d.validation === 'automated' && store.approvalFor(d).status === 'approved').map((d) => d.id);
      try {
        engine.setCatalog(eff);
        return send(res, 202, engine.start(approved));
      } catch (err) {
        return send(res, err.code === 409 ? 409 : 400, { error: err.message });
      }
    }
    if (req.method === 'POST' && p === '/api/runs/stop') {
      const stopping = engine.stop();
      return send(res, stopping ? 202 : 409, stopping ? { stopping: true } : { error: 'No active run' });
    }
    if (req.method === 'GET' && p === '/api/runs') {
      return send(res, 200, { active: engine.isActive() ? engine.run.runId : null, runs: store.listRuns() });
    }
    const m = /^\/api\/runs\/(RUN-[\w-]+)$/.exec(p);
    if (req.method === 'GET' && (p === '/api/runs/current' || m)) {
      const run = currentRun(m ? m[1] : null);
      if (!run) return send(res, 200, { run: null, systemLogs: state.systemLogs });
      const live = engine.run && run.runId === engine.run.runId;
      return send(res, 200, { run: { ...run, stopRequested: live ? engine.stopRequested : false }, systemLogs: state.systemLogs });
    }
    if (req.method === 'POST' && (p === '/api/validations' || p === '/api/validations/check')) {
      const body = await readBody(req);
      const def = byId.get(body.caseId);
      if (!def || !def.decisions) return send(res, 404, { error: 'This case has no expected-behaviour options' });
      if (p === '/api/validations' && body.optionId === null) {
        if (engine.isActive()) return send(res, 409, { error: 'A run is active; try again after it ends' });
        store.setValidation(def.id, null);
        sysLog('validation', 'info', 'Reviewer decision cleared; case is Needs Validation again.', def.id);
        broadcast('approvals', { updated: [def.id] });
        return send(res, 200, { cleared: true });
      }
      const option = def.decisions.find((o) => o.id === body.optionId);
      if (!option) return send(res, 400, { error: 'Unknown option' });
      const { params, error } = resolveParams(option, body.params || {});
      if (error) return send(res, 400, { error });
      if (p === '/api/validations/check') {
        try {
          return send(res, 200, await previewCheck(def, option, params));
        } catch (err) {
          if (err.code === 503) return send(res, 503, { error: err.message });
          throw err;
        }
      }
      if (engine.isActive()) return send(res, 409, { error: 'A run is active; try again after it ends' });
      const comment = typeof body.comment === 'string' ? body.comment.slice(0, 1000) : '';
      store.setValidation(def.id, { optionId: option.id, params, comment, at: new Date().toISOString() });
      sysLog('validation', 'info', `Reviewer requirement saved: "${option.label(params)}". Case is now executable and Pending Review.`, def.id);
      broadcast('approvals', { updated: [def.id] });
      return send(res, 200, { saved: true });
    }
    const o = /^\/api\/observe\/([\w-]+)$/.exec(p);
    if (req.method === 'POST' && o) {
      const def = byId.get(o[1]);
      if (!def || !def.observe) return send(res, 404, { error: 'No observation defined for this case' });
      try {
        return send(res, 200, await observe(def));
      } catch (err) {
        if (err.code === 503) return send(res, 503, { error: err.message });
        throw err;
      }
    }
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(req, res, p);
    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    sysLog('server', 'error', `Request handling error on ${req.method} ${p}: ${err.message}`);
    return send(res, 500, { error: err.message });
  }
});

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    console.log(`API QA dashboard: http://${config.host}:${config.port}`);
    console.log(`Target API: ${config.apiBaseUrl} (GET only, ${config.rateLimitPerSecond} req/s)`);
    refreshDiscovery();
  });
  const shutdown = () => { db.close().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { server, engine, limiter, store };
