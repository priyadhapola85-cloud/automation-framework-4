'use strict';
/**
 * API and database discovery against the live system.
 *
 * API discovery: GET /openapi.json (contract) and GET / (service metadata).
 * Database discovery: the SQLite file lives on the API host and is not directly
 * reachable, so the only database access available is through the server's own
 * read-only inspection endpoints (/health row counts, /api/v1/db/*). Each probe's
 * real HTTP outcome is recorded; nothing is filled in when a probe fails.
 */
const { TransportError } = require('./httpClient');

const LIST_PATH = '/api/v1/streamers';
const ITEM_PATH = '/api/v1/streamers/{streamer_id}';

async function probe(client, path, { query, retries = 0, backoffMs = 1000, label, onEvent } = {}) {
  const attempts = [];
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await client.get(path, { query, label: label || `discovery ${path}` });
      attempts.push({ at: new Date(r.sentAt).toISOString(), status: r.status, durationMs: r.durationMs });
      onEvent && onEvent({ path: r.path, status: r.status, durationMs: r.durationMs, attempt: i + 1 });
      if (r.status < 500 || i === retries) {
        return { ok: r.status === 200 && r.json !== undefined, status: r.status, json: r.json, bodyText: r.json === undefined ? r.bodyText.slice(0, 300) : undefined, attempts, path: r.path };
      }
    } catch (err) {
      if (!(err instanceof TransportError)) throw err;
      attempts.push({ at: new Date().toISOString(), error: err.message });
      onEvent && onEvent({ path, error: err.message, attempt: i + 1 });
      if (i === retries) return { ok: false, status: null, error: err.message, attempts, path };
    }
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  return { ok: false, status: null, attempts, path };
}

function describeParam(p, spec) {
  let schema = p.schema || {};
  const enums = [];
  const types = [];
  const collect = (s) => {
    if (!s) return;
    if (s.$ref) s = s.$ref.slice(2).split('/').reduce((n, k) => n && n[k], spec);
    if (s.anyOf) return s.anyOf.forEach(collect);
    if (s.type) types.push(s.type);
    if (s.enum) enums.push(...s.enum);
  };
  collect(schema);
  return {
    name: p.name,
    in: p.in,
    required: !!p.required,
    type: [...new Set(types)].join(' | '),
    enum: enums.length ? enums : undefined,
    minimum: schema.minimum,
    maximum: schema.maximum,
    default: schema.default,
    description: p.description || schema.description || '',
    example: p.example,
  };
}

function summariseOperation(spec, path, method) {
  const op = spec.paths && spec.paths[path] && spec.paths[path][method];
  if (!op) return null;
  const responses = Object.entries(op.responses || {}).map(([code, r]) => {
    const schema = r.content && r.content['application/json'] && r.content['application/json'].schema;
    let schemaName = '';
    if (schema) schemaName = schema.$ref ? schema.$ref.split('/').pop() : schema.type === 'array' && schema.items && schema.items.$ref ? `array<${schema.items.$ref.split('/').pop()}>` : schema.type || '';
    return { code, description: r.description, contentTypes: Object.keys(r.content || {}), schema: schemaName };
  });
  return {
    method: method.toUpperCase(),
    path,
    summary: op.summary,
    description: op.description,
    parameters: (op.parameters || []).map((p) => describeParam(p, spec)),
    responses,
    security: op.security || spec.security || null,
  };
}

