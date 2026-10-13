'use strict';
/**
 * Test case catalog for:
 *   E1  GET /api/v1/streamers
 *   E2  GET /api/v1/streamers/{streamer_id}
 *
 * Evidence sources:
 *  - the live OpenAPI/Swagger contract (/openapi.json, /docs) and its documentation text;
 *  - the real MariaDB database `streamer_api` (read-only SELECTs through the SSH tunnel):
 *    information_schema for schema/keys, and streamers/locations/earnings/audit_log rows.
 *
 * Rules applied when writing every case:
 *  - Expected results come only from the contract, its documentation text, or the database.
 *    Boundaries/enums are read from the live contract at run time; expected record sets,
 *    counts and non-existence are computed from the database at run time.
 *  - Generated inputs used for negative tests are disclosed via ctx.input().
 *  - Where the evidence does not establish an expectation, the case is
 *    validation: 'needs-validation' and has no assertions (observe() only).
 *  - The `users` table (credentials) is never read.
 */
const { LIST_PATH: L } = require('./discovery');

const ITEM = '/api/v1/streamers/{streamer_id}';
const item = (id) => `/api/v1/streamers/${encodeURIComponent(id)}`;

const SRC = {
  oasList: 'Swagger/OpenAPI contract /openapi.json — GET /api/v1/streamers (parameters, 200 array<StreamerOut>, 422 HTTPValidationError)',
  oasItem: 'Swagger/OpenAPI contract /openapi.json — GET /api/v1/streamers/{streamer_id} (path param string, 200 StreamerOut, 404 ErrorResponse, 422)',
  oasStreamerOut: 'Swagger/OpenAPI schema components.schemas.StreamerOut / LocationOut / TierEnum / StatusEnum',
  docList: 'Swagger documentation (operation description): "All filters are AND-combined. If you pass no filters, you get the first `limit` streamers."',
  docCity: 'Swagger documentation: city parameter "Filter by city (case-insensitive)"',
  docItem: 'Swagger documentation (operation description): "Fetch a single streamer by their unique ID. Returns a 404 if the ID doesn\'t exist."',
  docAuth: 'Swagger documentation: "Authentication (optional for read endpoints)"; contract declares no security requirement for these operations',
  dbSchema: 'MariaDB streamer_api — information_schema (columns, types, nullability, PRIMARY KEY / UNIQUE / FOREIGN KEY)',
  dbStreamers: 'MariaDB streamer_api.streamers rows (read-only SELECT via SSH tunnel)',
  dbCount: 'MariaDB: SELECT COUNT(*) FROM streamers',
  dbLocations: 'MariaDB streamer_api.locations rows + declared FK streamers.location_id → locations.id',
  dbEarnings: 'MariaDB streamer_api.earnings rows + declared FK earnings.streamer_id → streamers.id',
  dbAudit: 'MariaDB streamer_api.audit_log (full write history: action, resource_id, details JSON)',
};

// ---------------------------------------------------------------- helpers
const ids = (arr) => arr.map((s) => String(s.id));
const sortedIds = (arr) => ids(arr).slice().sort();
const sameSet = (a, b) => a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const dupes = (arr) => arr.filter((x, i) => arr.indexOf(x) !== i);

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}
const deepEqual = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function diffFields(a, b, mask) {
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])];
  return keys.filter((k) => !deepEqual(a[k], b[k])).map((k) => `${k}: ${JSON.stringify(mask(k, a[k]))} vs ${JSON.stringify(mask(k, b[k]))}`);
}

/** Fetches every page for a query using the contract's maximum page size. */
async function fetchAllPages(ctx, query, label) {
  const max = ctx.param(L, 'limit').maximum;
  const items = [];
  const responses = [];
  for (let skip = 0; skip < 100000; skip += max) {
    const r = await ctx.get(L, { query: { ...query, skip, limit: max }, label });
    responses.push(r);
    if (r.status !== 200 || !Array.isArray(r.json)) break;
    items.push(...r.json);
    if (r.json.length < max) break;
  }
  return { items, responses, allOk: responses.every((r) => r.status === 200 && Array.isArray(r.json)) };
}

async function dbRows(ctx) {
  ctx.dbTable('streamers');
  return ctx.ref('db:streamers');
}

async function firstDbRecord(ctx) {
  const rows = await dbRows(ctx);
  if (!rows.length) ctx.block('The streamers table is empty; a real record is required', 'Test data unavailable');
  return rows[0];
}

/** Locations by id, joined through the FK declared in the database. */
async function locationsById(ctx) {
  const t = ctx.dbTable('streamers');
  const fk = t.foreignKeys.find((f) => f.column === 'location_id' && f.refTable === 'locations');
  if (!fk) ctx.block('No FOREIGN KEY streamers.location_id → locations declared; location relationship not established', 'Database access');
  ctx.dbTable('locations');
  const locs = await ctx.ref('db:locations');
  return new Map(locs.map((l) => [Number(l.id), l]));
}

/** Requires that the named streamers column exists (mapping by identical name). */
function requireColumn(ctx, table, column) {
  const c = ctx.dbTable(table).columns.find((x) => x.name === column);
  if (!c) ctx.block(`Column ${table}.${column} not found; API↔DB mapping not established`, 'Database access');
  return c;
}

/** Proves `id` does not exist using a direct database query. */
async function provenAbsent(ctx, id) {
  ctx.dbTable('streamers');
  const rows = await ctx.dbQuery('SELECT COUNT(*) AS n FROM streamers WHERE id = ?', [id], 'non-existence check for generated ID');
  if (Number(rows[0].n) !== 0) ctx.block(`Generated ID "${id.slice(0, 40)}" exists in the database; cannot use it as non-existent`, 'Test data unavailable');
  ctx.note(`Non-existence of "${id.length > 40 ? id.slice(0, 37) + '…' : id}" proven in the database (SELECT COUNT(*) … WHERE id = ? → 0).`);
}

async function absentEightDigitId(ctx) {
  const existing = new Set(ids(await dbRows(ctx)));
  let n = 99999999;
  while (existing.has(String(n))) n--;
  return String(n);
}

// ---- API ↔ DB value comparison (types taken from the discovered column definitions)
const NUMERIC_FLOAT = new Set(['float', 'double', 'decimal']);
const NUMERIC_INT = new Set(['int', 'bigint', 'smallint', 'mediumint', 'tinyint']);
const DATETIME = new Set(['datetime', 'timestamp', 'date']);
const normDt = (s) => String(s).replace(' ', 'T').replace(/\.0+$/, '');

/** Compares an API value with a DB value using the column's declared type. */
function sameValue(apiV, dbV, col) {
  if (apiV === null || apiV === undefined || dbV === null || dbV === undefined) return (apiV === undefined ? null : apiV) === (dbV === undefined ? null : dbV);
  if (NUMERIC_FLOAT.has(col.dataType)) {
    // FLOAT is single precision (~7 significant digits) — relative tolerance 1e-6 follows from the column type.
    const a = Number(apiV);
    const b = Number(dbV);
    return Math.abs(a - b) <= (col.dataType === 'float' ? Math.max(1e-6, Math.abs(b) * 1e-6) : 1e-9);
  }
  if (NUMERIC_INT.has(col.dataType)) return Number(apiV) === Number(dbV);
  if (DATETIME.has(col.dataType)) return normDt(apiV) === normDt(dbV);
  return String(apiV) === String(dbV);
}

/** Mapping API field ↔ column: identical names, plus location.id ↔ location_id when the FK is declared. */
function buildMapping(apiRecord, table) {
  const cols = new Map(table.columns.map((c) => [c.name, c]));
  const mapping = Object.keys(apiRecord).filter((f) => cols.has(f) && (apiRecord[f] === null || typeof apiRecord[f] !== 'object')).map((f) => ({ api: f, col: cols.get(f) }));
  const fk = table.foreignKeys.find((f) => f.column === 'location_id' && f.refTable === 'locations');
  if (fk && cols.has('location_id') && apiRecord.location && typeof apiRecord.location === 'object') mapping.push({ api: 'location.id', col: cols.get('location_id'), via: fk.name });
  return mapping;
}

function compareRecord(ctx, rec, row, mapping) {
  const diffs = [];
  for (const m of mapping) {
    const av = m.api.includes('.') ? m.api.split('.').reduce((o, k) => o && o[k], rec) : rec[m.api];
    const dv = row[m.col.name];
    if (!sameValue(av, dv, m.col)) diffs.push(`${m.api}: API ${JSON.stringify(ctx.maskField(m.api, av))} vs DB ${m.col.name} ${JSON.stringify(ctx.maskField(m.col.name, dv))}`);
  }
  return diffs;
}

/** E1 records vs DB rows, field by field. Exported for unit tests. */
function compareRows(ctx, apiRecords, rows, table) {
  if (!apiRecords.length) ctx.block('API returned no records to compare', 'Test data unavailable');
  const mapping = buildMapping(apiRecords[0], table);
  const apiFields = Object.keys(apiRecords[0]);
  ctx.note(`Field mapping (identical column names${mapping.some((m) => m.via) ? '; location.id via FK ' + mapping.find((m) => m.via).via : ''}): ${mapping.map((m) => `${m.api}↔${m.col.name}`).join(', ')}. Unmapped API fields: ${apiFields.filter((f) => !mapping.some((m) => m.api === f || m.api.startsWith(f + '.'))).join(', ') || 'none'}. Unmapped columns: ${table.columns.map((c) => c.name).filter((c) => !mapping.some((m) => m.col.name === c)).join(', ') || 'none'}.`);
  if (!mapping.some((m) => m.api === 'id')) ctx.block('No id column to match rows to API records', 'Database access');
  ctx.check('Every DB row has an API record and vice versa', sameSet(ids(apiRecords), ids(rows)), { expected: sortedIds(rows), actual: sortedIds(apiRecords), source: SRC.dbStreamers });
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const rec of apiRecords) {
    const row = byId.get(String(rec.id));
    if (!row) continue;
    const diffs = compareRecord(ctx, rec, row, mapping);
    ctx.check(`id ${rec.id}: mapped fields equal DB row`, diffs.length === 0, { expected: 'all mapped fields equal', actual: diffs.join('; ') || 'equal', source: `${SRC.dbStreamers}; ${SRC.dbSchema}` });
  }
}

// ---------------------------------------------------------------- catalog
const cases = [];
const tc = (def) => cases.push({ validation: 'automated', defectBasis: 'contract', ...def });
const nv = (def) => cases.push({ validation: 'needs-validation', defectBasis: 'none', ...def });

const STEPS_422 = (param, value) => [
  `Send GET ${L}?${param}=${value} (no other parameters).`,
  'Capture status, headers and body.',
  'Assert HTTP 422 and validate the body against HTTPValidationError.',
];

// ===== E1: collection endpoint ===========================================
tc({
  id: 'TC-LST-001', category: 'Positive', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Default request succeeds', description: 'Request the collection with no query parameters.',
  related: 'Endpoint (no parameters)', dataSource: 'Live API; no input data required.',
  steps: [`Send GET ${L} with no query parameters.`, 'Assert status code and that the body parses as a JSON array.'],
  expected: 'HTTP 200 with a JSON array body (contract response 200: array of StreamerOut).',
  assertionLogic: 'status === 200 AND Array.isArray(JSON.parse(body)). Automatic.',
  evidence: [SRC.oasList],
  async run(ctx) {
    const r = await ctx.get(L, { label: 'no parameters' });
    ctx.checkStatus(r, 200, SRC.oasList);
    ctx.check('Body is a JSON array', Array.isArray(r.json), { expected: 'JSON array', actual: r.jsonError ? `invalid JSON: ${r.jsonError}` : Array.isArray(r.json) ? `array(${r.json.length})` : typeof r.json, source: SRC.oasList });
  },
});

tc({
  id: 'TC-LST-002', category: 'Schema', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Every record conforms to StreamerOut', description: 'Retrieve the complete listing (paging with the contract maximum limit) and validate every record against the StreamerOut schema, including nested LocationOut, enums, nullable fields and date-time fields.',
  related: 'StreamerOut: id, name, phone, email?, location{city,state,id,...}, tier, status, total_earnings_inr, total_calls, pickup_rate, created_at?, updated_at?',
  dataSource: 'All real streamer records returned by the live API.',
  steps: [`Page through GET ${L}?skip=N&limit=<contract maximum> until a short page.`, 'Validate each record against components.schemas.StreamerOut from the live contract.'],
  expected: 'Every record satisfies StreamerOut: required properties present; types, enums and nullability as declared.',
  assertionLogic: 'Schema validator (required, type, enum, anyOf/null, $ref, ISO-8601 date-time parse) returns 0 violations for the whole array. additionalProperties is not enforced (not declared). Automatic.',
  evidence: [SRC.oasList, SRC.oasStreamerOut],
  async run(ctx) {
    const listing = await ctx.ref('listing');
    if (!listing.length) ctx.block('No records to validate', 'Test data unavailable');
    ctx.checkSchema(`array<StreamerOut> (${listing.length} records)`, { type: 'array', items: ctx.schemaRef('StreamerOut') }, listing, SRC.oasStreamerOut);
  },
});

