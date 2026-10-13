'use strict';
/**
 * Runtime configuration. Values come from environment variables, optionally
 * loaded from api-qa-framework/.env (never committed). No secrets are needed
 * for the two read-only endpoints under test.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv(path.join(ROOT, '.env'));
// Database/SSH credentials may live in another, already-configured .env file
// (e.g. C:\Users\usre\automation test\.env). Only DB_* and SSH_* keys are read from it.
function loadDbEnvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*((?:DB|SSH)_[A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || raw.trim().startsWith('#')) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadDbEnvFile(process.env.DB_ENV_FILE);

function intEnv(name, def) {
  const v = Number.parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const config = {
  root: ROOT,
  dataDir: path.join(ROOT, 'data'),
  publicDir: path.join(ROOT, 'public'),
  apiBaseUrl: (process.env.API_BASE_URL || 'http://15.252.197.75:8000').replace(/\/+$/, ''),
  host: process.env.DASHBOARD_HOST || '127.0.0.1',
  port: intEnv('DASHBOARD_PORT', 4310),
  requestTimeoutMs: clamp(intEnv('REQUEST_TIMEOUT_MS', 15000), 1000, 60000),
  // Hard ceiling of 2 operations per second (task requirement). Lower values are allowed.
  rateLimitPerSecond: clamp(intEnv('RATE_LIMIT_PER_SEC', 2), 1, 2),
  // Retries after the initial attempt: max 3 (4 attempts total).
  maxRetries: clamp(intEnv('MAX_RETRIES', 3), 0, 3),
  retryBackoffMs: clamp(intEnv('RETRY_BACKOFF_MS', 1000), 0, 10000),
  // Small worker pool; the shared rate limiter still caps outbound traffic.
  concurrency: clamp(intEnv('EXECUTION_CONCURRENCY', 2), 1, 4),
  // MariaDB/MySQL (read-only). Secrets come only from the environment / .env files and are never exposed.
  db: {
    envFile: process.env.DB_ENV_FILE || '',
    host: process.env.DB_HOST || '',
    port: intEnv('DB_PORT', 3306),
    name: process.env.DB_NAME || '',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    queryTimeoutMs: clamp(intEnv('DB_QUERY_TIMEOUT_MS', 20000), 1000, 60000),
    snapshotRowLimit: clamp(intEnv('DB_SNAPSHOT_ROW_LIMIT', 5000), 1, 50000),
    ssh: {
      enabled: /^(1|true|yes)$/i.test(process.env.DB_SSH_ENABLED || ''),
      host: process.env.SSH_HOST || process.env.DB_HOST || '',
      port: intEnv('SSH_PORT', 22),
      user: process.env.SSH_USER || '',
      password: process.env.SSH_PASSWORD || '',
      privateKeyPath: process.env.SSH_PRIVATE_KEY_PATH || '',
      dbHostFromSsh: process.env.DB_HOST_VIA_SSH || '127.0.0.1',
    },
  },
};

/** Non-secret description of the DB configuration for the UI and reports. */
config.dbPublic = () => ({
  configured: !!(config.db.user && config.db.password && config.db.name),
  engine: 'MariaDB/MySQL',
  name: config.db.name,
  host: config.db.host,
  port: config.db.port,
  via: config.db.ssh.enabled ? `SSH tunnel (${config.db.ssh.user ? 'user set' : 'user missing'} @ ${config.db.ssh.host}:${config.db.ssh.port} → ${config.db.ssh.dbHostFromSsh}:${config.db.port})` : 'direct TCP',
  credentialsSource: config.db.envFile ? `DB_ENV_FILE (${config.db.envFile})` : 'api-qa-framework/.env',
});

module.exports = config;
