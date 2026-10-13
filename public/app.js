'use strict';
/* Streamer API QA Dashboard — client. All data comes from the local framework server. */

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const fmtClock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) + '.' + String(new Date(iso).getMilliseconds()).padStart(3, '0') : '');

const S = {
  info: null,
  cases: [],
  run: null,          // run being viewed (full record incl. logs)
  activeRunId: null,
  runs: [],
  viewRunId: null,    // null = latest/current
  logs: [],
  systemLogs: [],
  selected: new Set(),
  expanded: new Set(),
  sort: { key: 'id', dir: 1 },
  page: 0,
  pageSize: 50,
  tab: 'passed',
  dialog: null,
  forms: {},          // per-case validation form state { optionId, params, comment }
  openItems: new Set(), // expanded result-tab items (kept open across re-renders)
};

// ------------------------------------------------------------------ API
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, body });
  return body;
}

async function loadAll() {
  const [info, runs] = await Promise.all([api('/api/info'), api('/api/runs')]);
  S.info = info;
  S.runs = runs.runs;
  S.activeRunId = runs.active;
  await loadRun();
  renderInfo();
  renderRunSelect();
}

async function loadRun() {
  const q = S.viewRunId ? `/api/runs/${S.viewRunId}` : '/api/runs/current';
  const [cur, cases] = await Promise.all([api(q), api(`/api/cases${S.viewRunId ? `?runId=${S.viewRunId}` : ''}`)]);
  S.run = cur.run;
  S.systemLogs = cur.systemLogs || [];
  S.logs = S.run ? S.run.logs.slice() : [];
  S.cases = cases.cases;
  renderAll();
}

// ------------------------------------------------------------------ derived status
function caseStatus(c) {
  if (!c.executable) return 'Needs Validation';
  if (!c.result) return 'Not Run';
  return c.result.status;
}
function statusClass(s) {
  return ({ Passed: 's-passed', Failed: 's-failed', Blocked: 's-blocked', 'Needs Validation': 's-nv', Running: 's-running', Queued: 's-queued', 'Not Executed': 's-idle', 'Not Run': 's-idle' })[s] || 's-idle';
}
function approvalLabel(a) {
  return ({ approved: 'Approved', rejected: 'Rejected', pending: 'Pending Review', 'needs-validation': 'Needs Validation' })[a.status] || a.status;
}
function approvalClass(a) {
  return ({ approved: 's-approved', rejected: 's-rejected', pending: 's-idle', 'needs-validation': 's-nv' })[a.status] || 's-idle';
}
function defectFor(c) {
  return c.result && c.result.bugId && S.run ? S.run.defects.find((d) => d.bugId === c.result.bugId) : null;
}
function actualText(c) {
  if (!c.executable) return `Not Run — Needs Validation: ${c.nvReason || ''}`;
  const r = c.result;
  if (!r) return 'Not Run';
  if (r.status === 'Queued') return 'Not Run (queued)';
  if (r.status === 'Running') return 'Running…';
  if (r.status === 'Not Executed') return `Not Run — ${r.finalReason || 'not executed'}`;
  const last = r.attempts[r.attempts.length - 1];
  if (!last) return '—';
  if (r.status === 'Passed') return `All ${last.assertions.length} assertion(s) passed on ${last.kind.toLowerCase()}${r.intermittent ? ' (earlier attempt(s) failed — intermittent)' : ''}.`;
  if (r.status === 'Failed') return last.assertions.filter((a) => !a.passed).map((a) => `${a.name}: ${a.actual}`).join('\n');
  return `${r.blockedCategory || last.failureCategory}: ${last.failureReason}`;
}
function failureText(c) {
  const r = c.result;
  if (!r || r.status === 'Passed' || r.status === 'Queued' || r.status === 'Running') return r && r.intermittent ? r.intermittentNote : '—';
  if (r.status === 'Not Executed') return r.finalReason || '—';
  return `[${r.failureCategory || ''} @ ${r.failureStage || ''}] ${r.finalReason || ''}`;
}