tc({
  id: 'TC-LST-003', category: 'Headers', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Success response Content-Type', description: 'Check the Content-Type header of a successful collection response.',
  related: 'Response header Content-Type', dataSource: 'Live API.',
  steps: [`Send GET ${L}?limit=1.`, 'Read the Content-Type response header.'],
  expected: 'HTTP 200 with Content-Type application/json (the only media type the contract declares for 200).',
  assertionLogic: 'status === 200 AND /^application\\/json/i.test(content-type). Automatic.',
  evidence: [SRC.oasList],
  async run(ctx) {
    const r = await ctx.get(L, { query: { limit: 1 } });
    ctx.checkStatus(r, 200, SRC.oasList);
    ctx.checkJsonContentType(r, SRC.oasList);
  },
});

tc({
  id: 'TC-LST-004', category: 'Pagination', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Default page size', description: 'Without parameters the endpoint returns the first `limit` streamers, where limit defaults to the contract default; bounded by the number of rows in the streamers table.',
  related: 'Query param limit (default); streamers table row count',
  dataSource: 'Live API + MariaDB COUNT(*) of streamers.',
  steps: ['Read limit.default from the live contract.', 'SELECT COUNT(*) FROM streamers.', `GET ${L} with no parameters.`, 'Compare array length with min(default, row count).'],
  expected: 'HTTP 200 and array length = min(contract default for limit, streamers row count).',
  assertionLogic: 'r.json.length === Math.min(limitSchema.default, dbCount). Automatic.',
  evidence: [SRC.oasList, SRC.docList, SRC.dbCount],
  async run(ctx) {
    const def = ctx.param(L, 'limit').default;
    if (!Number.isInteger(def)) ctx.block('Contract does not declare a default for limit', 'Missing contract');
    const total = await ctx.ref('db:count');
    const r = await ctx.get(L, { label: 'no parameters' });
    ctx.checkStatus(r, 200, SRC.oasList);
    ctx.dbStart('compare default page size with streamers row count');
    const expected = Math.min(def, total);
    ctx.check(`Record count = min(default ${def}, DB rows ${total})`, Array.isArray(r.json) && r.json.length === expected, { expected, actual: Array.isArray(r.json) ? r.json.length : 'not an array', source: `${SRC.oasList}; ${SRC.dbCount}` });
    ctx.dbEnd();
  },
});

for (const [id, which] of [['TC-LST-005', 'minimum'], ['TC-LST-006', 'maximum']]) {
  tc({
    id, category: 'Boundary', endpoint: 'E1 GET /api/v1/streamers',
    scenario: `limit at documented ${which}`, description: `Send limit equal to the contract's documented ${which} (valid boundary).`,
    related: `Query param limit (${which})`, dataSource: 'Live API + MariaDB COUNT(*) of streamers.',
    steps: [`Read limit.${which} from the live contract.`, `GET ${L}?limit=<${which}>.`, 'Compare array length with min(limit, DB row count).'],
    expected: `HTTP 200 and array length = min(limit ${which}, streamers row count).`,
    assertionLogic: 'status === 200 AND length === Math.min(boundary, dbCount). Automatic.',
    evidence: [SRC.oasList, SRC.dbCount],
    async run(ctx) {
      const v = ctx.param(L, 'limit')[which];
      if (!Number.isInteger(v)) ctx.block(`Contract does not declare limit.${which}`, 'Missing contract');
      const total = await ctx.ref('db:count');
      const r = await ctx.get(L, { query: { limit: v } });
      ctx.checkStatus(r, 200, SRC.oasList);
      const expected = Math.min(v, total);
      ctx.check(`Record count = min(${v}, DB rows ${total})`, Array.isArray(r.json) && r.json.length === expected, { expected, actual: Array.isArray(r.json) ? r.json.length : 'not an array', source: `${SRC.oasList}; ${SRC.dbCount}` });
    },
  });
}

for (const [id, label, valueFn, note] of [
  ['TC-LST-007', 'limit below minimum', (s) => s.minimum - 1, 'minimum − 1'],
  ['TC-LST-008', 'limit above maximum', (s) => s.maximum + 1, 'maximum + 1'],
  ['TC-LST-009', 'limit non-numeric', () => 'abc', 'non-numeric string'],
  ['TC-LST-010', 'limit decimal', () => '1.5', 'decimal value'],
]) {
  tc({
    id, category: 'Negative', endpoint: 'E1 GET /api/v1/streamers',
    scenario: `${label} is rejected`, description: `Send limit = ${note}; the contract types limit as an integer with minimum/maximum.`,
    related: 'Query param limit', dataSource: `Generated invalid input (${note}).`,
    steps: STEPS_422('limit', `<${note}>`),
    expected: 'HTTP 422 with an HTTPValidationError body (contract-declared validation error; docs: "422 Unprocessable — Wrong field types").',
    assertionLogic: 'status === 422 AND body validates against HTTPValidationError. Error loc/msg text recorded but not asserted. Automatic.',
    evidence: [SRC.oasList, 'Swagger documentation error-code table: 422 = wrong field types / missing required'],
    async run(ctx) {
      const v = valueFn(ctx.param(L, 'limit'));
      if (typeof v === 'number' && Number.isNaN(v)) ctx.block('Contract boundary for limit not declared', 'Missing contract');
      ctx.input('limit', v, `Generated invalid input (${note}) — not a business record`);
      const r = await ctx.get(L, { query: { limit: v } });
      ctx.check422(r, SRC.oasList);
    },
  });
}

tc({
  id: 'TC-LST-011', category: 'Boundary', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'skip at documented minimum equals default', description: 'skip = contract minimum (which is also the declared default) must return the same records as omitting skip.',
  related: 'Query param skip (minimum/default)', dataSource: 'Live API.',
  steps: [`GET ${L} (no params).`, `GET ${L}?skip=<minimum>.`, 'Compare the ID sequences.'],
  expected: 'Both HTTP 200 with identical record IDs.',
  assertionLogic: 'Both status 200 AND ids(withSkip) deep-equals ids(default). Automatic.',
  evidence: [SRC.oasList],
  async run(ctx) {
    const s = ctx.param(L, 'skip');
    if (s.minimum !== s.default) ctx.block('Contract skip minimum differs from default; this case assumes they are equal', 'Missing contract');
    const a = await ctx.get(L, { label: 'default' });
    const b = await ctx.get(L, { query: { skip: s.minimum } });
    ctx.checkStatus(a, 200, SRC.oasList);
    ctx.checkStatus(b, 200, SRC.oasList);
    const ia = Array.isArray(a.json) ? ids(a.json) : null;
    const ib = Array.isArray(b.json) ? ids(b.json) : null;
    ctx.check('Same IDs with skip=minimum as with default', ia && ib && JSON.stringify(ia) === JSON.stringify(ib), { expected: ia, actual: ib, source: SRC.oasList });
  },
});

for (const [id, label, valueFn, note] of [
  ['TC-LST-012', 'skip below minimum', (s) => s.minimum - 1, 'minimum − 1'],
  ['TC-LST-013', 'skip non-numeric', () => 'abc', 'non-numeric string'],
]) {
  tc({
    id, category: 'Negative', endpoint: 'E1 GET /api/v1/streamers',
    scenario: `${label} is rejected`, description: `Send skip = ${note}; the contract types skip as an integer with a minimum.`,
    related: 'Query param skip', dataSource: `Generated invalid input (${note}).`,
    steps: STEPS_422('skip', `<${note}>`),
    expected: 'HTTP 422 with an HTTPValidationError body.',
    assertionLogic: 'status === 422 AND body validates against HTTPValidationError. Automatic.',
    evidence: [SRC.oasList],
    async run(ctx) {
      const v = valueFn(ctx.param(L, 'skip'));
      ctx.input('skip', v, `Generated invalid input (${note}) — not a business record`);
      const r = await ctx.get(L, { query: { skip: v } });
      ctx.check422(r, SRC.oasList);
    },
  });
}

tc({
  id: 'TC-LST-014', category: 'Boundary', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'skip beyond last record returns empty page', description: 'skip equal to the number of streamer rows in the database leaves no records to return.',
  related: 'Query param skip; streamers row count', dataSource: 'Live API + MariaDB COUNT(*) of streamers.',
  steps: ['SELECT COUNT(*) FROM streamers.', `GET ${L}?skip=<row count>&limit=<maximum>.`],
  expected: 'HTTP 200 with an empty JSON array.',
  assertionLogic: 'status === 200 AND body is []. Automatic.',
  evidence: [SRC.oasList, SRC.dbCount],
  async run(ctx) {
    const total = await ctx.ref('db:count');
    const r = await ctx.get(L, { query: { skip: total, limit: ctx.param(L, 'limit').maximum } });
    ctx.checkStatus(r, 200, SRC.oasList);
    ctx.check('Body is an empty array', Array.isArray(r.json) && r.json.length === 0, { expected: '[]', actual: Array.isArray(r.json) ? `array(${r.json.length})` : r.bodyText.slice(0, 80), source: `${SRC.oasList}; ${SRC.dbCount}` });
  },
});

tc({
  id: 'TC-LST-015', category: 'Pagination', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Small pages reassemble every database record', description: 'Walk the collection with a small page size (limit=3) and compare the union with the streamers table.',
  related: 'Query params skip + limit; streamers.id', dataSource: 'MariaDB streamers ids (real data).',
  steps: ['SELECT * FROM streamers.', `Fetch pages GET ${L}?skip=0,3,6…&limit=3 until a short page.`, 'Compare.'],
  expected: 'Every page HTTP 200 with ≤3 records; the union of pages has no duplicate IDs and exactly the database ID set.',
  assertionLogic: 'all statuses 200; every page length ≤ 3; duplicates(pageIds) = []; sameSet(pageIds, dbIds). Ordering is not asserted (not documented). Automatic.',
  evidence: [SRC.oasList, SRC.dbStreamers],
  async run(ctx) {
    const rows = await dbRows(ctx);
    const dbIds = ids(rows);
    const pageIds = [];
    let ok = true;
    let maxLen = 0;
    for (let skip = 0; skip <= dbIds.length + 3; skip += 3) {
      const r = await ctx.get(L, { query: { skip, limit: 3 }, label: `page skip=${skip}` });
      if (r.status !== 200 || !Array.isArray(r.json)) { ok = false; ctx.checkStatus(r, 200, SRC.oasList); break; }
      maxLen = Math.max(maxLen, r.json.length);
      pageIds.push(...ids(r.json));
      if (r.json.length < 3) break;
    }
    ctx.check('All pages returned HTTP 200 arrays', ok, { expected: true, actual: ok });
    ctx.check('No page exceeds limit=3', maxLen <= 3, { expected: '≤ 3', actual: maxLen });
    ctx.check('No duplicate IDs across pages', dupes(pageIds).length === 0, { expected: [], actual: dupes(pageIds) });
    ctx.dbStart('pages vs streamers table');
    ctx.check('Pages cover exactly the database records', sameSet(pageIds, dbIds), { expected: `${dbIds.length} ids`, actual: `${pageIds.length} ids; missing=${JSON.stringify(dbIds.filter((x) => !pageIds.includes(x)))}; extra=${JSON.stringify(pageIds.filter((x) => !dbIds.includes(x)))}`, source: SRC.dbStreamers });
    ctx.dbEnd();
  },
});

tc({
  id: 'TC-LST-016', category: 'Data integrity', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Streamer IDs are unique', description: 'Every record in the complete listing has a distinct id (contract: "Unique streamer ID"; DB: streamers.id is the PRIMARY KEY).',
  related: 'StreamerOut.id; streamers PRIMARY KEY', dataSource: 'All records returned by the API.',
  steps: ['Fetch the complete listing.', 'Count duplicate id values.'],
  expected: 'No duplicate id values.',
  assertionLogic: 'duplicates(ids(listing)).length === 0. Automatic.',
  evidence: [SRC.oasStreamerOut + ' — id described as "Unique streamer ID"', SRC.dbSchema + ' — PRIMARY KEY (id)'],
  async run(ctx) {
    const listing = await ctx.ref('listing');
    const d = dupes(ids(listing));
    ctx.check('No duplicate IDs', d.length === 0, { expected: [], actual: d, source: 'StreamerOut.id description; streamers PRIMARY KEY' });
  },
});

