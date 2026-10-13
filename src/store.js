'use strict';
/** File-based persistence for approvals and run records (api-qa-framework/data, git-ignored). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.runsDir = path.join(dataDir, 'runs');
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.approvalsFile = path.join(dataDir, 'approvals.json');
    this.approvals = this._read(this.approvalsFile, {});
    this.validationsFile = path.join(dataDir, 'validations.json');
    this.validations = this._read(this.validationsFile, {});
  }

  /** Reviewer decision (expected behaviour) for a Needs Validation case; null clears it. */
  setValidation(caseId, decision) {
    if (decision) this.validations[caseId] = decision;
    else delete this.validations[caseId];
    this._write(this.validationsFile, this.validations);
  }

  _read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  _write(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  static defHash(def) {
    const { scenario, description, steps, expected, assertionLogic, validation } = def;
    return crypto.createHash('sha1').update(JSON.stringify({ scenario, description, steps, expected, assertionLogic, validation })).digest('hex').slice(0, 12);
  }

  /** Approval for a case; resets to pending if the case definition changed since review. */
  approvalFor(def) {
    const a = this.approvals[def.id];
    if (!a) return { status: 'pending', comment: '', at: null, stale: false };
    if (a.defHash !== Store.defHash(def)) return { status: 'pending', comment: a.comment || '', at: a.at, stale: true };
    return { ...a, stale: false };
  }

  setApproval(def, status, comment) {
    this.approvals[def.id] = { status, comment: comment || '', at: new Date().toISOString(), defHash: Store.defHash(def) };
    this._write(this.approvalsFile, this.approvals);
    return this.approvalFor(def);
  }

  saveRun(run) {
    this._write(path.join(this.runsDir, `${run.runId}.json`), run);
  }

  loadRun(runId) {
    if (!/^RUN-[\w-]+$/.test(runId)) return null;
    return this._read(path.join(this.runsDir, `${runId}.json`), null);
  }

  listRuns() {
    return fs.readdirSync(this.runsDir)
      .filter((f) => /^RUN-.*\.json$/.test(f))
      .map((f) => this._read(path.join(this.runsDir, f), null))
      .filter(Boolean)
      .map((r) => ({ runId: r.runId, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, eligible: r.eligibleIds.length, partial: r.partial }))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  /** Runs left in "running" state by a previous process are marked interrupted (results kept). */
  markInterrupted() {
    for (const s of this.listRuns()) {
      if (s.status !== 'running') continue;
      const run = this.loadRun(s.runId);
      run.status = 'interrupted';
      run.partial = true;
      run.endedAt = run.endedAt || null;
      for (const id of run.eligibleIds) {
        const r = run.results[id];
        if (r.status === 'Queued' || r.status === 'Running') {
          r.status = 'Not Executed';
          r.finalReason = 'Run was interrupted (dashboard process stopped) before this case completed.';
        }
      }
      run.logs.push({ seq: (run.logs.length ? run.logs[run.logs.length - 1].seq : 0) + 1, ts: new Date().toISOString(), runId: run.runId, caseId: null, stage: 'run', status: 'warn', message: 'Run marked interrupted: the dashboard process stopped while this run was active.' });
      this.saveRun(run);
    }
  }
}

module.exports = { Store };