/** Extracts "Allowed: a, b, c" table names documented on /api/v1/db/rows/{table_name}. */
function documentedTables(spec) {
  const op = spec && spec.paths && spec.paths['/api/v1/db/rows/{table_name}'] && spec.paths['/api/v1/db/rows/{table_name}'].get;
  const p = op && (op.parameters || []).find((x) => x.name === 'table_name');
  const m = p && /Allowed:\s*([a-z0-9_,\s]+)/i.exec(p.description || '');
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function documentedDbLocation(spec) {
  const m = /\bin a \*\*(\w+)\*\* file at `([^`]+)`/i.exec((spec && spec.info && spec.info.description) || '');
  return m ? { engine: m[1], file: m[2] } : null;
}

async function discoverApi(client, { retries, backoffMs, onEvent }) {
  const contract = await probe(client, '/openapi.json', { retries, backoffMs, onEvent, label: 'discovery: OpenAPI contract' });
  const service = await probe(client, '/', { retries, backoffMs, onEvent, label: 'discovery: service metadata' });
  const spec = contract.ok ? contract.json : null;
  const result = {
    contract: {
      available: !!spec,
      status: contract.status,
      error: contract.error,
      url: client.baseUrl + '/openapi.json',
      openapi: spec && spec.openapi,
      title: spec && spec.info && spec.info.title,
      version: spec && spec.info && spec.info.version,
    },
    service: service.ok ? service.json : { status: service.status, error: service.error },
    docsUrls: { swagger: client.baseUrl + '/docs', redoc: client.baseUrl + '/redoc', openapi: client.baseUrl + '/openapi.json' },
    endpoints: spec ? [summariseOperation(spec, LIST_PATH, 'get'), summariseOperation(spec, ITEM_PATH, 'get')].filter(Boolean) : [],
    otherOperations: spec ? Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)).filter((s) => s !== `GET ${LIST_PATH}` && s !== `GET ${ITEM_PATH}`) : [],
  };
  return { result, spec };
}


/** Tables whose ROW DATA is never read (they hold credentials); only column names are listed. */
const SENSITIVE_TABLES = new Set(['users']);
/** Tables whose row counts are read during discovery. */
const COUNTED_TABLES = ['streamers', 'locations', 'earnings', 'audit_log'];

/**
 * Discovers the real MariaDB/MySQL schema through information_schema (read-only,
 * rate-limited). Nothing is filled in when a query fails; the error is recorded.
 */
async function discoverDb(db, spec, { onEvent } = {}) {
  const result = {
    engine: 'MariaDB/MySQL',
    documentedBySwagger: documentedDbLocation(spec),
    documentedTables: documentedTables(spec),
    configured: false,
    connected: false,
    error: null,
    version: null,
    database: null,
    tables: [],
    relationships: [],
    queries: [],
  };
  if (!db) { result.error = 'No database client'; return finish(result); }
  const why = db.notConfigured();
  if (why) { result.error = why; return finish(result); }
  result.configured = true;
  const q = async (sql, purpose, params = []) => {
    const r = await db.query(sql, params, `discovery: ${purpose}`);
    result.queries.push({ purpose, sql: r.sql, rows: r.rows.length, ms: r.ms, at: r.at });
    onEvent && onEvent({ db: true, purpose, rows: r.rows.length, ms: r.ms });
    return r.rows;
  };
  try {
    const [v] = await q('SELECT VERSION() AS version, DATABASE() AS db', 'server version');
    result.connected = true;
    result.version = v.version;
    result.database = v.db;
    const tables = await q('SELECT TABLE_NAME AS t, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME', 'tables');
    const cols = await q('SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, DATA_TYPE AS dataType, IS_NULLABLE AS nullable, COLUMN_KEY AS keyType, COLUMN_DEFAULT AS def, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION', 'columns');
    const cons = await q('SELECT k.TABLE_NAME AS t, k.COLUMN_NAME AS c, k.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS type, k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refColumn FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND tc.TABLE_NAME = k.TABLE_NAME AND tc.CONSTRAINT_NAME = k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA = DATABASE() ORDER BY k.TABLE_NAME, k.ORDINAL_POSITION', 'keys and constraints');
    let checks = [];
    try {
      checks = await q('SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS name, CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()', 'check constraints');
    } catch (e) {
      result.checkConstraintsError = e.message;
    }
    const present = new Set(tables.map((t) => t.t));
    const counted = COUNTED_TABLES.filter((t) => present.has(t));
    const counts = counted.length
      ? (await q(`SELECT ${counted.map((t) => `(SELECT COUNT(*) FROM \`${t}\`) AS \`${t}\``).join(', ')}`, 'row counts'))[0]
      : {};
    result.tables = tables.map((t) => {
      const c = cols.filter((x) => x.t === t.t);
      const k = cons.filter((x) => x.t === t.t);
      return {
        name: t.t,
        engine: t.engine,
        sensitive: SENSITIVE_TABLES.has(t.t),
        rowCount: counts[t.t] !== undefined ? Number(counts[t.t]) : null,
        columns: c.map((x) => ({
          name: x.c, type: x.type, dataType: x.dataType, nullable: x.nullable === 'YES', key: x.keyType, default: x.def, extra: x.extra,
          enum: x.dataType === 'enum' ? (x.type.match(/'((?:[^']|'')*)'/g) || []).map((s) => s.slice(1, -1).replace(/''/g, "'")) : undefined,
        })),
        primaryKey: k.filter((x) => x.type === 'PRIMARY KEY').map((x) => x.c),
        unique: k.filter((x) => x.type === 'UNIQUE').map((x) => ({ name: x.name, column: x.c })),
        foreignKeys: k.filter((x) => x.type === 'FOREIGN KEY').map((x) => ({ name: x.name, column: x.c, refTable: x.refTable, refColumn: x.refColumn })),
        checks: checks.filter((x) => x.t === t.t).map((x) => ({ name: x.name, clause: x.clause })),
      };
    });
    result.relationships = result.tables.flatMap((t) => t.foreignKeys.map((f) => ({ from: `${t.name}.${f.column}`, to: `${f.refTable}.${f.refColumn}`, constraint: f.name })));
  } catch (e) {
    result.error = `${e.kind ? '[' + e.kind + '] ' : ''}${e.message}`;
  }
  return finish(result);
}

function finish(r) {
  r.access = r.connected && r.tables.length ? 'full (read-only)' : 'none';
  r.table = (name) => r.tables.find((t) => t.name === name);
  return r;
}

async function discoverAll(client, db, { retries = 3, backoffMs = 1000, onEvent } = {}) {
  const startedAt = new Date().toISOString();
  const { result: api, spec } = await discoverApi(client, { retries, backoffMs, onEvent });
  const dbResult = await discoverDb(db, spec, { onEvent });
  return { startedAt, finishedAt: new Date().toISOString(), baseUrl: client.baseUrl, api, db: dbResult, spec };
}

module.exports = { discoverAll, discoverDb, probe, LIST_PATH, ITEM_PATH, documentedTables, SENSITIVE_TABLES };