for (const [id, param] of [['TC-LST-017', 'status'], ['TC-LST-018', 'tier']]) {
  tc({
    id, category: 'Filter', endpoint: 'E1 GET /api/v1/streamers',
    scenario: `${param} filter — every enum value`, description: `For each ${param} enum value in the contract, the filtered result must contain exactly the database rows with that ${param}.`,
    related: `Query param ${param}; streamers.${param} (DB ENUM)`, dataSource: 'MariaDB streamers rows; enum values from the live contract.',
    steps: [`Read the ${param} enum from the contract.`, `SELECT * FROM streamers.`, `For each value v: GET ${L}?${param}=v (paged).`, `Compare with DB rows WHERE ${param} = v.`],
    expected: `HTTP 200 for each value; every returned record has ${param} = v; the returned ID set equals the DB rows with ${param} = v (including the empty set).`,
    assertionLogic: `status 200; every(r.${param} === v); sameSet(ids(api), ids(dbRows.filter(${param} === v))). Automatic.`,
    evidence: [SRC.oasList, SRC.docList, SRC.dbStreamers],
    async run(ctx) {
      const values = ctx.paramEnum(L, param);
      requireColumn(ctx, 'streamers', param);
      const rows = await dbRows(ctx);
      for (const v of values) {
        const { items, responses, allOk } = await fetchAllPages(ctx, { [param]: v }, `${param}=${v}`);
        ctx.check(`${param}=${v}: HTTP 200`, allOk, { expected: 200, actual: responses.map((r) => r.status).join(','), source: SRC.oasList });
        const wrong = items.filter((r) => r[param] !== v);
        ctx.check(`${param}=${v}: all records match`, wrong.length === 0, { expected: `all ${param}=${v}`, actual: wrong.length ? `non-matching ids ${JSON.stringify(ids(wrong))}` : `${items.length} matching` });
        const exp = rows.filter((r) => r[param] === v);
        ctx.dbStart(`expected set for ${param}=${v} from streamers`);
        ctx.check(`${param}=${v}: equals DB rows with ${param}=${v}`, sameSet(ids(items), ids(exp)), { expected: sortedIds(exp), actual: sortedIds(items), source: `${SRC.docList}; ${SRC.dbStreamers}` });
        ctx.dbEnd();
      }
    },
  });
}

tc({
  id: 'TC-LST-019', category: 'Filter', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'city filter — every city that has streamers', description: 'For each distinct, non-blank city linked to a streamer in the database (through the FK streamers.location_id → locations.id), filtering by that city returns every streamer in that city and nothing unrelated.',
  related: 'Query param city; locations.city via FK', dataSource: 'MariaDB streamers + locations rows.',
  steps: ['SELECT streamers and locations; join on the declared FK.', 'Collect distinct non-blank cities.', `For each city c: GET ${L}?city=c (paged).`, 'Compare with the DB join.'],
  expected: 'HTTP 200; every DB streamer whose city equals c (case-insensitive) is returned; every returned record\'s city contains c (case-insensitive).',
  assertionLogic: 'status 200; expected ⊆ returned; every returned city.toLowerCase().includes(c.toLowerCase()). Exact-vs-substring semantics are NOT assumed (see TC-LST-028). Automatic.',
  evidence: [SRC.oasList, SRC.docCity, SRC.dbLocations],
  async run(ctx) {
    const rows = await dbRows(ctx);
    const locs = await locationsById(ctx);
    const cityOf = (r) => { const l = locs.get(Number(r.location_id)); return l ? String(l.city) : null; };
    const cities = [...new Set(rows.map(cityOf).filter((c) => typeof c === 'string' && c.trim()))];
    if (!cities.length) ctx.block('No non-blank cities linked to streamers in the database', 'Test data unavailable');
    for (const c of cities) {
      const { items, responses, allOk } = await fetchAllPages(ctx, { city: c }, `city=${c}`);
      ctx.check(`city=${c}: HTTP 200`, allOk, { expected: 200, actual: responses.map((r) => r.status).join(','), source: SRC.oasList });
      const exp = rows.filter((r) => (cityOf(r) || '').toLowerCase() === c.toLowerCase());
      const missing = ids(exp).filter((x) => !ids(items).includes(x));
      ctx.dbStart(`expected set for city=${c} from streamers ⋈ locations`);
      ctx.check(`city=${c}: all DB streamers in that city returned`, missing.length === 0, { expected: sortedIds(exp), actual: `missing ${JSON.stringify(missing)}`, source: `${SRC.docCity}; ${SRC.dbLocations}` });
      ctx.dbEnd();
      const unrelated = items.filter((r) => !(r.location && String(r.location.city).toLowerCase().includes(c.toLowerCase())));
      ctx.check(`city=${c}: no unrelated cities returned`, unrelated.length === 0, { expected: 'none', actual: unrelated.map((r) => `${r.id}:${r.location && r.location.city}`) });
    }
  },
});

tc({
  id: 'TC-LST-020', category: 'Filter', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'city filter is case-insensitive', description: 'The same city in original, lower and upper case must return the same records.',
  related: 'Query param city', dataSource: 'A real city taken from the database (first streamer whose city has letters).',
  steps: ['Pick a real city c from the DB join.', `GET ${L}?city=c, ?city=lower(c), ?city=UPPER(c).`, 'Compare the three ID sets.'],
  expected: 'All HTTP 200 and identical ID sets.',
  assertionLogic: 'status 200 ×3; sameSet(original, lower) AND sameSet(original, upper). Automatic.',
  evidence: [SRC.docCity],
  defectBasis: 'documentation',
  async run(ctx) {
    const rows = await dbRows(ctx);
    const locs = await locationsById(ctx);
    const c = rows.map((r) => locs.get(Number(r.location_id))).map((l) => l && String(l.city)).find((x) => x && /[a-z]/i.test(x));
    if (!c) ctx.block('No real city with letters available', 'Test data unavailable');
    const base = await fetchAllPages(ctx, { city: c }, `city=${c}`);
    ctx.check(`city=${c}: HTTP 200`, base.allOk, { expected: 200, actual: base.responses.map((r) => r.status).join(',') });
    for (const variant of [c.toLowerCase(), c.toUpperCase()].filter((v) => v !== c)) {
      const res = await fetchAllPages(ctx, { city: variant }, `city=${variant}`);
      ctx.check(`city=${variant}: HTTP 200`, res.allOk, { expected: 200, actual: res.responses.map((r) => r.status).join(',') });
      ctx.check(`city=${variant} returns same records as city=${c}`, sameSet(ids(res.items), ids(base.items)), { expected: sortedIds(base.items), actual: sortedIds(res.items), source: SRC.docCity });
    }
  },
});

tc({
  id: 'TC-LST-021', category: 'Filter', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'city filter with no matching record', description: 'A city value that matches no location returns an empty result, not an error.',
  related: 'Query param city', dataSource: 'Generated city string verified not to be contained in any city of the locations table.',
  steps: ['Generate a unique city string and verify no DB location city contains it.', `GET ${L}?city=<generated>.`],
  expected: 'HTTP 200 with an empty array (contract: 200 = "Array of streamer records matching your filters"; string input is type-valid so 422 does not apply).',
  assertionLogic: 'status === 200 AND body is []. Automatic.',
  evidence: [SRC.oasList, SRC.docList, SRC.dbLocations],
  async run(ctx) {
    const locs = await locationsById(ctx);
    const c = `QA-NoMatch-${ctx.prep.runId}`;
    if ([...locs.values()].some((l) => String(l.city).toLowerCase().includes(c.toLowerCase()))) ctx.block('Generated city unexpectedly matches real data', 'Test data unavailable');
    ctx.input('city', c, 'Generated non-matching city (checked against all locations rows) — not a business record');
    const r = await ctx.get(L, { query: { city: c } });
    ctx.checkStatus(r, 200, SRC.oasList);
    ctx.check('Body is an empty array', Array.isArray(r.json) && r.json.length === 0, { expected: '[]', actual: Array.isArray(r.json) ? `array(${r.json.length})` : r.bodyText.slice(0, 80) });
  },
});

tc({
  id: 'TC-LST-022', category: 'Filter', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Combined filters are AND-combined', description: 'status + tier together return exactly the database rows matching both.',
  related: 'Query params status + tier', dataSource: 'status/tier pair taken from a real DB row (so the expected set is non-empty).',
  steps: ['Take status s and tier t from the first DB row.', `GET ${L}?status=s&tier=t (paged).`, 'Compare with DB rows WHERE status = s AND tier = t.'],
  expected: 'HTTP 200; returned ID set equals DB rows with both status = s AND tier = t.',
  assertionLogic: 'status 200; every record matches both; sameSet with the DB AND filter. Automatic.',
  evidence: [SRC.docList, SRC.oasList, SRC.dbStreamers],
  defectBasis: 'documentation',
  async run(ctx) {
    requireColumn(ctx, 'streamers', 'status');
    requireColumn(ctx, 'streamers', 'tier');
    const rec = await firstDbRecord(ctx);
    const rows = await dbRows(ctx);
    const q = { status: rec.status, tier: rec.tier };
    const { items, responses, allOk } = await fetchAllPages(ctx, q, `status=${q.status}&tier=${q.tier}`);
    ctx.check('HTTP 200', allOk, { expected: 200, actual: responses.map((r) => r.status).join(',') });
    ctx.check('Every record matches both filters', items.every((r) => r.status === q.status && r.tier === q.tier), { expected: `status=${q.status} AND tier=${q.tier}`, actual: items.map((r) => `${r.id}:${r.status}/${r.tier}`) });
    const exp = rows.filter((r) => r.status === q.status && r.tier === q.tier);
    ctx.dbStart('expected AND set from streamers');
    ctx.check('Result equals DB rows matching both filters', sameSet(ids(items), ids(exp)), { expected: sortedIds(exp), actual: sortedIds(items), source: `${SRC.docList}; ${SRC.dbStreamers}` });
    ctx.dbEnd();
  },
});

tc({
  id: 'TC-LST-023', category: 'Pagination', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Pagination within a filtered result', description: 'Paging a filtered result one record at a time yields exactly the DB rows for that filter.',
  related: 'Query params tier + skip + limit', dataSource: 'A tier value with ≥2 rows in the database.',
  steps: ['Choose a tier with at least 2 DB rows.', `GET ${L}?tier=t&skip=k&limit=1 for k = 0,1,… until an empty page.`, 'Compare with DB rows WHERE tier = t.'],
  expected: 'Each page HTTP 200 with ≤1 record; no duplicates; union equals the DB set.',
  assertionLogic: 'status 200; page length ≤ 1; no duplicate IDs; sameSet(union, dbSet). Automatic.',
  evidence: [SRC.oasList, SRC.docList, SRC.dbStreamers],
  async run(ctx) {
    requireColumn(ctx, 'streamers', 'tier');
    const rows = await dbRows(ctx);
    const counts = {};
    rows.forEach((r) => { counts[r.tier] = (counts[r.tier] || 0) + 1; });
    const tier = Object.keys(counts).find((t) => counts[t] >= 2);
    if (!tier) ctx.block('No tier has ≥2 rows in the database', 'Test data unavailable');
    const exp = rows.filter((r) => r.tier === tier);
    const got = [];
    let ok = true;
    let over = false;
    for (let k = 0; k <= exp.length + 1; k++) {
      const r = await ctx.get(L, { query: { tier, skip: k, limit: 1 }, label: `tier=${tier} page ${k}` });
      if (r.status !== 200 || !Array.isArray(r.json)) { ok = false; break; }
      if (r.json.length > 1) over = true;
      if (!r.json.length) break;
      got.push(...ids(r.json));
    }
    ctx.check('All pages HTTP 200 arrays', ok, { expected: true, actual: ok });
    ctx.check('No page exceeds limit=1', !over, { expected: '≤ 1', actual: over ? '> 1' : '≤ 1' });
    ctx.check('No duplicate IDs across pages', dupes(got).length === 0, { expected: [], actual: dupes(got) });
    ctx.check(`Pages cover exactly DB rows with tier=${tier}`, sameSet(got, ids(exp)), { expected: sortedIds(exp), actual: got.slice().sort(), source: SRC.dbStreamers });
  },
});

for (const [id, param] of [['TC-LST-024', 'status'], ['TC-LST-025', 'tier']]) {
  tc({
    id, category: 'Negative', endpoint: 'E1 GET /api/v1/streamers',
    scenario: `Invalid ${param} values are rejected`, description: `Values outside the ${param} enum (an unknown word, and the upper-case form of a valid value) are rejected; the contract enum is lower-case and case-sensitive.`,
    related: `Query param ${param}`, dataSource: 'Generated invalid inputs.',
    steps: [`GET ${L}?${param}=qa_invalid_value.`, `GET ${L}?${param}=<UPPER-CASE first enum value>.`, 'Assert 422 for both.'],
    expected: 'HTTP 422 with HTTPValidationError body for each invalid value.',
    assertionLogic: 'status === 422 AND HTTPValidationError schema, for each input. Automatic.',
    evidence: [SRC.oasList, SRC.oasStreamerOut],
    async run(ctx) {
      const values = ctx.paramEnum(L, param);
      const inputs = ['qa_invalid_value', values[0].toUpperCase()].filter((v) => !values.includes(v));
      for (const v of inputs) {
        ctx.input(param, v, 'Generated invalid enum value — not a business record');
        const r = await ctx.get(L, { query: { [param]: v } });
        ctx.check422(r, SRC.oasList);
      }
    },
  });
}