const COLS = [
  { key: 'id', label: 'Test Case ID', sort: (c) => c.id, cls: 'sticky2' },
  { key: 'scenario', label: 'Test Scenario', sort: (c) => c.scenario, html: (c) => `<div class="clamp"><b>${esc(c.scenario)}</b><br><span class="muted small">${esc(c.category)}</span></div>` },
  { key: 'description', label: 'Test Case Description', text: (c) => c.description },
  { key: 'endpoint', label: 'API Endpoint', sort: (c) => c.endpoint, text: (c) => c.endpoint },
  { key: 'related', label: 'Related API Parameter, Field, or Database Entity', text: (c) => c.related },
  { key: 'environment', label: 'Test Environment and Setup', text: (c) => c.environment },
  { key: 'preconditions', label: 'Preconditions and Test Data Source', text: (c) => c.preconditions },
  { key: 'steps', label: 'Steps to Test', text: (c) => c.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') },
  { key: 'expected', label: 'Expected Results', text: (c) => c.expected },
  { key: 'actual', label: 'Actual Results', text: actualText },
  { key: 'assertion', label: 'Assertion Logic and Validation Method', text: (c) => c.assertionLogic },
  { key: 'evidence', label: 'Evidence or Reference Source', text: (c) => c.evidence.join('\n') },
  { key: 'status', label: 'Test Status', sort: caseStatus, html: (c) => `<span class="badge ${statusClass(caseStatus(c))}">${esc(caseStatus(c))}</span>${c.result && c.result.intermittent ? '<br><span class="badge s-warn">intermittent</span>' : ''}` },
  { key: 'bug', label: 'Bug or Defect Details', text: (c) => { const d = defectFor(c); return d ? `${d.bugId}: ${d.verification}\n${d.summary}` : '—'; } },
  { key: 'repro', label: 'Steps to Reproduce the Bug', text: (c) => { const d = defectFor(c); return d ? d.stepsToReproduce.join('\n') : '—'; } },
  { key: 'severity', label: 'Severity', text: (c) => (defectFor(c) ? 'Unassigned — Needs Review' : 'Unassigned') },
  { key: 'priority', label: 'Priority', text: (c) => (defectFor(c) ? 'Unassigned — Needs Review' : 'Unassigned') },
  { key: 'retries', label: 'Retry Count', sort: (c) => (c.result ? c.result.retryCount : -1), text: (c) => (c.result && c.result.attempts.length ? String(c.result.retryCount) : c.executable ? '0 (not run)' : 'n/a') },
  { key: 'failure', label: 'Failure Reason', text: failureText },
  { key: 'approval', label: 'Approval Status', sort: (c) => c.approval.status, html: approvalCell },
];

function approvalCell(c) {
  const a = c.approval;
  const busy = !!S.activeRunId;
  return `<span class="badge ${approvalClass(a)}">${esc(approvalLabel(a))}</span>${a.stale ? '<br><span class="small muted">definition changed — re-review</span>' : ''}
    ${a.comment ? `<div class="small muted" title="Reviewer comment">“${esc(a.comment.slice(0, 80))}${a.comment.length > 80 ? '…' : ''}”</div>` : ''}
    <div class="cell-actions">
      <button type="button" class="icon approve" data-act="approve" data-id="${esc(c.id)}" ${!c.executable || a.status === 'approved' || busy ? 'disabled' : ''} title="${c.executable ? 'Approve' : 'Needs Validation cases cannot be approved'}" aria-label="Approve ${esc(c.id)}">✓</button>
      <button type="button" class="icon reject" data-act="reject" data-id="${esc(c.id)}" ${a.status === 'rejected' || busy ? 'disabled' : ''} aria-label="Reject ${esc(c.id)}">✗</button>
    </div>`;
}

// ------------------------------------------------------------------ rendering: info
function renderInfo() {
  const d = S.info && S.info.discovery;
  const cfg = S.info && S.info.config;
  $('#target-line').textContent = cfg ? `Target ${cfg.apiBaseUrl} · GET only · ${cfg.rateLimitPerSecond} req/s shared limit · max ${cfg.maxRetries} retries` : '';
  if (!d || !d.available) {
    $('#api-info-status').textContent = d && d.running ? 'Discovery running…' : 'Discovery not available yet';
    $('#api-info-body').innerHTML = `<p class="muted">${d && d.running ? 'Probing the live contract and database access…' : 'No discovery result.'}</p><button type="button" id="btn-rediscover">Refresh discovery</button>`;
    return;
  }
  const api = d.api;
  const db = d.db;
  $('#api-info-status').textContent = `Discovered ${fmtTime(d.finishedAt)} (${d.source}) · contract ${api.contract.available ? 'available' : 'UNAVAILABLE'} · database access: ${db.access}`;
  const V = '<span class="fact verified">Verified</span>';
  const U = '<span class="fact unresolved">Unresolved</span>';
  const B = '<span class="fact blocked">Blocked</span>';
  const ep = (e) => `
    <div class="info-block">
      <h3>${esc(e.method)} <span class="mono">${esc(e.path)}</span></h3>
      <p>${V}<b>${esc(e.summary)}</b> (contract summary).</p>
      <p class="small">${esc((e.description || '').replace(/[*#`]/g, '').split('\n').filter(Boolean).slice(0, 3).join(' '))}</p>
      <table class="params"><thead><tr><th>Parameter</th><th>In</th><th>Type / constraints</th><th>Meaning (contract)</th></tr></thead><tbody>
      ${e.parameters.map((p) => `<tr><td class="mono">${esc(p.name)}${p.required ? ' *' : ''}</td><td>${esc(p.in)}</td><td>${esc(p.type)}${p.enum ? ` ∈ {${esc(p.enum.join(', '))}}` : ''}${p.minimum !== undefined ? `, min ${p.minimum}` : ''}${p.maximum !== undefined ? `, max ${p.maximum}` : ''}${p.default !== undefined ? `, default ${p.default}` : ''}</td><td>${esc(p.description)}</td></tr>`).join('')}
      </tbody></table>
      <p class="small">${V}Documented responses: ${e.responses.map((r) => `<b>${esc(r.code)}</b> ${esc(r.schema || '')}`).join(' · ')}. Security requirement: ${e.security ? esc(JSON.stringify(e.security)) : 'none declared'}.</p>
    </div>`;
  const cfgDb = d.dbConfig || {};
  const tbl = (name) => (db.tables || []).find((t) => t.name === name);
  const st = tbl('streamers');
  const tableRow = (t) => `<tr><td class="mono">${esc(t.name)}</td><td>${t.sensitive ? '<span class="fact unresolved">not read</span> contains credentials' : t.rowCount === null ? '—' : esc(t.rowCount)}</td><td class="mono">${esc(t.primaryKey.join(', ') || '—')}</td><td class="mono">${esc(t.unique.map((u) => u.column).join(', ') || '—')}</td><td class="mono">${esc(t.foreignKeys.map((f) => `${f.column} → ${f.refTable}.${f.refColumn}`).join('; ') || '—')}</td></tr>`;
  const colRow = (c) => `<tr><td class="mono">${esc(c.name)}</td><td class="mono">${esc(c.type)}</td><td>${c.nullable ? 'NULL' : 'NOT NULL'}</td><td>${esc(c.key || '')}</td></tr>`;
  $('#api-info-body').innerHTML = `
    <div class="info-grid">
      ${api.endpoints.map(ep).join('')}
      <div class="info-block">
        <h3>Resource represented</h3>
        <p>${V}Streamer records (contract schema <span class="mono">StreamerOut</span>): id, name, phone, email (nullable), embedded location (<span class="mono">LocationOut</span>), tier, status, total_earnings_inr, total_calls, pickup_rate, created_at, updated_at. Stored in the <span class="mono">streamers</span> table, with the location in <span class="mono">locations</span>.</p>
        <p>${V}Service: ${esc(api.service && api.service.service)} ${esc(api.service && api.service.version)}. The service reports its database as "${esc(api.service && api.service.database)}".</p>
        <h3>Documentation & contract (Swagger)</h3>
        <ul>
          <li>${api.contract.available ? V : B}OpenAPI ${esc(api.contract.openapi || '')} contract: <a href="${esc(d.api.docsUrls.openapi)}" target="_blank" rel="noopener">${esc(d.api.docsUrls.openapi)}</a> (${esc(api.contract.title || '')} ${esc(api.contract.version || '')})</li>
          <li>Swagger UI: <a href="${esc(d.api.docsUrls.swagger)}" target="_blank" rel="noopener">${esc(d.api.docsUrls.swagger)}</a> · ReDoc: <a href="${esc(d.api.docsUrls.redoc)}" target="_blank" rel="noopener">${esc(d.api.docsUrls.redoc)}</a></li>
          <li class="small muted">The contract also documents ${api.otherOperations.length} other operations (writes, earnings, locations, stats, db inspection, auth). Only the two endpoints above are tested, and write operations are never called.</li>
        </ul>
      </div>
      <div class="info-block">
        <h3>Database used for validation</h3>
        ${db.connected ? `<p>${V}<b>${esc(db.version)}</b>, database <span class="mono">${esc(db.database)}</span>, reached ${esc(cfgDb.via || '')}. Access is read-only: single SELECT statements, at most ${esc(S.info.config.rateLimitPerSecond)} operations per second shared with API calls. Credentials are read from ${esc(cfgDb.credentialsSource || '.env')} and never shown.</p>`
          : `<p>${B}<b>Database NOT connected:</b> ${esc(db.error || 'unknown reason')}. Database-dependent cases will be Blocked.</p>`}
        ${db.documentedBySwagger ? `<p class="small">${U}The Swagger description says the data is in a ${esc(db.documentedBySwagger.engine)} file (<span class="mono">${esc(db.documentedBySwagger.file)}</span>). ${db.connected ? 'The connected database is MariaDB, and its streamers IDs are compared with the API in TC-DB-002, so the documentation note looks out of date.' : ''}</p>` : ''}
        ${db.connected ? `<table class="params"><thead><tr><th>Table</th><th>Rows</th><th>Primary key</th><th>Unique</th><th>Foreign keys</th></tr></thead><tbody>${db.tables.map(tableRow).join('')}</tbody></table>` : ''}
        ${st ? `<details class="sub"><summary>streamers columns (${st.columns.length})</summary><table class="params"><thead><tr><th>Column</th><th>Type</th><th>Null</th><th>Key</th></tr></thead><tbody>${st.columns.map(colRow).join('')}</tbody></table></details>` : ''}
        ${tbl('locations') ? `<details class="sub"><summary>locations columns (${tbl('locations').columns.length})</summary><table class="params"><thead><tr><th>Column</th><th>Type</th><th>Null</th><th>Key</th></tr></thead><tbody>${tbl('locations').columns.map(colRow).join('')}</tbody></table></details>` : ''}
      </div>
      <div class="info-block">
        <h3>API ↔ database relationships</h3>
        <p class="small muted">Badges: Verified = established from the live contract or database schema. Blocked = the source was not available. Unresolved = not established. Whether the data actually honours each relationship is checked by the test cases listed, not by this panel.</p>
        <ul>
          <li>${st ? V : B}<span class="mono">streamers</span> table ↔ both endpoints. Row count, ID set and field-by-field values are compared (TC-DB-001/002/003/014).</li>
          <li>${st ? V : B}Field mapping: an API field maps to the column with the identical name in <span class="mono">information_schema</span>. Unmatched fields are listed but not asserted.</li>
          <li>${(db.relationships || []).some((r) => r.from === 'streamers.location_id') ? V : B}<span class="mono">StreamerOut.location</span> ↔ <span class="mono">locations</span> row via the declared FK <span class="mono">streamers.location_id → locations.id</span> (TC-DB-004, city filter TC-LST-019).</li>
          <li>${(db.relationships || []).some((r) => r.from === 'earnings.streamer_id') ? V : B}Declared FK <span class="mono">earnings.streamer_id → streamers.id</span>. Each referenced ID must resolve through the detail endpoint (TC-DB-005).</li>
          <li>${tbl('audit_log') ? V : B}<span class="mono">audit_log.resource_id</span> → streamers write history, read in full from the table (TC-DB-006/007/008).</li>
          <li>${st ? V : B}Contract enums/types/nullability ↔ column definitions (TC-DB-012/013).</li>
        </ul>
      </div>
      <div class="info-block">
        <h3>Limitations affecting testing</h3>
        <ul>
          ${!db.connected ? `<li>${B}No database connection: ${esc(db.error || '')}</li>` : ''}
          <li>${U}The <span class="mono">users</span> table holds credentials (password_hash, api_token). Its rows are never read; only its column names are listed.</li>
          <li>${U}Comparisons prove that the API and the database are consistent. They do not prove the stored values are correct for the business.</li>
          <li>${B}No write/delete operations are authorised. Behaviour when the database is unavailable cannot be tested safely.</li>
          <li>${U}No response-time threshold and no severity/priority policy were supplied.</li>
        </ul>
        <button type="button" id="btn-rediscover" ${d.running || S.activeRunId ? 'disabled' : ''}>Refresh discovery</button>
      </div>
    </div>`;
}

// ------------------------------------------------------------------ rendering: review table
function filteredCases() {
  const q = $('#f-search').value.trim().toLowerCase();
  const ep = $('#f-endpoint').value;
  const cat = $('#f-category').value;
  const ap = $('#f-approval').value;
  const st = $('#f-status').value;
  let list = S.cases.filter((c) => {
    if (ep && c.endpoint !== ep) return false;
    if (cat && c.category !== cat) return false;
    if (ap && c.approval.status !== ap) return false;
    if (st && caseStatus(c) !== st) return false;
    if (q) {
      const hay = [c.id, c.scenario, c.description, c.related, c.expected, c.evidence.join(' '), c.category, c.endpoint, actualText(c)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const col = COLS.find((x) => x.key === S.sort.key);
  const keyFn = col && (col.sort || col.text);
  if (keyFn) list = list.slice().sort((a, b) => { const x = keyFn(a); const y = keyFn(b); return (x > y ? 1 : x < y ? -1 : 0) * S.sort.dir; });
  return list;
}

function fillSelect(sel, values) {
  const cur = sel.value;
  const first = sel.options[0].outerHTML;
  sel.innerHTML = first + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  sel.value = values.includes(cur) ? cur : '';
}

function renderReview() {
  fillSelect($('#f-endpoint'), [...new Set(S.cases.map((c) => c.endpoint))].sort());
  fillSelect($('#f-category'), [...new Set(S.cases.map((c) => c.category))].sort());
  fillSelect($('#f-status'), ['Not Run', 'Queued', 'Running', 'Passed', 'Failed', 'Blocked', 'Not Executed', 'Needs Validation']);

  const n = (fn) => S.cases.filter(fn).length;
  $('#review-counts').innerHTML = [
    ['Generated', S.cases.length, 's-info'],
    ['Pending review', n((c) => c.approval.status === 'pending'), 's-idle'],
    ['Approved', n((c) => c.approval.status === 'approved'), 's-approved'],
    ['Rejected', n((c) => c.approval.status === 'rejected'), 's-rejected'],
    ['Needs Validation', n((c) => !c.executable), 's-nv'],
    ['Executable', n((c) => c.executable), 's-queued'],
  ].map(([l, v, cls]) => `<span class="badge ${cls}">${esc(l)}: ${v}</span>`).join('');

  const list = filteredCases();
  const pages = Math.max(1, Math.ceil(list.length / S.pageSize));
  S.page = Math.min(S.page, pages - 1);
  const slice = list.slice(S.page * S.pageSize, (S.page + 1) * S.pageSize);
  const allSel = slice.length && slice.every((c) => S.selected.has(c.id));

  $('#cases-table thead').innerHTML = `<tr>
    <th class="sticky"><input type="checkbox" id="sel-page" ${allSel ? 'checked' : ''} aria-label="Select all rows on this page"></th>
    ${COLS.map((c) => `<th class="${c.cls || ''} sortable" data-sort="${c.key}" scope="col">${esc(c.label)}${S.sort.key === c.key ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}
  </tr>`;
  $('#cases-table tbody').innerHTML = slice.map((c) => {
    const open = S.expanded.has(c.id);
    const cells = COLS.map((col) => {
      if (col.key === 'id') return `<td class="sticky2 mono"><b>${esc(c.id)}</b></td>`;
      const inner = col.html ? col.html(c) : `<div class="clamp">${esc(col.text(c))}</div>`;
      return `<td>${inner}</td>`;
    }).join('');
    return `<tr class="${S.selected.has(c.id) ? 'selected' : ''}">
      <td class="sticky"><input type="checkbox" data-sel="${esc(c.id)}" ${S.selected.has(c.id) ? 'checked' : ''} aria-label="Select ${esc(c.id)}">
        <button type="button" class="icon" data-expand="${esc(c.id)}" aria-expanded="${open}" aria-label="Toggle details for ${esc(c.id)}">${open ? '▾' : '▸'}</button></td>
      ${cells}</tr>
      ${open ? `<tr class="detail-row"><td colspan="${COLS.length + 1}">${caseDetail(c)}</td></tr>` : ''}`;
  }).join('') || `<tr><td colspan="${COLS.length + 1}" class="empty">No test cases match the filters.</td></tr>`;

  $('#pager-info').textContent = `${list.length} case(s) match · page ${S.page + 1} of ${pages}`;
  $('#pg-prev').disabled = S.page === 0;
  $('#pg-next').disabled = S.page >= pages - 1;
  $('#sel-count').textContent = `${S.selected.size} selected`;
  const busy = !!S.activeRunId;
  ['#btn-approve-sel', '#btn-reject-sel', '#btn-pending-sel'].forEach((b) => { $(b).disabled = !S.selected.size || busy; });
  ['#btn-approve-shown', '#btn-reject-shown'].forEach((b) => { $(b).disabled = !list.length || busy; });
}

function kv(label, value) {
  return `<div class="kv"><b>${esc(label)}</b><div>${esc(value)}</div></div>`;
}

function attemptsHtml(r) {
  if (!r || !r.attempts || !r.attempts.length) return '<p class="muted small">No attempts recorded.</p>';
  return r.attempts.map((a) => `
    <div class="attempt ${a.outcome === 'passed' ? 'ok' : a.outcome === 'failed' ? 'bad' : 'blk'}">
      <div><b>${esc(a.kind)}</b> (attempt ${a.attempt}) · <span class="badge ${a.outcome === 'passed' ? 's-passed' : a.outcome === 'failed' ? 's-failed' : 's-blocked'}">${esc(a.outcomeLabel)}</span>
        <span class="small muted">${fmtTime(a.startedAt)} → ${fmtClock(a.endedAt)}</span></div>
      ${a.failureReason ? `<div class="small"><b>Failure</b> [${esc(a.failureCategory)} @ stage "${esc(a.failureStage)}"]: ${esc(a.failureReason)}</div>` : ''}
      ${a.notRetriedBecause ? `<div class="small muted">Not retried: ${esc(a.notRetriedBecause)}</div>` : ''}
      ${a.assertions.length ? `<details class="sub" ${a.outcome === 'failed' ? 'open' : ''}><summary>Assertions (${a.assertions.filter((x) => x.passed).length}/${a.assertions.length} passed)</summary><ul class="assert-list">
        ${a.assertions.map((x) => `<li><span class="badge ${x.passed ? 's-passed' : 's-failed'}">${x.passed ? 'PASS' : 'FAIL'}</span> ${x.stage === 'db-validation' ? '<span class="badge s-queued">DB</span> ' : ''}<b>${esc(x.name)}</b><br><span class="small">Expected: ${esc(x.expected)}<br>Actual: ${esc(x.actual)}${x.source ? `<br><span class="muted">Source: ${esc(x.source)}</span>` : ''}</span></li>`).join('')}
      </ul></details>` : ''}
      ${a.inputs && a.inputs.length ? `<div class="small"><b>Generated inputs (synthetic, disclosed):</b> ${a.inputs.map((i) => `${esc(i.label)} = <span class="mono">${esc(i.value)}</span>`).join('; ')}</div>` : ''}
      ${a.notes && a.notes.length ? `<div class="small muted">${a.notes.map(esc).join('<br>')}</div>` : ''}
      ${requestsHtml(a.requests)}${dbQueriesHtml(a.dbQueries)}
    </div>`).join('');
}

function requestsHtml(reqs) {
  if (!reqs || !reqs.length) return '';
  return `<details class="sub"><summary>Request / response evidence (${reqs.length})</summary>
    ${reqs.map((q) => `<div class="small"><span class="mono">${esc(q.method)} ${esc(q.url)}</span> → <b>HTTP ${esc(q.status)}</b> in ${esc(q.durationMs)} ms · ${esc(q.headers['content-type'] || '')}${q.label ? ` · ${esc(q.label)}` : ''}</div>
      <pre class="evidence">${esc(prettyBody(q.body))}</pre>`).join('')}
  </details>`;
}
function dbQueriesHtml(qs) {
  if (!qs || !qs.length) return '';
  return `<details class="sub"><summary>Database query evidence (${qs.length})</summary>
    ${qs.map((q) => `<div class="small"><span class="badge s-queued">SQL</span> ${esc(q.purpose)} · <b>${esc(q.rows)} row(s)</b> in ${esc(q.ms)} ms · ${esc(fmtTime(q.at))}</div>
      <pre class="evidence">${esc(q.sql)}${q.params && q.params.length ? '\n-- params: ' + esc(JSON.stringify(q.params)) : ''}${q.sample ? '\n-- sample rows (PII masked): ' + esc(q.sample.slice(0, 1500)) : ''}</pre>`).join('')}
  </details>`;
}

function prettyBody(b) {
  try { return JSON.stringify(JSON.parse(b), null, 1).slice(0, 6000); } catch { return String(b || '(empty body)').slice(0, 6000); }
}

function caseDetail(c) {
  const d = defectFor(c);
  return `<div class="detail-grid">
      ${kv('Scenario', c.scenario)}${kv('Category', c.category)}${kv('Endpoint', c.endpoint)}
      ${kv('Description', c.description)}${kv('Related parameter / field / DB entity', c.related)}
      ${kv('Test environment and setup', c.environment)}${kv('Preconditions and test data source', c.preconditions)}
      ${kv('Steps to test', c.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'))}
      ${kv('Expected results', c.expected)}${kv('Assertion logic and validation method', c.assertionLogic)}
      ${kv('Evidence / reference sources', c.evidence.join('\n'))}
      ${kv('Defect basis', c.executable ? `${c.defectBasis} — ${c.defectBasis === 'derived' ? 'reproducible failures are reported as suspected (need human confirmation)' : 'reproducible failures are reported as confirmed defects'}` : 'n/a (not executed)')}
      ${c.nvReason ? kv('Why Needs Validation', c.nvReason) : ''}
      ${kv('Approval', `${approvalLabel(c.approval)}${c.approval.at ? ` · ${fmtTime(c.approval.at)}` : ''}${c.approval.comment ? `\nComment: ${c.approval.comment}` : ''}`)}
      ${kv('Actual results', actualText(c))}${kv('Failure reason', failureText(c))}
      ${d ? kv('Defect', `${d.bugId} — ${d.verification}`) : ''}
    </div>
    ${c.result ? `<h4>Attempt history</h4>${attemptsHtml(c.result)}` : ''}
    ${c.decisionOptions ? validationPanelHtml(c) : ''}`;
}

function formState(c) {
  if (!S.forms[c.id]) {
    const d = c.reviewerDecision;
    S.forms[c.id] = { optionId: d ? d.optionId : '', params: d ? { ...d.params } : {}, comment: d ? d.comment || '' : '' };
  }
  return S.forms[c.id];
}

function checkHtml(k) {
  const cls = k.outcome === 'Passed' ? 's-passed' : k.outcome === 'Failed' ? 's-failed' : 's-blocked';
  return `<div class="attempt ${k.outcome === 'Passed' ? 'ok' : k.outcome === 'Failed' ? 'bad' : 'blk'}">
    <div><span class="badge ${cls}">${esc(k.outcome)}</span> <b>Expected:</b> ${esc(k.label)} <span class="small muted">· preview check ${esc(fmtTime(k.at))} · not part of an automation run</span></div>
    <div class="small"><b>Expected result:</b> ${esc(k.expected)}</div>
    ${k.reason && k.outcome !== 'Failed' ? `<div class="small"><b>Reason:</b> ${esc(k.reason)}</div>` : ''}
    <ul class="assert-list">${(k.assertions || []).map((x) => `<li><span class="badge ${x.passed ? 's-passed' : 's-failed'}">${x.passed ? 'PASS' : 'FAIL'}</span> <b>${esc(x.name)}</b><br><span class="small">Expected: ${esc(x.expected)}<br>Actual: ${esc(x.actual)}</span></li>`).join('')}</ul>
    ${k.notes && k.notes.length ? `<div class="small muted">${k.notes.map(esc).join('<br>')}</div>` : ''}
    ${requestsHtml(k.requests)}${dbQueriesHtml(k.dbQueries)}
  </div>`;
}

function validationPanelHtml(c) {
  const f = formState(c);
  const d = c.reviewerDecision;
  const opts = c.decisionOptions.map((o) => `
    <label class="opt">
      <input type="radio" name="dec-${esc(c.id)}" value="${esc(o.id)}" data-form-case="${esc(c.id)}" data-form-field="optionId" ${f.optionId === o.id ? 'checked' : ''}>
      <span><b>${esc(o.label)}</b><br><span class="small">Expected: ${esc(o.expected)}</span><br><span class="small muted">Assertion: ${esc(o.assertion)}</span>
      ${o.params.map((p) => `<br><span class="small">${esc(p.label)}: <input type="${p.type === 'number' ? 'number' : 'text'}" data-form-case="${esc(c.id)}" data-form-param="${esc(p.name)}" value="${esc(f.params[p.name] !== undefined ? f.params[p.name] : p.default)}" ${p.type === 'number' ? `min="${p.min}" max="${p.max}"` : 'size="28"'}></span>${p.hint ? `<br><span class="small muted">${esc(p.hint)}</span>` : ''}`).join('')}</span>
    </label>`).join('');
  return `<div class="validate">
    ${d ? `<div class="notice info">Requirement saved ${esc(fmtTime(d.at))}: <b>${esc(d.label)}</b>${d.comment ? ` — "${esc(d.comment)}"` : ''}. This case is now executable: approve it, then Start Automation to get the official Pass/Fail.</div>` : ''}
    <h4>Step 1 — Run it and see the actual result</h4>
    <button type="button" data-observe="${esc(c.id)}">▶ Observe now (actual result, no pass/fail)</button>
    ${(c.observations || []).slice(0, 2).map((o) => `<div class="attempt blk"><div class="small"><b>Actual result</b> ${fmtTime(o.at)}${o.error ? ` · <span class="badge s-warn">${esc(o.error)}</span>` : ''}</div>
      ${o.notes && o.notes.length ? `<div class="small">${o.notes.map(esc).join('<br>')}</div>` : ''}${(o.requests || []).filter((q) => !q.label.includes('reused')).map((q) => `<div class="small"><span class="mono">GET ${esc(q.url.replace(/^https?:\/\/[^/]+/, ''))}</span> → <b>HTTP ${esc(q.status)}</b> · ${esc(q.durationMs)} ms${q.headers.location ? ' · Location: ' + esc(q.headers.location) : ''}</div>`).join('')}
      ${requestsHtml(o.requests)}${dbQueriesHtml(o.dbQueries)}</div>`).join('')}
    <h4>Step 2 — Choose the expected behaviour and check it (expected vs actual)</h4>
    <div class="opts">${opts}</div>
    <button type="button" data-check="${esc(c.id)}" ${f.optionId ? '' : 'disabled'}>✓ Check now: expected vs actual</button>
    <span class="small muted">Runs the chosen assertion once against the live API/DB. Preview only; it is not recorded as an automation run.</span>
    ${(c.checks || []).slice(0, 3).map(checkHtml).join('')}
    <h4>Step 3 — Save as requirement</h4>
    <textarea rows="2" maxlength="1000" placeholder="Why is this the expected behaviour? (optional)" data-form-case="${esc(c.id)}" data-form-field="comment">${esc(f.comment)}</textarea>
    <div class="row" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
      <button type="button" class="approve" data-save-decision="${esc(c.id)}" ${f.optionId && !S.activeRunId ? '' : 'disabled'}>Save as requirement</button>
      ${d ? `<button type="button" class="reject" data-clear-decision="${esc(c.id)}" ${S.activeRunId ? 'disabled' : ''}>Clear requirement (back to Needs Validation)</button>` : ''}
    </div>
    <p class="small muted">After saving, the case moves to Pending Review in the Test Case Review table. Approve it and Start Automation to record the official Pass/Fail with retries, logs and bug reporting.</p>
  </div>`;
}

function observationsHtml(c) {
  return `<div style="margin-top:8px"><button type="button" data-observe="${esc(c.id)}">Observe now (no assertion)</button>
    <span class="small muted">Sends the real request(s) through the shared rate limiter and records the response for human review. Status stays Needs Validation.</span>
    ${(c.observations || []).map((o) => `<div class="attempt blk"><div class="small"><b>Observation</b> ${fmtTime(o.at)}${o.error ? ` · <span class="badge s-warn">${esc(o.error)}</span>` : ''}</div>
      ${o.notes && o.notes.length ? `<div class="small">${o.notes.map(esc).join('<br>')}</div>` : ''}${requestsHtml(o.requests)}${dbQueriesHtml(o.dbQueries)}</div>`).join('')}</div>`;
}

// ------------------------------------------------------------------ automation + logs
function eligibleCount() {
  return S.cases.filter((c) => c.executable && c.approval.status === 'approved').length;
}

function renderAutomation() {
  const run = S.run;
  const live = run && run.runId === S.activeRunId;
  const elig = eligibleCount();
  const nv = S.cases.filter((c) => !c.executable).length;
  const rej = S.cases.filter((c) => c.approval.status === 'rejected').length;
  const pend = S.cases.filter((c) => c.approval.status === 'pending').length;
  $('#auto-eligibility').textContent = `${elig} approved executable case(s) will run. Excluded: ${pend} pending review, ${rej} rejected, ${nv} Needs Validation.`;
  $('#btn-start').disabled = !!S.activeRunId || elig === 0;
  $('#btn-start').title = S.activeRunId ? 'A run is already active' : elig === 0 ? 'Approve at least one executable test case first' : 'Execute approved cases against the live API';
  $('#btn-stop').disabled = !live || (run && run.stopRequested);

  const hdr = $('#header-run-state');
  if (!run) {
    $('#run-state').textContent = 'No run has been executed yet.';
    hdr.className = 'badge s-idle'; hdr.textContent = 'No run';
    $('#progress-bar').style.width = '0';
    $('#progress-text').textContent = '';
    return;
  }
  const res = Object.values(run.results);
  const done = res.filter((r) => ['Passed', 'Failed', 'Blocked', 'Not Executed'].includes(r.status)).length;
  const running = res.filter((r) => r.status === 'Running').map((r) => r.caseId);
  const label = run.status === 'running' ? (run.stopRequested ? 'Stopping…' : `Running (${run.phase})`) : { completed: 'Completed', stopped: 'Stopped', interrupted: 'Interrupted', error: 'Error' }[run.status] || run.status;
  const cls = run.status === 'running' ? 's-running' : run.status === 'completed' ? 's-passed' : run.status === 'error' ? 's-failed' : 's-blocked';
  hdr.className = `badge ${cls}`; hdr.textContent = `${run.runId.slice(0, 19)} · ${label}`;
  $('#run-state').innerHTML = `<span class="badge ${cls}">${esc(label)}</span> <span class="mono">${esc(run.runId)}</span> · started ${fmtTime(run.startedAt)}${run.endedAt ? ` · ended ${fmtTime(run.endedAt)}` : ''}${running.length ? ` · executing ${esc(running.join(', '))}` : ''}${run.error ? ` · <span class="badge s-failed">${esc(run.error.split('\n')[0])}</span>` : ''}${S.viewRunId && run.runId !== S.activeRunId ? ' · <i>historical run</i>' : ''}`;
  $('#progress-bar').style.width = `${res.length ? Math.round((done / res.length) * 100) : 0}%`;
  const notExec = res.filter((r) => r.status === 'Not Executed').length;
  $('#progress-text').textContent = `${done} / ${res.length} eligible case(s) reached a final status${notExec ? ` (${notExec} not executed)` : ''}`;
}

function logLine(e) {
  return `<div class="log${e.system ? ' system' : ''}"><span class="t">${esc(fmtClock(e.ts))}</span><span class="c">${esc(e.caseId || (e.system ? 'system' : 'run'))}</span><span class="st">${esc(e.stage)}</span><span class="lv lv-${esc(e.status)}">${esc(e.status)}</span><span class="m">${esc(e.message)}</span></div>`;
}
function visibleLogs() {
  const q = $('#log-filter').value.trim().toLowerCase();
  const lv = $('#log-level').value;
  const sys = $('#log-system').checked;
  const all = (sys ? [...S.systemLogs, ...S.logs] : S.logs).slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return all.filter((e) => (!lv || e.status === lv) && (!q || `${e.caseId} ${e.stage} ${e.message}`.toLowerCase().includes(q))).slice(-3000);
}
function renderLogs() {
  const box = $('#logs');
  const list = visibleLogs();
  box.innerHTML = list.map(logLine).join('') || '<div class="log" id="log-empty"><span class="m">No events yet. Events appear here only as they actually occur.</span></div>';
  $('#log-count').textContent = `${list.length} event(s)`;
  if ($('#log-autoscroll').checked) box.scrollTop = box.scrollHeight;
}
function appendLog(e) {
  if (e.system) S.systemLogs.push(e); else if (S.run && e.runId === S.run.runId) S.logs.push(e); else return;
  const q = $('#log-filter').value.trim();
  const lv = $('#log-level').value;
  if (q || lv || (e.system && !$('#log-system').checked)) return renderLogs();
  const box = $('#logs');
  const empty = document.getElementById('log-empty'); if (empty) empty.remove();
  box.insertAdjacentHTML('beforeend', logLine(e));
  $('#log-count').textContent = `${box.children.length} event(s)`;
  if ($('#log-autoscroll').checked) box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------------ summary + tabs
function tallies() {
  const run = S.run;
  const inRun = run ? run.eligibleIds : [];
  const by = (st) => (run ? inRun.filter((id) => run.results[id] && run.results[id].status === st).length : 0);
  return {
    generated: S.cases.length,
    eligible: inRun.length,
    passed: by('Passed'),
    failed: by('Failed'),
    blocked: by('Blocked'),
    notExecuted: by('Not Executed'),
    inProgress: by('Running') + by('Queued'),
    nv: S.cases.filter((c) => !c.executable).length,
    rejected: S.cases.filter((c) => c.approval.status === 'rejected' && !inRun.includes(c.id)).length,
    notInRun: S.cases.filter((c) => c.executable && c.approval.status !== 'rejected' && !inRun.includes(c.id)).length,
    retries: run ? inRun.reduce((s, id) => s + ((run.results[id] && run.results[id].retryCount) || 0), 0) : 0,
    defectsConfirmed: run ? run.defects.filter((d) => d.confirmed).length : 0,
    defectsSuspected: run ? run.defects.filter((d) => !d.confirmed).length : 0,
    intermittent: run ? inRun.filter((id) => run.results[id] && run.results[id].intermittent).length : 0,
  };
}

function renderSummary() {
  const t = tallies();
  $('#stats').innerHTML = [
    ['Generated cases', t.generated, ''], ['Eligible in run', t.eligible, 'idle'], ['Passed', t.passed, 'passed'], ['Failed', t.failed, 'failed'],
    ['Blocked', t.blocked, 'blocked'], ['Not executed', t.notExecuted, 'idle'], ['In progress', t.inProgress, 'idle'], ['Needs Validation', t.nv, 'nv'],
    ['Rejected', t.rejected, 'rej'], ['Not in run (pending/other)', t.notInRun, 'idle'], ['Retries', t.retries, 'idle'],
    ['Confirmed defects', t.defectsConfirmed, 'bug'], ['Suspected issues', t.defectsSuspected, 'bug'],
  ].map(([l, n, c]) => `<div class="stat ${c}"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`).join('');

  const tabs = [
    ['passed', 'Passed Test Cases', t.passed], ['failed', 'Failed Test Cases', t.failed], ['blocked', 'Blocked Test Cases', t.blocked],
    ['nv', 'Needs Validation', t.nv], ['bugs', 'Bugs and Defects', t.defectsConfirmed + t.defectsSuspected], ['report', 'Execution Report', null],
  ];
  $('#tabs').innerHTML = tabs.map(([k, l, n]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${esc(l)}${n !== null ? `<span class="badge s-info count">${n}</span>` : ''}</button>`).join('');
  $('#tab-panel').innerHTML = renderTab(S.tab);
}

function caseItems(list, bodyFn) {
  if (!list.length) return '<p class="empty">None in this run.</p>';
  return list.map((c) => `<details class="item" data-item="${esc(c.id)}" ${S.openItems.has(c.id) ? 'open' : ''}><summary><span class="badge ${statusClass(caseStatus(c))}">${esc(caseStatus(c))}</span><b class="mono">${esc(c.id)}</b> ${esc(c.scenario)} <span class="muted small">· ${esc(c.endpoint)}</span>${c.result && c.result.intermittent ? '<span class="badge s-warn">intermittent</span>' : ''}${c.result && c.result.retryCount ? `<span class="badge s-info">${c.result.retryCount} retr${c.result.retryCount === 1 ? 'y' : 'ies'}</span>` : ''}</summary><div class="body">${bodyFn(c)}</div></details>`).join('');
}

function renderTab(tab) {
  const run = S.run;
  const inRun = (st) => S.cases.filter((c) => run && run.results[c.id] && run.results[c.id].status === st);
  if (tab === 'passed') {
    return caseItems(inRun('Passed'), (c) => {
      const last = c.result.attempts[c.result.attempts.length - 1];
      return `${c.result.intermittent ? `<div class="notice">${esc(c.result.intermittentNote)}</div>` : ''}
        <p class="small"><b>Expected:</b> ${esc(c.expected)}</p>
        <p class="small"><b>Checks that passed (${last.assertions.length}):</b></p>
        <ul class="assert-list">${last.assertions.map((x) => `<li><span class="badge s-passed">PASS</span> <b>${esc(x.name)}</b> — expected ${esc(x.expected)}; actual ${esc(x.actual)}${x.source ? `<br><span class="small muted">Evidence: ${esc(x.source)}</span>` : ''}</li>`).join('')}</ul>
        <h4>Full attempt history</h4>${attemptsHtml(c.result)}`;
    });
  }
  if (tab === 'failed') {
    return caseItems(inRun('Failed'), (c) => {
      const last = c.result.attempts[c.result.attempts.length - 1];
      const d = defectFor(c);
      return `<div class="detail-grid">${kv('Endpoint', c.endpoint)}${kv('Expected result', c.expected)}
        ${kv('Failed assertion(s)', last.assertions.filter((a) => !a.passed).map((a) => a.name).join('\n'))}
        ${kv('Actual result', last.assertions.filter((a) => !a.passed).map((a) => a.actual).join('\n'))}
        ${kv('Failure reason', c.result.finalReason)}${kv('Failure stage', c.result.failureStage)}
        ${kv('Retry history', c.result.attempts.map((a) => `${a.kind}: ${a.outcomeLabel} @ ${fmtTime(a.startedAt)}`).join('\n'))}
        ${d ? kv('Defect record', `${d.bugId} — ${d.verification}`) : ''}</div>
        <h4>Attempts</h4>${attemptsHtml(c.result)}`;
    });
  }
  if (tab === 'blocked') {
    return caseItems(inRun('Blocked'), (c) => `<div class="detail-grid">${kv('Blocked category', c.result.blockedCategory || c.result.failureCategory)}${kv('Why it could not execute', c.result.finalReason)}${kv('Stage', c.result.failureStage)}${kv('Endpoint', c.endpoint)}${kv('Expected result (unverified)', c.expected)}</div><h4>Attempts</h4>${attemptsHtml(c.result)}`);
  }
  if (tab === 'nv') {
    const body = (c) => `<div class="detail-grid">${kv('Why it needs validation', c.nvReason)}${kv('Evidence considered', c.evidence.filter((e) => !e.startsWith('Reviewer requirement')).join('\n'))}${kv('Current status', c.reviewerDecision ? `Requirement set — ${approvalLabel(c.approval)}` : 'Needs Validation')}</div>${validationPanelHtml(c)}`;
    const open = S.cases.filter((c) => c.decisionOptions && !c.reviewerDecision);
    const done = S.cases.filter((c) => c.decisionOptions && c.reviewerDecision);
    return `<p class="small">For each case: <b>1</b> run it and see the actual result → <b>2</b> choose the expected behaviour and check expected vs actual → <b>3</b> save it as a requirement, then approve it in Test Case Review and Start Automation.</p>
      <h4>Waiting for a decision (${open.length})</h4>${open.length ? caseItems(open, body) : '<p class="empty">None.</p>'}
      <h4>Requirement set by reviewer — now executable (${done.length})</h4>${done.length ? caseItems(done, body) : '<p class="empty">None yet.</p>'}`;
  }
  if (tab === 'bugs') return renderBugs();
  return renderReport();
}

function renderBugs() {
  const run = S.run;
  if (!run) return '<p class="empty">No run yet.</p>';
  const block = (d) => `<details class="item"><summary><span class="badge ${d.confirmed ? 's-failed' : 's-warn'}">${d.confirmed ? 'Confirmed defect' : 'Unverified / suspected'}</span><b class="mono">${esc(d.bugId)}</b> ${esc(d.summary)}</summary><div class="body">
      <div class="detail-grid">${kv('Bug ID', d.bugId)}${kv('Related test case', d.caseId)}${kv('API endpoint', d.endpoint)}${kv('Summary', d.summary)}
      ${kv('Expected result', d.expected)}${kv('Source of expectation', d.expectedSource)}${kv('Actual result', d.actual)}
      ${kv('Failed assertion(s)', d.failedAssertions.map((a) => `${a.name} — expected ${a.expected}; actual ${a.actual}`).join('\n') || '—')}
      ${kv('Failure stage', d.failureStage)}${kv('Severity', 'Unassigned — Needs Review (no classification policy supplied)')}${kv('Priority', 'Unassigned — Needs Review (no classification policy supplied)')}
      ${kv('Verification status', d.verification)}
      ${kv('Database comparison evidence', d.dbEvidence.length ? d.dbEvidence.map((a) => `${a.name}: expected ${a.expected}; actual ${a.actual}`).join('\n') : 'Not applicable to this failure')}
      ${kv('Retry history', d.retryHistory.map((h) => `${h.kind}: ${h.outcome} @ ${fmtTime(h.at)}${h.reason ? ` — ${h.reason}` : ''}`).join('\n'))}</div>
      <h4>Steps to reproduce</h4><pre class="evidence">${esc(d.stepsToReproduce.join('\n'))}</pre>
      ${requestsHtml(d.requests)}${dbQueriesHtml(d.dbQueries)}</div></details>`;
  const conf = run.defects.filter((d) => d.confirmed);
  const sus = run.defects.filter((d) => !d.confirmed);
  const env = environmentIssues(run);
  return `<h4>Confirmed defects (${conf.length})</h4>${conf.map(block).join('') || '<p class="empty">No confirmed defects.</p>'}
    <h4>Unverified suspicions (${sus.length})</h4>${sus.map(block).join('') || '<p class="empty">None.</p>'}
    <h4>Environment, configuration and dependency issues (${env.length}) — not counted as defects of the endpoints under test</h4>
    ${env.length ? `<ul>${env.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="empty">None recorded.</p>'}`;
}

function environmentIssues(run) {
  const out = [];
  const db = run.discovery && run.discovery.db;
  if (db && !db.connected) out.push(`Database not connected during run preparation: ${db.error}`);
  if (db && db.checkConstraintsError) out.push(`CHECK constraint metadata unavailable: ${db.checkConstraintsError}`);
  for (const id of run.eligibleIds) {
    const r = run.results[id];
    if (r && r.status === 'Blocked') out.push(`${id} blocked — ${r.blockedCategory}: ${r.finalReason}`);
  }
  return out;
}

function renderReport() {
  const run = S.run;
  if (!run) return '<p class="empty">No run yet. The report is generated from actual execution only.</p>';
  const t = tallies();
  const rows = [
    ['Run identifier', run.runId], ['Execution status', run.status], ['Report scope', run.partial ? 'PARTIAL run (not every eligible case completed, or the run did not complete)' : 'COMPLETED run (every eligible case reached a final status)'],
    ['Start time', fmtTime(run.startedAt)], ['End time', fmtTime(run.endedAt)], ['Target API', run.config.apiBaseUrl],
    ['Total generated cases', t.generated], ['Total eligible (approved, executable) cases', t.eligible],
    ['Passed', `${t.passed}${t.intermittent ? ` (of which ${t.intermittent} intermittent)` : ''}`], ['Failed', t.failed], ['Blocked', t.blocked], ['Not executed (stopped/interrupted)', t.notExecuted],
    ['Needs Validation (not executable)', t.nv], ['Rejected', t.rejected], ['Not in this run (pending or approved after start)', t.notInRun],
    ['Mutually exclusive check', `${t.passed} + ${t.failed} + ${t.blocked} + ${t.notExecuted} + ${t.inProgress} = ${t.passed + t.failed + t.blocked + t.notExecuted + t.inProgress} of ${t.eligible} eligible; eligible ${t.eligible} + NV ${t.nv} + rejected ${t.rejected} + not-in-run ${t.notInRun} = ${t.eligible + t.nv + t.rejected + t.notInRun} of ${t.generated} generated`],
    ['Total retries', t.retries], ['Defects', `${t.defectsConfirmed} confirmed, ${t.defectsSuspected} unverified/suspected`],
    ['Retry policy', `${run.config.maxRetries} retries after the initial attempt (${run.config.maxAttempts} attempts max)`],
    ['Rate limit evidence', run.rateLimit ? `${run.rateLimit.httpRequests ?? run.rateLimit.requestsIssued} HTTP request(s) + ${run.rateLimit.dbQueries ?? 0} DB queries; max ${run.rateLimit.maxObservedInAnyOneSecondWindow} operations and max ${run.rateLimit.maxDbQueriesInAnyOneSecondWindow ?? 0} DB queries in any 1-second window (configured limit ${run.rateLimit.configuredPerSecond}/s, shared)` : 'available when the run ends'],
    ['Database during run', run.discovery ? (run.discovery.db.connected ? `Connected: ${run.discovery.db.database} (${run.discovery.db.version}), read-only; tables ${(run.discovery.db.tables || []).map((t) => t.name + (t.rowCount !== null ? '=' + t.rowCount : '')).join(', ')}` : `NOT connected — ${run.discovery.db.error}`) : 'preparation not finished'],
    ['Severity / priority policy', 'None supplied — all defects Unassigned / Needs Review'],
  ];
  return `<table class="report-table">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
    <h4>Per-case results</h4>
    <table class="report-table"><tr><th>Case</th><td><b>Status · attempts · reason</b></td></tr>
      ${run.eligibleIds.map((id) => { const r = run.results[id]; return `<tr><th class="mono">${esc(id)}</th><td><span class="badge ${statusClass(r.status)}">${esc(r.status)}</span> · ${r.attempts.length} attempt(s)${r.intermittent ? ' · intermittent' : ''}${r.bugId ? ` · ${esc(r.bugId)}` : ''}${r.finalReason && r.status !== 'Passed' ? `<br><span class="small">${esc(r.finalReason)}</span>` : ''}</td></tr>`; }).join('')}
    </table>
    <p><button type="button" id="btn-download">Download report (JSON)</button> <span class="small muted">Includes request/response evidence (PII masked) and full logs for this run.</span></p>`;
}

function renderRunSelect() {
  const sel = $('#run-select');
  sel.innerHTML = '<option value="">Latest / active run</option>' + S.runs.map((r) => `<option value="${esc(r.runId)}">${esc(r.runId)} · ${esc(r.status)}</option>`).join('');
  sel.value = S.viewRunId || '';
}

function renderAll() {
  renderReview();
  renderAutomation();
  renderLogs();
  renderSummary();
}

// ------------------------------------------------------------------ dialogs + actions
let notifyTimer = null;
function notify(msg, kind = 'warn') {
  const box = $('#notice');
  box.className = kind === 'info' ? 'notice info' : 'notice';
  box.style.whiteSpace = 'pre-line';
  box.textContent = msg;
  box.hidden = false;
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => { box.hidden = true; }, 12000);
}
function openDialog({ title, text, reason, ok }) {
  $('#dlg-title').textContent = title;
  $('#dlg-text').textContent = text;
  $('#dlg-reason-wrap').style.display = reason ? '' : 'none';
  $('#dlg-reason').value = $('#review-comment').value;
  S.dialog = ok;
  $('#dlg').showModal();
}
$('#dlg-cancel').onclick = () => $('#dlg').close();
$('#dlg-ok').onclick = async () => { const fn = S.dialog; const reason = $('#dlg-reason').value; $('#dlg').close(); if (fn) await fn(reason); };

async function decide(ids, decision, comment) {
  try {
    const r = await api('/api/approvals', { method: 'POST', body: JSON.stringify({ ids, decision, comment: comment !== undefined ? comment : $('#review-comment').value }) });
    if (r.skipped.length) notify(`${r.skipped.length} case(s) skipped:\n` + r.skipped.slice(0, 10).map((s) => `${s.id}: ${s.reason}`).join('\n'));
    S.selected.clear();
    await refreshCases();
  } catch (e) { notify(`Approval update failed: ${e.message}`); }
}

async function refreshCases() {
  const cases = await api(`/api/cases${S.viewRunId ? `?runId=${S.viewRunId}` : ''}`);
  S.cases = cases.cases;
  renderReview(); renderAutomation(); renderSummary();
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button, input[type=checkbox], th.sortable');
  if (!t) return;
  if (t.dataset.sel !== undefined) { t.checked ? S.selected.add(t.dataset.sel) : S.selected.delete(t.dataset.sel); return renderReview(); }
  if (t.id === 'sel-page') { const list = filteredCases().slice(S.page * S.pageSize, (S.page + 1) * S.pageSize); list.forEach((c) => (t.checked ? S.selected.add(c.id) : S.selected.delete(c.id))); return renderReview(); }
  if (t.dataset.sort) { S.sort = { key: t.dataset.sort, dir: S.sort.key === t.dataset.sort ? -S.sort.dir : 1 }; return renderReview(); }
  if (t.dataset.expand) { S.expanded.has(t.dataset.expand) ? S.expanded.delete(t.dataset.expand) : S.expanded.add(t.dataset.expand); return renderReview(); }
  if (t.dataset.act === 'approve') return decide([t.dataset.id], 'approved');
  if (t.dataset.act === 'reject') return openDialog({ title: `Reject ${t.dataset.id}?`, text: 'Rejected cases are excluded from execution.', reason: true, ok: (r) => decide([t.dataset.id], 'rejected', r) });
  if (t.dataset.tab) { S.tab = t.dataset.tab; return renderSummary(); }
  if (t.dataset.check) {
    const f = S.forms[t.dataset.check] || {};
    t.disabled = true; t.textContent = 'Checking…';
    try { await api('/api/validations/check', { method: 'POST', body: JSON.stringify({ caseId: t.dataset.check, optionId: f.optionId, params: f.params }) }); S.openItems.add(t.dataset.check); await refreshCases(); } catch (e) {
      t.disabled = false; t.textContent = '✓ Check now: expected vs actual';
      t.insertAdjacentHTML('afterend', ` <span class="badge s-warn">Check failed to run: ${esc(e.message)}</span>`);
    }
    return;
  }
  if (t.dataset.saveDecision || t.dataset.clearDecision) {
    const id = t.dataset.saveDecision || t.dataset.clearDecision;
    const f = S.forms[id] || {};
    const body = t.dataset.saveDecision ? { caseId: id, optionId: f.optionId, params: f.params, comment: f.comment } : { caseId: id, optionId: null };
    t.disabled = true;
    try {
      await api('/api/validations', { method: 'POST', body: JSON.stringify(body) });
      if (t.dataset.clearDecision) delete S.forms[id];
      S.openItems.add(id);
      await refreshCases();
      notify(t.dataset.saveDecision ? `${id}: requirement saved. It is now executable and Pending Review — approve it in Test Case Review, then Start Automation.` : `${id}: requirement cleared; back to Needs Validation.`, 'info');
    } catch (e) {
      t.disabled = false;
      t.insertAdjacentHTML('afterend', ` <span class="badge s-warn">${esc(e.message)}</span>`);
    }
    return;
  }
  if (t.dataset.observe) {
    t.disabled = true; t.textContent = 'Observing…';
    try { await api(`/api/observe/${t.dataset.observe}`, { method: 'POST' }); S.openItems.add(t.dataset.observe); await refreshCases(); } catch (e) {
      t.disabled = false; t.textContent = 'Observe now (no assertion)';
      t.insertAdjacentHTML('afterend', ` <span class="badge s-warn">Observation failed: ${esc(e.message)}</span>`);
    }
    return;
  }
  switch (t.id) {
    case 'btn-approve-sel': return decide([...S.selected], 'approved');
    case 'btn-reject-sel': return openDialog({ title: `Reject ${S.selected.size} selected case(s)?`, text: 'Rejected cases are excluded from execution.', reason: true, ok: (r) => decide([...S.selected], 'rejected', r) });
    case 'btn-pending-sel': return decide([...S.selected], 'pending', '');
    case 'btn-approve-shown': {
      const ids = filteredCases().filter((c) => c.executable && c.approval.status !== 'approved').map((c) => c.id);
      if (!ids.length) return notify('No executable, not-yet-approved cases match the current filters.');
      return openDialog({ title: `Approve ${ids.length} reviewed case(s)?`, text: `This approves every executable case matching the current filters (${ids.join(', ')}). Needs Validation cases are not included. Confirm only if you have reviewed them.`, reason: false, ok: () => decide(ids, 'approved') });
    }
    case 'btn-reject-shown': {
      const ids = filteredCases().filter((c) => c.approval.status !== 'rejected').map((c) => c.id);
      if (!ids.length) return notify('No cases to reject in the current view.');
      return openDialog({ title: `Reject ${ids.length} reviewed case(s)?`, text: 'Every case matching the current filters will be rejected and excluded from execution.', reason: true, ok: (r) => decide(ids, 'rejected', r) });
    }
    case 'btn-start':
      t.disabled = true;
      try { const s = await api('/api/runs', { method: 'POST' }); S.viewRunId = null; S.activeRunId = s.runId; await loadRun(); } catch (e) { notify(`Could not start: ${e.message}`); renderAutomation(); }
      return;
    case 'btn-stop':
      t.disabled = true;
      try { await api('/api/runs/stop', { method: 'POST' }); } catch (e) { notify(e.message); }
      return;
    case 'btn-rediscover':
      try { await api('/api/discovery/refresh', { method: 'POST' }); } catch (e) { notify(e.message); }
      return;
    case 'btn-download': return downloadReport();
    case 'pg-prev': S.page--; return renderReview();
    case 'pg-next': S.page++; return renderReview();
    case 'f-clear':
      ['#f-search', '#f-endpoint', '#f-category', '#f-approval', '#f-status'].forEach((s) => { $(s).value = ''; });
      S.page = 0; return renderReview();
    default:
  }
});

async function downloadReport() {
  const full = S.viewRunId ? await api(`/api/runs/${S.viewRunId}`) : await api('/api/runs/current');
  const report = { generatedAt: new Date().toISOString(), tallies: tallies(), run: full.run };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${full.run.runId}-report.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

['#f-search', '#f-endpoint', '#f-category', '#f-approval', '#f-status'].forEach((s) => $(s).addEventListener('input', () => { S.page = 0; renderReview(); }));
$('#pg-size').addEventListener('change', (e) => { S.pageSize = Number(e.target.value); S.page = 0; renderReview(); });
['#log-filter', '#log-level', '#log-system'].forEach((s) => $(s).addEventListener('input', renderLogs));
document.addEventListener('input', (ev) => {
  const el = ev.target;
  const id = el.dataset && el.dataset.formCase;
  if (!id) return;
  const f = S.forms[id] || (S.forms[id] = { optionId: '', params: {}, comment: '' });
  if (el.dataset.formParam) f.params[el.dataset.formParam] = el.value;
  else if (el.dataset.formField === 'optionId') {
    f.optionId = el.value;
    document.querySelectorAll(`[data-check="${CSS.escape(id)}"], [data-save-decision="${CSS.escape(id)}"]`).forEach((b) => { b.disabled = !!(b.dataset.saveDecision && S.activeRunId); });
  } else if (el.dataset.formField) f[el.dataset.formField] = el.value;
});
document.addEventListener('toggle', (ev) => {
  const el = ev.target;
  if (el.dataset && el.dataset.item) (el.open ? S.openItems.add(el.dataset.item) : S.openItems.delete(el.dataset.item));
}, true);

$('#run-select').addEventListener('change', async (e) => { S.viewRunId = e.target.value || null; await loadRun(); });

// ------------------------------------------------------------------ live updates (SSE)
let pending = null;
function scheduleRender() {
  if (pending) return;
  pending = setTimeout(() => { pending = null; renderReview(); renderAutomation(); renderSummary(); }, 250);
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('log', (m) => appendLog(JSON.parse(m.data)));
  es.addEventListener('case', (m) => {
    const r = JSON.parse(m.data);
    if (!S.run || S.viewRunId && S.viewRunId !== S.run.runId) return;
    S.run.results[r.caseId] = r;
    const c = S.cases.find((x) => x.id === r.caseId);
    if (c) c.result = r;
    scheduleRender();
  });
  es.addEventListener('run', async (m) => {
    const s = JSON.parse(m.data);
    const wasActive = S.activeRunId;
    S.activeRunId = s.status === 'running' ? s.runId : null;
    if (S.viewRunId && S.viewRunId !== s.runId) return;
    if (!S.run || S.run.runId !== s.runId) { await loadRun(); } else { Object.assign(S.run, { ...s, logs: S.run.logs }); }
    if (wasActive && !S.activeRunId) { const runs = await api('/api/runs'); S.runs = runs.runs; renderRunSelect(); const cases = await api('/api/cases'); S.cases = cases.cases; }
    scheduleRender();
    renderInfo();
  });
  es.addEventListener('discovery', async () => { const info = await api('/api/info'); S.info = info; renderInfo(); });
  es.addEventListener('approvals', () => refreshCases());
  es.onerror = () => { $('#header-run-state').textContent = 'Connection lost — retrying…'; };
  es.onopen = () => { renderAutomation(); };
}

loadAll().then(connect).catch((e) => { document.querySelector('main').insertAdjacentHTML('afterbegin', `<div class="notice">Dashboard failed to load: ${esc(e.message)}</div>`); });
