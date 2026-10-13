'use strict';
/**
 * Read-only MariaDB/MySQL access, optionally through an SSH tunnel
 * (port 3306 on the API host is not reachable from outside).
 *
 *  - READ-ONLY: only single SELECT / SHOW / DESCRIBE / EXPLAIN statements are accepted.
 *  - RATE LIMIT: every query acquires the framework's single shared RateLimiter
 *    (max 2 operations in any 1-second window), so concurrent cases, retries,
 *    discovery and observations cannot bypass it.
 *  - SECRETS: credentials come from config only; they are never logged or returned.
 */
const fs = require('fs');

const READ_ONLY = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;
const CONNECTION_ERRORS = /PROTOCOL_CONNECTION_LOST|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|Connection lost|closed state|Not connected|Channel open failure|inactivity timeout/i;

class DbError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'DbError';
    this.kind = kind; // 'config' | 'connection' | 'query' | 'refused'
  }
}

class Database {
  constructor(cfg, limiter, log = () => {}) {
    this.cfg = cfg;
    this.limiter = limiter;
    this.log = log;
    this.conn = null;
    this.ssh = null;
    this.lastUsedAt = 0;
    this.idleResetMs = 60000;
    this.stats = { queries: 0, errors: 0, reconnects: 0, connectedAt: null, lastError: null };
    this.queryLog = [];
  }

  /** null when configured, otherwise the reason (no secret values). */
  notConfigured() {
    const c = this.cfg;
    if (!c.name || !c.user || !c.password) return 'DB_NAME / DB_USER / DB_PASSWORD are not set (set DB_ENV_FILE or fill api-qa-framework/.env)';
    if (c.ssh.enabled && !(c.ssh.host && c.ssh.user && (c.ssh.password || c.ssh.privateKeyPath))) return 'DB_SSH_ENABLED=true but SSH_HOST / SSH_USER / SSH_PASSWORD (or SSH_PRIVATE_KEY_PATH) are not set';
    if (!c.ssh.enabled && !c.host) return 'DB_HOST is not set';
    return null;
  }

  async _tunnelStream() {
    const { Client } = require('ssh2');
    const s = this.cfg.ssh;
    const client = new Client();
    await new Promise((resolve, reject) => {
      client.once('ready', resolve).once('error', reject);
      client.connect({
        host: s.host, port: s.port, username: s.user, readyTimeout: 15000, keepaliveInterval: 10000, keepaliveCountMax: 3,
        ...(s.privateKeyPath ? { privateKey: fs.readFileSync(s.privateKeyPath) } : { password: s.password }),
      });
    });
    this.ssh = client;
    client.on('close', () => { this.conn = null; this.ssh = null; });
    client.on('error', () => { this.conn = null; });
    return new Promise((resolve, reject) => client.forwardOut('127.0.0.1', 0, s.dbHostFromSsh, this.cfg.port, (err, stream) => (err ? reject(err) : resolve(stream))));
  }

  async _connect() {
    if (this.conn) return this.conn;
    const why = this.notConfigured();
    if (why) throw new DbError(why, 'config');
    const mysql = require('mysql2/promise');
    const base = {
      user: this.cfg.user, password: this.cfg.password, database: this.cfg.name,
      dateStrings: true, supportBigNumbers: true, bigNumberStrings: false, decimalNumbers: true,
      multipleStatements: false, connectTimeout: 15000,
    };
    try {
      this.conn = this.cfg.ssh.enabled
        ? await mysql.createConnection({ ...base, stream: await this._tunnelStream() })
        : await mysql.createConnection({ ...base, host: this.cfg.host, port: this.cfg.port });
    } catch (e) {
      await this.close();
      throw new DbError(`Database connection failed (${this.cfg.ssh.enabled ? 'via SSH tunnel' : 'direct'}): ${e.code || ''} ${e.level ? '[' + e.level + '] ' : ''}${e.message}`.trim(), 'connection');
    }
    this.conn.on('error', () => { this.conn = null; });
    this.stats.connectedAt = new Date().toISOString();
    this.log('info', `Database connected: ${this.cfg.name} (${this.cfg.ssh.enabled ? 'SSH tunnel' : 'direct'}), read-only.`);
    return this.conn;
  }

  /**
   * Rate-limited, read-only query. Reconnects once (through the limiter again) if the
   * connection was dropped. Returns { rows, sql, ms, at }.
   */
  async query(sql, params = [], purpose = '') {
    if (!READ_ONLY.test(sql) || /;\s*\S/.test(sql)) throw new DbError('Refused: only single read-only statements are allowed', 'refused');
    try {
      return await this._run(sql, params, purpose);
    } catch (e) {
      if (e.kind === 'connection' || CONNECTION_ERRORS.test(`${e.code || ''} ${e.message}`)) {
        this.stats.reconnects++;
        await this.close();
        return this._run(sql, params, `${purpose} (after reconnect)`);
      }
      throw e;
    }
  }

  async _run(sql, params, purpose) {
    await this.limiter.acquire(`DB ${purpose}`);
    const t0 = Date.now();
    const entry = { at: new Date(t0).toISOString(), purpose, sql: sql.replace(/\s+/g, ' ').trim(), params: params.map((p) => (typeof p === 'string' && p.length > 60 ? p.slice(0, 57) + '…' : p)), rows: null, ms: null, error: null };
    try {
      if (this.conn && Date.now() - this.lastUsedAt > this.idleResetMs) await this.close();
      const conn = await this._connect();
      const [rows] = await conn.query({ sql, timeout: this.cfg.queryTimeoutMs }, params);
      this.lastUsedAt = Date.now();
      entry.rows = Array.isArray(rows) ? rows.length : null;
      return { rows, sql: entry.sql, params: entry.params, ms: Date.now() - t0, at: entry.at };
    } catch (e) {
      this.stats.errors++;
      entry.error = e.message;
      this.stats.lastError = e.message;
      if (e instanceof DbError) throw e;
      const kind = CONNECTION_ERRORS.test(`${e.code || ''} ${e.message}`) ? 'connection' : 'query';
      if (kind === 'connection') await this.close();
      throw new DbError(`${e.code || ''} ${e.message}`.trim(), kind);
    } finally {
      entry.ms = Date.now() - t0;
      this.stats.queries++;
      this.queryLog.push(entry);
      if (this.queryLog.length > 2000) this.queryLog.shift();
    }
  }

  async close() {
    try { if (this.conn) await this.conn.end(); } catch { /* ignore */ }
    try { if (this.ssh) this.ssh.end(); } catch { /* ignore */ }
    this.conn = null;
    this.ssh = null;
  }
}

module.exports = { Database, DbError, READ_ONLY };