// ----- E1 Needs Validation -------------------------------------------------
nv({
  id: 'TC-LST-026', category: 'Negative', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Undocumented query parameter', description: 'Behaviour when an unknown query parameter is supplied.',
  related: 'Query string (undocumented parameter)', dataSource: 'Generated parameter name.',
  steps: [`GET ${L}?qa_unknown_param=1.`],
  expected: 'NEEDS VALIDATION — the contract does not state whether unknown parameters are ignored or rejected.',
  assertionLogic: 'None (no assertion executed). Observation only.',
  evidence: [SRC.oasList],
  nvReason: 'No documented rule for unknown query parameters. A human must decide whether ignoring (200) or rejecting (4xx) is the requirement.',
  async observe(ctx) { await ctx.get(L, { query: { qa_unknown_param: 1 } }); },
});

nv({
  id: 'TC-LST-027', category: 'Filter', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Empty city value', description: 'Behaviour of city= (empty string).',
  related: 'Query param city', dataSource: 'Generated empty input; locations table checked for empty city values.',
  steps: [`GET ${L}?city=`, 'Check whether any locations row has an empty city.'],
  expected: 'NEEDS VALIDATION — an empty string is type-valid, but the docs do not say whether it means "no filter", "city equals empty" or invalid input.',
  assertionLogic: 'None. Observation only.',
  evidence: [SRC.oasList, SRC.docCity, SRC.dbLocations],
  nvReason: 'Semantics of an empty filter value are undocumented.',
  async observe(ctx) {
    await ctx.get(L, { query: { city: '' } });
    const locs = await locationsById(ctx);
    ctx.note(`locations rows with blank city: ${[...locs.values()].filter((l) => !String(l.city).trim()).map((l) => l.id).join(', ') || 'none'}`);
  },
});

nv({
  id: 'TC-LST-028', category: 'Filter', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Partial city value', description: 'Whether city matching is exact or substring/prefix.',
  related: 'Query param city', dataSource: 'First 3 letters of a real city from the database.',
  steps: [`GET ${L}?city=<first 3 letters of a real city>.`],
  expected: 'NEEDS VALIDATION — docs say only "Filter by city (case-insensitive)"; exact vs partial matching is not specified.',
  assertionLogic: 'None. Observation only.',
  evidence: [SRC.docCity],
  nvReason: 'Matching semantics (exact vs partial) are not documented.',
  async observe(ctx) {
    const locs = await locationsById(ctx);
    const rows = await dbRows(ctx);
    const city = rows.map((r) => locs.get(Number(r.location_id))).map((l) => l && String(l.city)).find((c) => c && c.length >= 4);
    if (!city) ctx.block('No suitable real city', 'Test data unavailable');
    await ctx.get(L, { query: { city: city.slice(0, 3) } });
  },
});

nv({
  id: 'TC-LST-029', category: 'Sorting', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Default ordering of records', description: 'Order in which records are returned.',
  related: 'Response ordering', dataSource: 'All real records.',
  steps: [`GET ${L}?limit=<maximum>.`, 'Inspect the id order.'],
  expected: 'NEEDS VALIDATION — no sort order or sort parameter is documented.',
  assertionLogic: 'None. Observation only.',
  evidence: [SRC.oasList],
  nvReason: 'Ordering is not part of the contract; pagination stability depends on it. A required order must be specified before it can be asserted.',
  async observe(ctx) {
    const r = await ctx.get(L, { query: { limit: ctx.param(L, 'limit').maximum } });
    if (Array.isArray(r.json)) {
      const order = ids(r.json);
      ctx.note(`Observed id order: ${JSON.stringify(order)}`);
      ctx.note(`Equals lexicographic string order: ${JSON.stringify(order) === JSON.stringify([...order].sort())}; equals numeric order: ${JSON.stringify(order) === JSON.stringify([...order].sort((a, b) => Number(a) - Number(b)))}`);
    }
  },
});

nv({
  id: 'TC-LST-030', category: 'Schema', endpoint: 'E1 + E2',
  scenario: 'date-time values without timezone offset', description: 'created_at / updated_at (and location.created_at) are declared format "date-time"; the DB columns are DATETIME (no time zone).',
  related: 'StreamerOut.created_at, updated_at; LocationOut.created_at; DB DATETIME columns', dataSource: 'Real records.',
  steps: [`GET ${L}?limit=1.`, 'Inspect timestamp format.'],
  expected: 'NEEDS VALIDATION — JSON Schema "date-time" refers to RFC 3339, which requires a timezone offset; JSON Schema 2020-12 treats format as an annotation by default; the DB stores DATETIME without zone. Whether offset-less timestamps are a defect requires a human decision.',
  assertionLogic: 'None. Observation only. (TC-LST-002 validates these fields leniently as ISO-8601.)',
  evidence: [SRC.oasStreamerOut, SRC.dbSchema],
  nvReason: 'Conflicting interpretation: strict RFC 3339 vs lenient ISO-8601; contract does not state which applies.',
  async observe(ctx) {
    const r = await ctx.get(L, { query: { limit: 1 } });
    if (Array.isArray(r.json) && r.json[0]) ctx.note(`Observed created_at="${r.json[0].created_at}", updated_at="${r.json[0].updated_at}", location.created_at="${r.json[0].location && r.json[0].location.created_at}"`);
  },
});

nv({
  id: 'TC-LST-031', category: 'Performance', endpoint: 'E1 + E2',
  scenario: 'Response-time threshold', description: 'Response time of both endpoints.',
  related: 'Response time', dataSource: 'Live API.',
  steps: [`GET ${L}.`, `GET ${ITEM} for a real id.`, 'Record durations.'],
  expected: 'NEEDS VALIDATION — no response-time requirement or approved threshold was supplied.',
  assertionLogic: 'None. Durations are recorded for every request as evidence only.',
  evidence: ['No requirement supplied'],
  nvReason: 'A threshold (e.g. p95 ≤ N ms) must be approved before it can be asserted.',
  async observe(ctx) {
    const a = await ctx.get(L);
    const rec = await firstDbRecord(ctx);
    const b = await ctx.get(item(rec.id));
    ctx.note(`Observed durations: collection ${a.durationMs} ms, detail ${b.durationMs} ms (single samples, client-side, includes network).`);
  },
});

// ===== E2: single-streamer endpoint ========================================
tc({
  id: 'TC-GET-001', category: 'Positive', endpoint: 'E2 GET /api/v1/streamers/{streamer_id}',
  scenario: 'Existing streamer is returned', description: 'Fetch a real streamer by an id taken from the database.',
  related: 'Path param streamer_id; StreamerOut', dataSource: 'First row of the streamers table.',
  steps: ['Take a real id from the streamers table.', `GET ${ITEM}.`, 'Validate status, schema and id.'],
  expected: 'HTTP 200; body conforms to StreamerOut; body.id equals the requested id.',
  assertionLogic: 'status === 200; schema violations = 0; body.id === requested id. Automatic.',
  evidence: [SRC.oasItem, SRC.docItem, SRC.oasStreamerOut, SRC.dbStreamers],
  async run(ctx) {
    const rec = await firstDbRecord(ctx);
    const r = await ctx.get(item(rec.id));
    ctx.checkStatus(r, 200, SRC.oasItem);
    if (r.status === 200) ctx.checkSchema('StreamerOut', ctx.schemaRef('StreamerOut'), r.json, SRC.oasStreamerOut);
    ctx.check('body.id equals requested id', r.json && String(r.json.id) === String(rec.id), { expected: rec.id, actual: r.json && r.json.id });
  },
});

tc({
  id: 'TC-GET-002', category: 'Headers', endpoint: 'E2 GET /api/v1/streamers/{streamer_id}',
  scenario: 'Content-Type on success and not-found responses', description: 'Both the 200 and the 404 response carry the media type the contract declares.',
  related: 'Response header Content-Type', dataSource: 'A real id from the DB and a generated id proven absent in the DB.',
  steps: [`GET ${ITEM} with a real id.`, `GET ${ITEM} with an id proven absent.`, 'Read Content-Type of both.'],
  expected: '200 and 404 responses both have Content-Type application/json.',
  assertionLogic: 'statuses 200/404 AND /^application\\/json/ for both. Automatic.',
  evidence: [SRC.oasItem],
  async run(ctx) {
    const rec = await firstDbRecord(ctx);
    const missing = await absentEightDigitId(ctx);
    await provenAbsent(ctx, missing);
    ctx.input('streamer_id', missing, 'Generated 8-digit ID proven absent in the database');
    const a = await ctx.get(item(rec.id), { label: 'existing id' });
    const b = await ctx.get(item(missing), { label: 'absent id' });
    ctx.checkStatus(a, 200, SRC.oasItem);
    ctx.checkJsonContentType(a, SRC.oasItem);
    ctx.checkStatus(b, 404, SRC.oasItem);
    ctx.checkJsonContentType(b, SRC.oasItem);
  },
});

const notFoundCase = (id, scenario, description, inputFn, dataSource, extra = {}) => tc({
  id, category: extra.category || 'Negative', endpoint: 'E2 GET /api/v1/streamers/{streamer_id}',
  scenario, description, related: 'Path param streamer_id; streamers.id', dataSource,
  steps: ['Generate the input and prove it is absent with SELECT COUNT(*) FROM streamers WHERE id = ?.', `GET ${ITEM} with the input (URL-encoded).`, 'Validate status and ErrorResponse body.'],
  expected: 'HTTP 404 with an ErrorResponse body ({detail: string}). streamer_id is typed as a plain string with no pattern, so the input is valid and 422 does not apply; the docs state 404 when the ID does not exist.' + (extra.expectedExtra || ''),
  assertionLogic: 'status === 404 AND body validates against ErrorResponse' + (extra.assertExtra || '') + '. The detail message text is not asserted (see TC-GET-009). Automatic.',
  evidence: [SRC.oasItem, SRC.docItem, SRC.dbStreamers],
  async run(ctx) {
    const v = await inputFn(ctx);
    await provenAbsent(ctx, v);
    ctx.input('streamer_id', v, 'Generated input proven absent in the database — not a business record');
    const r = await ctx.get(item(v));
    ctx.checkStatus(r, 404, `${SRC.oasItem}; ${SRC.docItem}`);
    if (r.status === 404) ctx.checkSchema('ErrorResponse', ctx.schemaRef('ErrorResponse'), r.json, SRC.oasItem);
    if (extra.verify) extra.verify(ctx, r);
  },
});

notFoundCase('TC-GET-003', 'Non-existent numeric ID returns 404', 'An 8-digit id (same shape as real ids) that does not exist.', absentEightDigitId, 'Generated 8-digit ID proven absent in the DB.');
notFoundCase('TC-GET-004', 'Non-numeric ID returns 404', 'An alphabetic id; the contract has no pattern restriction.', async () => 'qa-not-an-id', 'Generated alphabetic ID.');
notFoundCase('TC-GET-005', 'Leading-zero variant of a real ID is a different ID', 'A real id with a leading "0" is a different string and must not resolve to the real record.', async (ctx) => '0' + (await firstDbRecord(ctx)).id, 'Real DB id prefixed with "0".');
notFoundCase('TC-GET-006', 'Very long ID (1024 characters)', 'A 1024-character id; the contract defines no maximum length (DB column is VARCHAR(50)).', async () => '9'.repeat(1024), 'Generated 1024-digit string.', { category: 'Boundary' });
notFoundCase('TC-GET-007', 'SQL-injection-style ID does not return data', "An id containing SQL syntax (' OR '1'='1) must be treated as a literal value.", async () => "' OR '1'='1", 'Generated SQL-injection-style string.', {
  category: 'Security',
  expectedExtra: ' No streamer record or list may be returned.',
  assertExtra: ' AND body is not an array and has no "id" property',
  verify(ctx, r) {
    ctx.check('No streamer data returned', !(Array.isArray(r.json) || (r.json && 'id' in r.json)), { expected: 'no record/list', actual: Array.isArray(r.json) ? 'array' : r.json && 'id' in r.json ? 'record with id' : 'no record' });
  },
});

nv({
  id: 'TC-GET-008', category: 'Negative', endpoint: 'E2 GET /api/v1/streamers/{streamer_id}',
  scenario: 'Empty streamer_id (trailing slash)', description: 'Request /api/v1/streamers/ with no id segment.',
  related: 'Path param streamer_id (empty)', dataSource: 'No data.',
  steps: [`GET ${L}/ (redirects are not followed).`],
  expected: 'NEEDS VALIDATION — the contract does not define behaviour for an empty path segment (redirect vs 404 vs 422).',
  assertionLogic: 'None. Observation only.',
  evidence: [SRC.oasItem],
  nvReason: 'Undocumented routing behaviour; needs a decision on the required response.',
  async observe(ctx) { const r = await ctx.get(L + '/'); ctx.note(`Location header: ${r.headers.location || '(none)'}`); },
});

nv({
  id: 'TC-GET-009', category: 'Negative', endpoint: 'E2 GET /api/v1/streamers/{streamer_id}',
  scenario: '404 error message text', description: 'Exact wording of ErrorResponse.detail for a missing id.',
  related: 'ErrorResponse.detail', dataSource: 'Generated absent id.',
  steps: [`GET ${ITEM} with an absent id.`, 'Read detail.'],
  expected: 'NEEDS VALIDATION — the contract only shows an example ("Streamer 30094635 not found"); an example is not a requirement. Also note the message echoes the raw input.',
  assertionLogic: 'None. TC-GET-003..007 assert only that detail is a string.',
  evidence: [SRC.oasItem],
  nvReason: 'Message wording/format is not specified as a requirement.',
  async observe(ctx) { const id = await absentEightDigitId(ctx); await ctx.get(item(id)); },
});

// ===== Cross-endpoint ========================================================
tc({
  id: 'TC-XEP-001', category: 'Integration', endpoint: 'E1 + E2',
  scenario: 'Every listed streamer is retrievable and identical by ID', description: 'For each record in the complete listing, the single-streamer endpoint returns the same record.',
  related: 'All StreamerOut fields', dataSource: 'All records returned by the API.',
  steps: ['Fetch the complete listing.', `For each record: GET ${ITEM}.`, 'Compare the two representations field by field.'],
  expected: 'HTTP 200 for each id and a body identical to the listing record (both endpoints return StreamerOut for the same resource).',
  assertionLogic: 'status === 200 AND canonical deep-equality of all fields, per record. Differences are reported per field (PII masked). Automatic.',
  evidence: [SRC.oasList, SRC.oasItem],
  async run(ctx) {
    const listing = await ctx.ref('listing');
    if (!listing.length) ctx.block('No records', 'Test data unavailable');
    for (const rec of listing) {
      const r = await ctx.get(item(rec.id), { label: 'detail for listed id' });
      const same = r.status === 200 && deepEqual(r.json, rec);
      ctx.check(`id ${rec.id}: 200 and identical to listing`, same, {
        expected: 'HTTP 200, identical record',
        actual: r.status !== 200 ? `HTTP ${r.status}` : same ? 'identical' : `differs: ${diffFields(rec, r.json || {}, ctx.maskField).join('; ')}`,
        source: `${SRC.oasList}; ${SRC.oasItem}`,
      });
    }
  },
});

// ===== Database (real MariaDB) ==============================================
tc({
  id: 'TC-DB-001', category: 'Database', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'API record count equals streamers table row count', description: 'The number of records retrievable through the collection endpoint equals SELECT COUNT(*) FROM streamers.',
  related: 'streamers table (row count)', dataSource: 'Complete live listing + MariaDB COUNT(*).',
  steps: ['Page through the complete listing.', 'SELECT COUNT(*) FROM streamers.', 'Compare counts.'],
  expected: 'listing length === DB row count.',
  assertionLogic: 'listing.length === COUNT(*). Automatic.',
  evidence: [SRC.dbCount, SRC.oasList],
  defectBasis: 'derived',
  async run(ctx) {
    const listing = await ctx.ref('listing');
    const total = await ctx.ref('db:count');
    ctx.dbStart('compare API record count with streamers row count');
    ctx.check('API count = DB COUNT(*)', listing.length === total, { expected: total, actual: listing.length, source: SRC.dbCount });
    ctx.dbEnd();
  },
});

tc({
  id: 'TC-DB-002', category: 'Database', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'API ID set equals streamers table primary keys', description: 'Every streamers row is served by the collection endpoint and every served record exists in the table.',
  related: 'streamers.id (PRIMARY KEY) ↔ StreamerOut.id', dataSource: 'Complete live listing + MariaDB streamers rows.',
  steps: ['Page through the complete listing.', 'SELECT * FROM streamers.', 'Compare ID sets (missing / extra).'],
  expected: 'No DB row missing from the API and no API record absent from the DB.',
  assertionLogic: 'dbIds \\ apiIds = ∅ AND apiIds \\ dbIds = ∅. Automatic.',
  evidence: [SRC.dbStreamers, SRC.dbSchema, SRC.oasList],
  defectBasis: 'derived',
  async run(ctx) {
    const listing = await ctx.ref('listing');
    const rows = await dbRows(ctx);
    ctx.dbStart('API ids vs streamers primary keys');
    const a = ids(listing);
    const d = ids(rows);
    ctx.check('Every DB row is served by the API', d.every((x) => a.includes(x)), { expected: [], actual: d.filter((x) => !a.includes(x)), source: SRC.dbStreamers });
    ctx.check('Every API record exists in the DB', a.every((x) => d.includes(x)), { expected: [], actual: a.filter((x) => !d.includes(x)), source: SRC.dbStreamers });
    ctx.dbEnd();
  },
});

tc({
  id: 'TC-DB-003', category: 'Database', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Collection fields match streamers table rows', description: 'For every streamer returned by the collection endpoint, API field values equal the DB column values. Mapping: API field ↔ column with the identical name (from information_schema), plus location.id ↔ location_id via the declared FOREIGN KEY. Unmapped fields are listed, not asserted.',
  related: 'streamers columns ↔ StreamerOut fields', dataSource: 'Complete live listing + MariaDB streamers rows + column definitions.',
  steps: ['Read column definitions from information_schema.', 'SELECT * FROM streamers.', 'Build the mapping by identical names (+ FK).', 'Compare per id: FLOAT columns with single-precision tolerance, INT numerically, DATETIME as normalised local timestamps, others as strings.'],
  expected: 'Every API id has exactly one DB row and vice versa; all mapped field values are equal.',
  assertionLogic: 'Per record and mapped field: type-aware equality (tolerance only where the column type is FLOAT). Automatic.',
  evidence: [SRC.dbSchema, SRC.dbStreamers, SRC.oasStreamerOut],
  defectBasis: 'derived',
  async run(ctx) {
    const table = ctx.dbTable('streamers');
    const listing = await ctx.ref('listing');
    const rows = await dbRows(ctx);
    ctx.dbStart('field-level comparison: collection endpoint vs streamers rows');
    compareRows(ctx, listing, rows, table);
    ctx.dbEnd();
  },
});

tc({
  id: 'TC-DB-014', category: 'Database', endpoint: 'E2 GET /api/v1/streamers/{streamer_id}',
  scenario: 'Detail endpoint fields match the DB row for every streamer', description: 'For every row in the streamers table, GET /api/v1/streamers/{id} returns 200 and its mapped fields equal the row (same mapping and comparison rules as TC-DB-003).',
  related: 'streamers row ↔ StreamerOut (detail)', dataSource: 'All MariaDB streamers rows (real IDs).',
  steps: ['SELECT * FROM streamers.', `For each id: GET ${ITEM}.`, 'Compare mapped fields with the row.'],
  expected: 'HTTP 200 for every DB id and all mapped fields equal.',
  assertionLogic: 'status === 200 AND type-aware equality of mapped fields, per id. Automatic.',
  evidence: [SRC.dbSchema, SRC.dbStreamers, SRC.oasItem, SRC.docItem],
  defectBasis: 'derived',
  async run(ctx) {
    const table = ctx.dbTable('streamers');
    const rows = await dbRows(ctx);
    if (!rows.length) ctx.block('The streamers table is empty', 'Test data unavailable');
    let mapping = null;
    for (const row of rows) {
      const r = await ctx.get(item(row.id), { label: 'detail for DB id' });
      if (r.status !== 200 || !r.json) { ctx.check(`DB id ${row.id}: HTTP 200`, false, { expected: 200, actual: r.status, source: SRC.docItem }); continue; }
      if (!mapping) {
        mapping = buildMapping(r.json, table);
        ctx.note(`Field mapping: ${mapping.map((m) => `${m.api}↔${m.col.name}`).join(', ')}`);
      }
      ctx.dbStart(`detail vs DB row ${row.id}`);
      const diffs = compareRecord(ctx, r.json, row, mapping);
      ctx.check(`DB id ${row.id}: 200 and mapped fields equal`, diffs.length === 0, { expected: 'all mapped fields equal', actual: diffs.join('; ') || 'equal', source: `${SRC.dbStreamers}; ${SRC.oasItem}` });
      ctx.dbEnd();
    }
  },
});

tc({
  id: 'TC-DB-004', category: 'Relationship', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Embedded location matches the locations row (FK)', description: 'Each streamer\'s embedded location equals the locations row referenced by streamers.location_id (declared FOREIGN KEY), for every column with an identical field name.',
  related: 'streamers.location_id → locations.id (FK); StreamerOut.location (LocationOut)', dataSource: 'Complete listing + MariaDB streamers + locations rows.',
  steps: ['SELECT streamers and locations.', 'For each API record find its DB row, then the locations row via location_id.', 'Compare LocationOut fields with identically named columns.'],
  expected: 'Embedded location fields equal the referenced locations row.',
  assertionLogic: 'Type-aware equality per mapped location field, per streamer. Automatic.',
  evidence: [SRC.dbLocations, SRC.dbSchema, SRC.oasStreamerOut],
  defectBasis: 'derived',
  async run(ctx) {
    const locTable = ctx.dbTable('locations');
    const listing = await ctx.ref('listing');
    const rows = await dbRows(ctx);
    const locs = await locationsById(ctx);
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    ctx.dbStart('streamers → locations relationship (FK)');
    for (const rec of listing) {
      const row = byId.get(String(rec.id));
      const loc = row && locs.get(Number(row.location_id));
      if (!loc || !rec.location) { ctx.check(`id ${rec.id}: referenced location exists`, false, { expected: 'location row via FK', actual: !row ? 'no DB row' : !loc ? `no locations row ${row.location_id}` : 'no embedded location' }); continue; }
      const cols = locTable.columns.filter((c) => c.name in rec.location);
      const diffs = cols.filter((c) => !sameValue(rec.location[c.name], loc[c.name], c)).map((c) => `${c.name}: API ${JSON.stringify(rec.location[c.name])} vs DB ${JSON.stringify(loc[c.name])}`);
      ctx.check(`id ${rec.id}: location ${row.location_id} matches locations row`, diffs.length === 0, { expected: `fields ${cols.map((c) => c.name).join(', ')} equal`, actual: diffs.join('; ') || 'equal', source: SRC.dbLocations });
    }
    ctx.dbEnd();
  },
});

tc({
  id: 'TC-DB-005', category: 'Relationship', endpoint: 'E2 GET /api/v1/streamers/{streamer_id}',
  scenario: 'Every earnings.streamer_id resolves through the API', description: 'The DB declares FOREIGN KEY earnings.streamer_id → streamers.id; every referenced streamer must be retrievable via the detail endpoint.',
  related: 'earnings.streamer_id → streamers.id (FK)', dataSource: 'MariaDB earnings rows (real).',
  steps: ['SELECT streamer_id FROM earnings.', `For each distinct streamer_id: GET ${ITEM}.`],
  expected: 'HTTP 200 for every referenced streamer_id.',
  assertionLogic: 'status === 200 for each distinct streamer_id. Automatic.',
  evidence: [SRC.dbEarnings, SRC.oasItem, SRC.docItem],
  defectBasis: 'derived',
  async run(ctx) {
    const t = ctx.dbTable('earnings');
    if (!t.foreignKeys.some((f) => f.column === 'streamer_id' && f.refTable === 'streamers')) ctx.block('No FK earnings.streamer_id → streamers declared', 'Database access');
    const earnings = await ctx.ref('db:earnings');
    const refIds = [...new Set(earnings.map((e) => String(e.streamer_id)))];
    if (!refIds.length) ctx.block('No earnings rows to check', 'Test data unavailable');
    ctx.dbStart(`resolve ${refIds.length} distinct earnings.streamer_id value(s)`);
    for (const sid of refIds) {
      const r = await ctx.get(item(sid), { label: 'earnings FK reference' });
      ctx.check(`earnings.streamer_id ${sid} resolves`, r.status === 200, { expected: 200, actual: r.status, source: SRC.dbEarnings });
    }
    ctx.dbEnd();
  },
});

function auditState(entries) {
  const sorted = entries.filter((e) => e.resource_type === 'streamer').sort((a, b) => Number(a.id) - Number(b.id));
  const last = new Map();
  sorted.forEach((e) => last.set(String(e.resource_id), e));
  return { sorted, last };
}

tc({
  id: 'TC-DB-006', category: 'Database', endpoint: 'E1 + E2',
  scenario: 'Deleted streamers (per audit_log) are not served', description: 'Streamers whose most recent audit_log event is DELETE must not exist in the streamers table, must not appear in the listing, and the 5 most recent must return 404.',
  related: 'audit_log (action, resource_id) → streamers', dataSource: 'Full audit_log history from MariaDB.',
  steps: ["SELECT … FROM audit_log WHERE resource_type = 'streamer'.", 'Find ids whose latest event is DELETE.', 'Check absence from the DB rows and the complete listing.', `GET ${ITEM} for the 5 most recently deleted ids.`],
  expected: 'None of those ids is in the table or the listing; each of the 5 returns 404.',
  assertionLogic: 'intersection(deletedIds, dbIds) = ∅; intersection(deletedIds, listingIds) = ∅; status === 404 ×5. Automatic.',
  evidence: [SRC.dbAudit, SRC.dbStreamers, SRC.docItem],
  defectBasis: 'derived',
  async run(ctx) {
    ctx.dbTable('audit_log');
    const entries = await ctx.ref('db:audit');
    const listing = await ctx.ref('listing');
    const rows = await dbRows(ctx);
    ctx.dbStart('audit_log DELETE events vs streamers table and API');
    const { last } = auditState(entries);
    const deleted = [...last.values()].filter((e) => e.action === 'DELETE').sort((a, b) => Number(b.id) - Number(a.id));
    if (!deleted.length) ctx.block('No DELETE events in audit_log', 'Test data unavailable');
    const delIds = deleted.map((e) => String(e.resource_id));
    ctx.check(`${deleted.length} deleted id(s) absent from streamers table`, delIds.every((x) => !ids(rows).includes(x)), { expected: [], actual: delIds.filter((x) => ids(rows).includes(x)), source: SRC.dbAudit });
    ctx.check(`${deleted.length} deleted id(s) absent from API listing`, delIds.every((x) => !ids(listing).includes(x)), { expected: [], actual: delIds.filter((x) => ids(listing).includes(x)), source: SRC.dbAudit });
    for (const e of deleted.slice(0, 5)) {
      const r = await ctx.get(item(e.resource_id), { label: `deleted per audit_log #${e.id}` });
      ctx.check(`deleted id ${e.resource_id} returns 404`, r.status === 404, { expected: 404, actual: r.status, source: `${SRC.dbAudit}; ${SRC.docItem}` });
    }
    ctx.dbEnd(`${deleted.length} deleted ids checked`);
  },
});

tc({
  id: 'TC-DB-007', category: 'Database', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Created/updated streamers (per audit_log) are served', description: 'Streamers whose most recent audit_log event is CREATE, UPDATE or PATCH must be present in the listing.',
  related: 'audit_log → streamers', dataSource: 'Full audit_log history from MariaDB.',
  steps: ["SELECT … FROM audit_log WHERE resource_type = 'streamer'.", 'Find ids whose latest event is not DELETE.', 'Check presence in the complete listing.'],
  expected: 'Every such id is present in the listing.',
  assertionLogic: 'nonDeletedIds ⊆ listingIds. Assumes logged writes were committed (audit_log documented as history of write operations). Automatic.',
  evidence: [SRC.dbAudit],
  defectBasis: 'derived',
  async run(ctx) {
    ctx.dbTable('audit_log');
    const entries = await ctx.ref('db:audit');
    const listing = await ctx.ref('listing');
    ctx.dbStart('audit_log CREATE/UPDATE/PATCH events vs served records');
    const { last } = auditState(entries);
    const live = [...last.values()].filter((e) => e.action !== 'DELETE').map((e) => String(e.resource_id));
    if (!live.length) ctx.block('No non-deleted streamer events in audit_log', 'Test data unavailable');
    const missing = live.filter((x) => !ids(listing).includes(x));
    ctx.check(`${live.length} non-deleted id(s) present in listing`, missing.length === 0, { expected: [], actual: missing, source: SRC.dbAudit });
    ctx.dbEnd(`${live.length} ids checked`);
  },
});

tc({
  id: 'TC-DB-008', category: 'Database', endpoint: 'E1 GET /api/v1/streamers',
  scenario: 'Current field values match the latest audit_log change', description: 'For served streamers, each of name, phone, email, tier, status equals the value in the most recent audit_log event whose details set that field.',
  related: 'audit_log.details → StreamerOut.name/phone/email/tier/status', dataSource: 'Full audit_log history + complete listing.',
  steps: ["SELECT … FROM audit_log WHERE resource_type = 'streamer'.", 'For each served id and field, find the latest event whose details JSON contains that field.', 'Compare with the API value.'],
  expected: 'API value === details[field] from the latest event that set it.',
  assertionLogic: 'Strict equality per (id, field). Expectation is derived (details is the JSON payload of the change; server-side normalisation is undocumented), so failures are reported as suspected, not confirmed. Automatic.',
  evidence: [SRC.dbAudit],
  defectBasis: 'derived',
  async run(ctx) {
    ctx.dbTable('audit_log');
    const entries = await ctx.ref('db:audit');
    const listing = await ctx.ref('listing');
    ctx.dbStart('audit_log details vs current field values');
    const { sorted } = auditState(entries);
    const fields = ['name', 'phone', 'email', 'tier', 'status'];
    let compared = 0;
    for (const rec of listing) {
      const evs = sorted.filter((e) => String(e.resource_id) === String(rec.id) && e.action !== 'DELETE');
      const expected = {};
      for (const e of evs) {
        let d;
        try { d = JSON.parse(e.details); } catch { continue; }
        for (const f of fields) if (d && f in d) expected[f] = { v: d[f], ev: e.id };
      }
      for (const [f, { v, ev }] of Object.entries(expected)) {
        compared++;
        ctx.check(`id ${rec.id}.${f} equals audit_log #${ev}`, rec[f] === v, { expected: ctx.maskField(f, v), actual: ctx.maskField(f, rec[f]), source: SRC.dbAudit });
      }
    }
    if (!compared) ctx.block('No served streamer has field changes in audit_log', 'Test data unavailable');
    ctx.dbEnd(`${compared} field value(s) compared`);
  },
});

tc({
  id: 'TC-DB-012', category: 'Database', endpoint: 'E1 + E2',
  scenario: 'Contract enums match DB ENUM definitions', description: 'TierEnum and StatusEnum in the contract must list the same values as the ENUM definitions of streamers.tier and streamers.status.',
  related: 'TierEnum / StatusEnum ↔ streamers.tier / streamers.status (ENUM)', dataSource: 'Live contract + information_schema column types.',
  steps: ['Read the tier/status enums from the contract.', 'Read COLUMN_TYPE of streamers.tier / status.', 'Compare value sets.'],
  expected: 'Identical value sets for each field.',
  assertionLogic: 'sameSet(contractEnum, dbEnum) per field. Expectation derived (both define allowed values of the same field). Automatic.',
  evidence: [SRC.oasStreamerOut, SRC.dbSchema],
  defectBasis: 'derived',
  async run(ctx) {
    ctx.dbStart('contract enums vs DB ENUM column types');
    for (const f of ['tier', 'status']) {
      const col = requireColumn(ctx, 'streamers', f);
      const contract = ctx.paramEnum(L, f);
      ctx.check(`${f}: contract enum = DB ENUM`, !!col.enum && sameSet(contract, col.enum), { expected: contract, actual: col.enum || col.type, source: `${SRC.oasStreamerOut}; ${SRC.dbSchema}` });
    }
    ctx.dbEnd();
  },
});

const TYPE_MAP = { varchar: 'string', char: 'string', text: 'string', enum: 'string', int: 'integer', bigint: 'integer', smallint: 'integer', tinyint: 'integer', float: 'number', double: 'number', decimal: 'number', datetime: 'string', timestamp: 'string', date: 'string' };

tc({
  id: 'TC-DB-013', category: 'Database', endpoint: 'E1 + E2',
  scenario: 'Contract types and nullability consistent with DB columns', description: 'For every StreamerOut property whose name equals a streamers column: the contract JSON type corresponds to the column type, and contract nullability (anyOf null) equals column nullability.',
  related: 'StreamerOut properties ↔ streamers columns', dataSource: 'Live contract + information_schema.',
  steps: ['Read StreamerOut properties from the contract.', 'Read streamers column definitions.', 'Compare type (standard SQL→JSON correspondence) and nullability per matching name.'],
  expected: 'No type or nullability mismatch for matching names.',
  assertionLogic: 'Per property: jsonType ∈ contract types AND (contract allows null) === (column IS_NULLABLE). Type correspondence: VARCHAR/TEXT/ENUM/DATETIME→string, INT→integer, FLOAT/DOUBLE/DECIMAL→number. Derived. Automatic.',
  evidence: [SRC.oasStreamerOut, SRC.dbSchema],
  defectBasis: 'derived',
  async run(ctx) {
    const table = ctx.dbTable('streamers');
    const props = ctx.spec.components.schemas.StreamerOut.properties;
    const resolve = (s) => (s.$ref ? s.$ref.slice(2).split('/').reduce((n, k) => n && n[k], ctx.spec) : s);
    ctx.dbStart('contract property types vs streamers columns');
    for (const col of table.columns) {
      const p = props[col.name];
      if (!p) continue;
      const parts = (p.anyOf || [p]).map(resolve);
      const types = parts.map((x) => x.type).filter(Boolean);
      const nullable = types.includes('null');
      const want = TYPE_MAP[col.dataType];
      const typeOk = !!want && (types.includes(want) || (want === 'integer' && types.includes('number')));
      ctx.check(`${col.name}: type ${col.type} ↔ ${types.join('|')}; nullable DB=${col.nullable} contract=${nullable}`, typeOk && nullable === col.nullable, {
        expected: `${want || '?'}${col.nullable ? ' | null' : ''}`, actual: types.join(' | '), source: `${SRC.oasStreamerOut}; ${SRC.dbSchema}`,
      });
    }
    ctx.dbEnd();
  },
});

nv({
  id: 'TC-DB-009', category: 'Database', endpoint: 'E1 + E2',
  scenario: 'total_earnings_inr vs earnings rows', description: 'Whether total_earnings_inr equals the sum of (total + bonus_amount) of the streamer\'s earnings rows.',
  related: 'StreamerOut.total_earnings_inr ↔ earnings', dataSource: 'MariaDB streamers + earnings rows.',
  steps: ['SELECT streamers and earnings.', 'Compute per-streamer sums.'],
  expected: 'NEEDS VALIDATION — docs say POST /earnings "updates total_earnings_inr by total + bonus" (an increment), but the seeded starting balance is not documented, so equality with the sum cannot be required.',
  assertionLogic: 'None. Observation only.',
  evidence: [SRC.dbEarnings, SRC.oasStreamerOut],
  nvReason: 'Increment rule documented, baseline undocumented → invariant not established.',
  async observe(ctx) {
    const rows = await dbRows(ctx);
    const earnings = await ctx.ref('db:earnings');
    for (const rec of rows) {
      const mine = earnings.filter((e) => String(e.streamer_id) === String(rec.id));
      if (mine.length) ctx.note(`id ${rec.id}: total_earnings_inr=${rec.total_earnings_inr}; Σ(total+bonus)=${mine.reduce((s, e) => s + Number(e.total) + Number(e.bonus_amount), 0).toFixed(2)} over ${mine.length} row(s)`);
    }
  },
});

nv({
  id: 'TC-DB-010', category: 'Data integrity', endpoint: 'E1 + E2',
  scenario: 'Numeric field ranges', description: 'Whether pickup_rate must be within 0–100 and counts/amounts must be non-negative.',
  related: 'pickup_rate, total_calls, total_earnings_inr', dataSource: 'MariaDB streamers rows + CHECK constraints.',
  steps: ['Inspect value ranges in the DB.', 'Inspect CHECK constraints.'],
  expected: 'NEEDS VALIDATION — pickup_rate is described as "a percentage" but neither the contract (no minimum/maximum) nor the DB (no CHECK constraint found) restricts these ranges.',
  assertionLogic: 'None. Observation only.',
  evidence: [SRC.oasStreamerOut, SRC.dbSchema],
  nvReason: 'No range constraints in the contract or the database.',
  async observe(ctx) {
    const rows = await dbRows(ctx);
    ['pickup_rate', 'total_calls', 'total_earnings_inr'].forEach((f) => ctx.note(`${f}: min=${Math.min(...rows.map((r) => Number(r[f])))}, max=${Math.max(...rows.map((r) => Number(r[f])))}`));
    ctx.note(`CHECK constraints on streamers: ${JSON.stringify(ctx.dbTable('streamers').checks)}`);
  },
});

nv({
  id: 'TC-DB-011', category: 'Data integrity', endpoint: 'E1 + E2',
  scenario: 'Phone number format', description: 'Whether phone values must follow a single format.',
  related: 'StreamerOut.phone; streamers.phone VARCHAR(20) UNIQUE', dataSource: 'MariaDB streamers rows (shapes only; values masked).',
  steps: ['Classify phone formats (digits replaced by 9).'],
  expected: 'NEEDS VALIDATION — the contract types phone as a plain string with no pattern and the DB column has no CHECK constraint; examples use "+91-XXXXXXXXXX", but an example is not a constraint.',
  assertionLogic: 'None. Observation only.',
  evidence: [SRC.oasStreamerOut, SRC.dbSchema],
  nvReason: 'No format rule supplied.',
  async observe(ctx) {
    const rows = await dbRows(ctx);
    const shapes = {};
    rows.forEach((r) => { const s = String(r.phone).replace(/\d/g, '9'); shapes[s] = (shapes[s] || 0) + 1; });
    ctx.note(`Phone shapes (digits replaced by 9): ${JSON.stringify(shapes)}`);
  },
});

// ===== Security / access ======================================================
tc({
  id: 'TC-SEC-001', category: 'Security', endpoint: 'E1 + E2',
  scenario: 'Read access without credentials', description: 'Both read endpoints are documented as usable without authentication.',
  related: 'Authentication (X-API-Token optional for reads)', dataSource: 'A real id from the DB.',
  steps: ['Confirm the contract declares no security requirement on either operation.', `GET ${L}?limit=1 and GET ${ITEM} without any auth header.`],
  expected: 'No security requirement in the contract; both requests return HTTP 200.',
  assertionLogic: 'operation.security and global security are absent; status === 200 ×2. Automatic.',
  evidence: [SRC.docAuth, SRC.oasList, SRC.oasItem],
  defectBasis: 'documentation',
  async run(ctx) {
    const spec = ctx.spec;
    const secList = spec.paths[L].get.security || spec.security;
    const secItem = spec.paths[ITEM].get.security || spec.security;
    ctx.check('Contract declares no security requirement', !secList && !secItem, { expected: 'none', actual: JSON.stringify({ list: secList || null, item: secItem || null }) });
    const rec = await firstDbRecord(ctx);
    const a = await ctx.get(L, { query: { limit: 1 }, label: 'no credentials' });
    const b = await ctx.get(item(rec.id), { label: 'no credentials' });
    ctx.checkStatus(a, 200, SRC.docAuth);
    ctx.checkStatus(b, 200, SRC.docAuth);
  },
});

nv({
  id: 'TC-SEC-002', category: 'Security', endpoint: 'E1 + E2',
  scenario: 'Invalid API token on a read endpoint', description: 'Behaviour when an invalid X-API-Token header is sent to an endpoint that does not require one.',
  related: 'X-API-Token header', dataSource: 'Generated invalid token (not a real credential).',
  steps: [`GET ${L}?limit=1 with X-API-Token: qa-invalid-token.`],
  expected: 'NEEDS VALIDATION — docs say auth is optional for reads; whether an invalid token must be ignored (200) or rejected (401) is not specified.',
  assertionLogic: 'None. Observation only. The header value is redacted in all evidence.',
  evidence: [SRC.docAuth],
  nvReason: 'Undocumented policy for invalid optional credentials.',
  async observe(ctx) { await ctx.get(L, { query: { limit: 1 }, headers: { 'X-API-Token': 'qa-invalid-token' } }); },
});

// ===== Reviewer decisions for Needs Validation cases ===========================
// A Needs Validation case has no established expectation. The reviewer can pick one
// of these options in the dashboard. The chosen option becomes the requirement, the
// case becomes executable, and it re-enters Pending Review. Each option's run() asserts
// exactly that requirement; nothing else is assumed.
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const TS_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const TS_ANY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const REQ = 'Reviewer requirement';

async function realPrefix(ctx) {
  const locs = await locationsById(ctx);
  const rows = await dbRows(ctx);
  const cities = rows.map((r) => locs.get(Number(r.location_id))).map((l) => l && String(l.city)).filter(Boolean);
  const city = cities.find((c) => c.length >= 4);
  if (!city) ctx.block('No real city with ≥4 characters', 'Test data unavailable');
  return { prefix: city.slice(0, 3), rows, cityOf: (r) => { const l = locs.get(Number(r.location_id)); return l ? String(l.city) : ''; } };
}

function timestampsOf(listing) {
  const out = [];
  for (const r of listing) {
    for (const [f, v] of [['created_at', r.created_at], ['updated_at', r.updated_at], ['location.created_at', r.location && r.location.created_at]]) {
      if (v !== null && v !== undefined) out.push({ id: r.id, f, v });
    }
  }
  return out;
}

const DECISIONS = {
  'TC-LST-026': [
    { id: 'ignore', label: () => 'Unknown parameters are ignored', expected: () => 'HTTP 200 and the same records as the request without the unknown parameter.', assertion: () => 'status === 200 AND ids(withUnknownParam) deep-equals ids(withoutParam).',
      async run(ctx) {
        ctx.input('qa_unknown_param', 1, 'Generated undocumented parameter');
        const a = await ctx.get(L, { query: { qa_unknown_param: 1 } });
        const b = await ctx.get(L, { label: 'baseline without parameter' });
        ctx.checkStatus(a, 200, REQ);
        ctx.check('Same records as without the parameter', Array.isArray(a.json) && Array.isArray(b.json) && JSON.stringify(ids(a.json)) === JSON.stringify(ids(b.json)), { expected: Array.isArray(b.json) ? ids(b.json) : b.status, actual: Array.isArray(a.json) ? ids(a.json) : a.status, source: REQ });
      } },
    { id: 'reject', label: () => 'Unknown parameters are rejected with 422', expected: () => 'HTTP 422 with an HTTPValidationError body.', assertion: () => 'status === 422 AND HTTPValidationError schema.',
      async run(ctx) { ctx.input('qa_unknown_param', 1, 'Generated undocumented parameter'); ctx.check422(await ctx.get(L, { query: { qa_unknown_param: 1 } }), REQ); } },
  ],
  'TC-LST-027': [
    { id: 'no-filter', label: () => 'Empty city means "no filter"', expected: () => 'HTTP 200 and exactly all streamers in the database.', assertion: () => 'status 200 AND sameSet(ids(api, city=""), ids(DB streamers)).',
      async run(ctx) {
        const rows = await dbRows(ctx);
        const { items, responses, allOk } = await fetchAllPages(ctx, { city: '' }, 'city=""');
        ctx.check('HTTP 200', allOk, { expected: 200, actual: responses.map((r) => r.status).join(','), source: REQ });
        ctx.dbStart('expected set = all streamers rows');
        ctx.check('Returns every DB streamer', sameSet(ids(items), ids(rows)), { expected: sortedIds(rows), actual: sortedIds(items), source: `${REQ}; ${SRC.dbStreamers}` });
        ctx.dbEnd();
      } },
    { id: 'reject', label: () => 'Empty city is rejected with 422', expected: () => 'HTTP 422 with an HTTPValidationError body.', assertion: () => 'status === 422 AND HTTPValidationError schema.',
      async run(ctx) { ctx.check422(await ctx.get(L, { query: { city: '' } }), REQ); } },
    { id: 'match-empty', label: () => 'Empty city matches only streamers whose city is blank', expected: () => 'HTTP 200 and exactly the DB streamers whose location city is blank (possibly none).', assertion: () => 'status 200 AND sameSet(ids(api), ids(DB streamers ⋈ locations WHERE TRIM(city) = "")).',
      async run(ctx) {
        const rows = await dbRows(ctx);
        const locs = await locationsById(ctx);
        const exp = rows.filter((r) => { const l = locs.get(Number(r.location_id)); return l && !String(l.city).trim(); });
        const { items, responses, allOk } = await fetchAllPages(ctx, { city: '' }, 'city=""');
        ctx.check('HTTP 200', allOk, { expected: 200, actual: responses.map((r) => r.status).join(','), source: REQ });
        ctx.dbStart('expected set = streamers with blank city');
        ctx.check('Returns only streamers with a blank city', sameSet(ids(items), ids(exp)), { expected: sortedIds(exp), actual: sortedIds(items), source: `${REQ}; ${SRC.dbLocations}` });
        ctx.dbEnd();
      } },
  ],
  'TC-LST-028': [
    { id: 'exact', label: () => 'City must match exactly (case-insensitive)', expected: () => 'A 3-letter prefix of a real city returns only streamers whose whole city equals that prefix (normally none).', assertion: () => 'sameSet(ids(api, city=prefix), ids(DB rows WHERE LOWER(city) = LOWER(prefix))).',
      async run(ctx) {
        const { prefix, rows, cityOf } = await realPrefix(ctx);
        ctx.input('city', prefix, 'First 3 letters of a real city');
        const exp = rows.filter((r) => cityOf(r).toLowerCase() === prefix.toLowerCase());
        const { items, allOk } = await fetchAllPages(ctx, { city: prefix }, `city=${prefix}`);
        ctx.check('HTTP 200', allOk, { expected: 200, actual: allOk ? 200 : 'error', source: REQ });
        ctx.check(`city=${prefix} returns exact matches only`, sameSet(ids(items), ids(exp)), { expected: sortedIds(exp), actual: sortedIds(items), source: `${REQ}; ${SRC.dbLocations}` });
      } },
    { id: 'contains', label: () => 'Partial (substring) city match should work', expected: () => 'A 3-letter part of a real city returns every streamer whose city contains it (case-insensitive).', assertion: () => 'sameSet(ids(api, city=part), ids(DB rows WHERE city LIKE %part%)).',
      async run(ctx) {
        const { prefix, rows, cityOf } = await realPrefix(ctx);
        ctx.input('city', prefix, 'First 3 letters of a real city');
        const exp = rows.filter((r) => cityOf(r).toLowerCase().includes(prefix.toLowerCase()));
        const { items, allOk } = await fetchAllPages(ctx, { city: prefix }, `city=${prefix}`);
        ctx.check('HTTP 200', allOk, { expected: 200, actual: allOk ? 200 : 'error', source: REQ });
        ctx.check(`city=${prefix} returns every city containing it`, sameSet(ids(items), ids(exp)), { expected: sortedIds(exp), actual: sortedIds(items), source: `${REQ}; ${SRC.dbLocations}` });
      } },
  ],
  'TC-LST-029': [
    ...[['numeric', 'Ordered by id, numerically ascending', (a, b) => Number(a.id) - Number(b.id)],
      ['text', 'Ordered by id as text (lexicographic) ascending', (a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)],
      ['created', 'Ordered by created_at ascending (oldest first)', (a, b) => (String(a.created_at) < String(b.created_at) ? -1 : String(a.created_at) > String(b.created_at) ? 1 : 0)],
    ].map(([id, text, cmp]) => ({
      id, label: () => text, expected: () => `The complete listing (all pages) is ${text.toLowerCase()}.`, assertion: () => 'For every adjacent pair in the listing: compare(prev, next) ≤ 0.',
      async run(ctx) {
        const listing = await ctx.ref('listing');
        const bad = [];
        for (let i = 1; i < listing.length; i++) if (cmp(listing[i - 1], listing[i]) > 0) bad.push(`${listing[i - 1].id} before ${listing[i].id}`);
        ctx.check(text, bad.length === 0, { expected: 'no out-of-order pair', actual: bad.length ? `${bad.length} out-of-order pair(s): ${bad.slice(0, 5).join('; ')}` : `order ${JSON.stringify(ids(listing))}`, source: REQ });
      },
    })),
  ],
  'TC-LST-030': [
    { id: 'no-offset-ok', label: () => 'Timestamps without a timezone are acceptable', expected: () => 'Every created_at / updated_at / location.created_at is a valid ISO-8601 date-time (timezone optional).', assertion: () => `every timestamp matches ${TS_ANY}.`,
      async run(ctx) {
        const bad = timestampsOf(await ctx.ref('listing')).filter((t) => !TS_ANY.test(t.v));
        ctx.check('All timestamps are valid ISO-8601', bad.length === 0, { expected: 'YYYY-MM-DDTHH:MM:SS[offset]', actual: bad.length ? bad.slice(0, 5).map((t) => `${t.id}.${t.f}="${t.v}"`).join('; ') : 'all valid', source: REQ });
      } },
    { id: 'offset-required', label: () => 'Timestamps must include a timezone (Z or ±HH:MM)', expected: () => 'Every created_at / updated_at / location.created_at ends with Z or ±HH:MM (RFC 3339).', assertion: () => `every timestamp matches ${TS_OFFSET}.`,
      async run(ctx) {
        const all = timestampsOf(await ctx.ref('listing'));
        const bad = all.filter((t) => !TS_OFFSET.test(t.v));
        ctx.check('All timestamps carry a timezone', bad.length === 0, { expected: 'Z or ±HH:MM on every timestamp', actual: bad.length ? `${bad.length} of ${all.length} without timezone, e.g. ${bad.slice(0, 3).map((t) => `${t.id}.${t.f}="${t.v}"`).join('; ')}` : 'all have a timezone', source: REQ });
      } },
  ],
  'TC-LST-031': [
    { id: 'threshold', params: [{ name: 'ms', label: 'Max response time (ms)', type: 'number', min: 1, max: 60000, default: 500 }],
      label: (p) => `Every request responds within ${p.ms} ms`, expected: (p) => `Each sampled request (list default, list limit=max, detail for up to 3 real ids) completes in ≤ ${p.ms} ms, measured client-side including network.`, assertion: (p) => `durationMs ≤ ${p.ms} for every sampled request.`,
      async run(ctx, p) {
        const rows = await dbRows(ctx);
        const reqs = [await ctx.get(L, { label: 'timing: default' }), await ctx.get(L, { query: { limit: ctx.param(L, 'limit').maximum }, label: 'timing: limit=max' })];
        for (const r of rows.slice(0, 3)) reqs.push(await ctx.get(item(r.id), { label: 'timing: detail' }));
        for (const r of reqs) ctx.check(`${r.path} within ${p.ms} ms`, r.durationMs <= p.ms, { expected: `≤ ${p.ms} ms`, actual: `${r.durationMs} ms (HTTP ${r.status})`, source: REQ });
      } },
  ],
  'TC-GET-008': [
    { id: 'redirect', label: () => 'Redirect to the collection endpoint is acceptable', expected: () => 'A 3xx redirect whose Location points to /api/v1/streamers.', assertion: () => 'status ∈ {301,302,307,308} AND new URL(Location).pathname === "/api/v1/streamers".',
      async run(ctx) {
        const r = await ctx.get(L + '/');
        ctx.check('Status is a redirect', [301, 302, 307, 308].includes(r.status), { expected: '301/302/307/308', actual: r.status, source: REQ });
        let loc = '';
        try { loc = new URL(r.headers.location || '', ctx.client.baseUrl).pathname; } catch { loc = r.headers.location || ''; }
        ctx.check('Redirects to /api/v1/streamers', loc === L, { expected: L, actual: r.headers.location || '(no Location header)', source: REQ });
      } },
    { id: 'not-found', label: () => 'Must return 404', expected: () => 'HTTP 404.', assertion: () => 'status === 404.', async run(ctx) { ctx.checkStatus(await ctx.get(L + '/'), 404, REQ); } },
    { id: 'invalid', label: () => 'Must return 422', expected: () => 'HTTP 422.', assertion: () => 'status === 422.', async run(ctx) { ctx.checkStatus(await ctx.get(L + '/'), 422, REQ); } },
  ],
  'TC-GET-009': [
    { id: 'exact-format', label: () => 'Message must be exactly "Streamer <id> not found"', expected: () => 'For an absent id, 404 with detail === "Streamer <id> not found".', assertion: () => 'status 404 AND body.detail === `Streamer ${id} not found`.',
      async run(ctx) {
        const id = await absentEightDigitId(ctx);
        await provenAbsent(ctx, id);
        ctx.input('streamer_id', id, 'Generated ID proven absent in the database');
        const r = await ctx.get(item(id));
        ctx.checkStatus(r, 404, REQ);
        ctx.check('detail has the required wording', r.json && r.json.detail === `Streamer ${id} not found`, { expected: `Streamer ${id} not found`, actual: r.json ? r.json.detail : r.bodyText.slice(0, 80), source: REQ });
      } },
    { id: 'no-echo', label: () => 'Message must not echo the raw input', expected: () => 'For absent ids (numeric and SQL-like), 404 and detail does not contain the submitted id.', assertion: () => 'status 404 AND !body.detail.includes(input) for each input.',
      async run(ctx) {
        for (const id of [await absentEightDigitId(ctx), "' OR '1'='1"]) {
          await provenAbsent(ctx, id);
          ctx.input('streamer_id', id, 'Generated ID proven absent in the database');
          const r = await ctx.get(item(id));
          ctx.checkStatus(r, 404, REQ);
          ctx.check(`detail does not echo "${id}"`, !(r.json && String(r.json.detail).includes(id)), { expected: 'input not in detail', actual: r.json ? r.json.detail : r.bodyText.slice(0, 80), source: REQ });
        }
      } },
  ],
  'TC-DB-009': [
    { id: 'baseline', label: () => 'Seeded baseline allowed: total ≥ Σ(earnings total + bonus)', expected: () => 'For each streamer with earnings rows, total_earnings_inr (API) ≥ sum of (total + bonus_amount) in the earnings table.', assertion: () => 'api.total_earnings_inr + 0.01 ≥ Σ(total + bonus_amount) per streamer (0.01 = one paisa rounding).',
      async run(ctx) { await earningsCheck(ctx, (a, s) => a + 0.01 >= s, '≥'); } },
    { id: 'equal', label: () => 'total must equal Σ(earnings total + bonus)', expected: () => 'For each streamer with earnings rows, total_earnings_inr (API) equals the sum of (total + bonus_amount) in the earnings table.', assertion: () => '|api.total_earnings_inr − Σ(total + bonus_amount)| ≤ 0.01 per streamer.',
      async run(ctx) { await earningsCheck(ctx, (a, s) => Math.abs(a - s) <= 0.01, '='); } },
  ],
  'TC-DB-010': [
    { id: 'ranges', label: () => 'pickup_rate 0–100; total_calls ≥ 0; total_earnings_inr ≥ 0', expected: () => 'Every API record and DB row: 0 ≤ pickup_rate ≤ 100, total_calls ≥ 0, total_earnings_inr ≥ 0.', assertion: () => 'Range check on every API record and every streamers row.',
      async run(ctx) {
        const listing = await ctx.ref('listing');
        const rows = await dbRows(ctx);
        const rules = [['pickup_rate', (v) => v >= 0 && v <= 100, '0–100'], ['total_calls', (v) => v >= 0, '≥ 0'], ['total_earnings_inr', (v) => v >= 0, '≥ 0']];
        for (const [f, ok, txt] of rules) {
          const badApi = listing.filter((r) => !ok(Number(r[f])));
          const badDb = rows.filter((r) => !ok(Number(r[f])));
          ctx.check(`API ${f} ${txt}`, badApi.length === 0, { expected: txt, actual: badApi.length ? badApi.map((r) => `${r.id}=${r[f]}`).join(', ') : 'all in range', source: REQ });
          ctx.dbStart(`${f} range in streamers`);
          ctx.check(`DB ${f} ${txt}`, badDb.length === 0, { expected: txt, actual: badDb.length ? badDb.map((r) => `${r.id}=${r[f]}`).join(', ') : 'all in range', source: `${REQ}; ${SRC.dbStreamers}` });
          ctx.dbEnd();
        }
      } },
  ],
  'TC-DB-011': [
    { id: 'pattern', params: [{ name: 'pattern', label: 'Required phone pattern (regular expression)', type: 'text', default: '^\\+91-\\d{10}$', hint: 'Examples: ^\\+91-\\d{10}$ (= +91-XXXXXXXXXX), ^\\+91\\d{10}$ (= +91XXXXXXXXXX)' }],
      label: (p) => `Every phone matches ${p.pattern}`, expected: (p) => `Every phone (API and DB) matches the regular expression ${p.pattern}.`, assertion: (p) => `new RegExp(${JSON.stringify(p.pattern)}).test(phone) for every API record and DB row. Values are masked in evidence.`,
      async run(ctx, p) {
        const re = new RegExp(p.pattern);
        const shape = (v) => String(v).replace(/\d/g, '9');
        const listing = await ctx.ref('listing');
        const rows = await dbRows(ctx);
        const badApi = listing.filter((r) => !re.test(String(r.phone)));
        const badDb = rows.filter((r) => !re.test(String(r.phone)));
        ctx.check('API phones match the required pattern', badApi.length === 0, { expected: p.pattern, actual: badApi.length ? `${badApi.length} of ${listing.length} do not match: ${badApi.map((r) => `${r.id} (shape ${shape(r.phone)})`).join(', ')}` : 'all match', source: REQ });
        ctx.dbStart('phone format in streamers');
        ctx.check('DB phones match the required pattern', badDb.length === 0, { expected: p.pattern, actual: badDb.length ? `${badDb.length} of ${rows.length} do not match: ${badDb.map((r) => `${r.id} (shape ${shape(r.phone)})`).join(', ')}` : 'all match', source: `${REQ}; ${SRC.dbStreamers}` });
        ctx.dbEnd();
      } },
  ],
  'TC-SEC-002': [
    { id: 'ignore', label: () => 'Invalid token is ignored on read endpoints', expected: () => 'HTTP 200 and the same records as without a token.', assertion: () => 'status === 200 AND ids(withInvalidToken) deep-equals ids(withoutToken).',
      async run(ctx) {
        const a = await ctx.get(L, { headers: { 'X-API-Token': 'qa-invalid-token' }, label: 'invalid token' });
        const b = await ctx.get(L, { label: 'no token' });
        ctx.checkStatus(a, 200, REQ);
        ctx.check('Same records as without a token', Array.isArray(a.json) && Array.isArray(b.json) && JSON.stringify(ids(a.json)) === JSON.stringify(ids(b.json)), { expected: Array.isArray(b.json) ? ids(b.json) : b.status, actual: Array.isArray(a.json) ? ids(a.json) : a.status, source: REQ });
      } },
    { id: 'reject', label: () => 'Invalid token must be rejected with 401', expected: () => 'HTTP 401.', assertion: () => 'status === 401.',
      async run(ctx) { ctx.checkStatus(await ctx.get(L, { headers: { 'X-API-Token': 'qa-invalid-token' }, label: 'invalid token' }), 401, REQ); } },
  ],
};

async function earningsCheck(ctx, ok, sym) {
  const listing = await ctx.ref('listing');
  const earnings = await ctx.ref('db:earnings');
  const sums = new Map();
  for (const e of earnings) sums.set(String(e.streamer_id), (sums.get(String(e.streamer_id)) || 0) + Number(e.total) + Number(e.bonus_amount));
  if (!sums.size) ctx.block('No earnings rows to compare', 'Test data unavailable');
  ctx.dbStart('total_earnings_inr vs earnings rows');
  for (const [sid, sum] of sums) {
    const rec = listing.find((r) => String(r.id) === sid);
    if (!rec) { ctx.check(`streamer ${sid} served by API`, false, { expected: 'present', actual: 'missing', source: SRC.dbEarnings }); continue; }
    ctx.check(`id ${sid}: total_earnings_inr ${sym} Σ(total+bonus)`, ok(Number(rec.total_earnings_inr), sum), { expected: `${sym} ${sum.toFixed(2)}`, actual: Number(rec.total_earnings_inr).toFixed(2), source: `${REQ}; ${SRC.dbEarnings}` });
  }
  ctx.dbEnd();
}

for (const c of cases) if (DECISIONS[c.id]) c.decisions = DECISIONS[c.id];

/** Validates reviewer-supplied parameters for an option; returns { params } or { error }. */
function resolveParams(option, raw = {}) {
  const params = {};
  for (const p of option.params || []) {
    let v = raw[p.name] === undefined || raw[p.name] === '' ? p.default : raw[p.name];
    if (p.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v) || v < p.min || v > p.max) return { error: `${p.label} must be a number between ${p.min} and ${p.max}` };
    } else {
      v = String(v).slice(0, 200);
      if (p.name === 'pattern') { try { new RegExp(v); } catch (e) { return { error: `Invalid regular expression: ${e.message}` }; } }
    }
    params[p.name] = v;
  }
  return { params };
}

/** The case as it should execute, applying a reviewer decision to a Needs Validation case. */
function effectiveCase(def, decision) {
  if (!decision || !def.decisions) return def;
  const opt = def.decisions.find((o) => o.id === decision.optionId);
  if (!opt) return def;
  const { params, error } = resolveParams(opt, decision.params);
  if (error) return def;
  const label = opt.label(params);
  return {
    ...def,
    validation: 'automated',
    defectBasis: 'requirement',
    expected: `${opt.expected(params)} (Reviewer requirement: "${label}")`,
    assertionLogic: `${opt.assertion(params)} Automatic.`,
    steps: [...def.steps, `Assert the reviewer requirement: ${label}.`],
    evidence: [`Reviewer requirement recorded ${decision.at}: "${label}"${decision.comment ? ` — comment: "${decision.comment}"` : ''}`, ...def.evidence],
    reviewerDecision: { ...decision, label, params },
    run: (ctx) => opt.run(ctx, params),
  };
}

module.exports = { cases, deepEqual, canonical, compareRows, compareRecord, buildMapping, sameValue, auditState, effectiveCase, resolveParams };
