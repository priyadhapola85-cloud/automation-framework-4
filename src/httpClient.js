'use strict';
/**
 * Read-only HTTP client. Only GET is permitted: the framework has no
 * authorisation to create, modify or delete data on the live system.
 * Every request passes through the shared RateLimiter before it is sent.
 */

const SECRET_HEADER = /^(authorization|x-api-token|cookie|set-cookie|proxy-authorization|x-api-key)$/i;
const KEPT_RESPONSE_HEADERS = ['content-type', 'content-length', 'location', 'allow', 'server'];
const BODY_EVIDENCE_LIMIT = 16000;

class TransportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SECRET_HEADER.test(k) ? '[REDACTED]' : v;
  return out;
}

/** Masks personal data (phone, email) wherever it appears in an evidence payload. */
function maskPII(value) {
  if (Array.isArray(value)) return value.map(maskPII);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && /^(phone|mobile)$/i.test(k)) out[k] = maskPhone(v);
      else if (typeof v === 'string' && /^email$/i.test(k)) out[k] = maskEmail(v);
      else if (typeof v === 'string' && k === 'details' && v.startsWith('{')) {
        try { out[k] = JSON.stringify(maskPII(JSON.parse(v))); } catch { out[k] = v; }
      } else out[k] = maskPII(v);
    }
    return out;
  }
  return value;
}
function maskPhone(p) {
  if (p.length <= 4) return '*'.repeat(p.length);
  return p.slice(0, 3) + '*'.repeat(Math.max(0, p.length - 5)) + p.slice(-2);
}
function maskEmail(e) {
  const at = e.indexOf('@');
  if (at < 1) return '***';
  return e[0] + '***' + e.slice(at);
}
/** Masks a single scalar when it belongs to a PII field. */
function maskField(field, v) {
  if (typeof v !== 'string') return v;
  if (/^(phone|mobile)$/i.test(field)) return maskPhone(v);
  if (/^email$/i.test(field)) return maskEmail(v);
  return v;
}

class HttpClient {
  constructor({ baseUrl, limiter, timeoutMs = 15000 }) {
    this.baseUrl = baseUrl;
    this.limiter = limiter;
    this.timeoutMs = timeoutMs;
  }

  buildUrl(pathname, query) {
    const url = new URL(this.baseUrl + pathname);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
        else if (v !== undefined) url.searchParams.append(k, String(v));
      }
    }
    return url;
  }

  /**
   * @returns {Promise<{method,url,path,status,ok,headers,bodyText,json,jsonError,durationMs,sentAt}>}
   * Throws TransportError for network-level failures (no HTTP response).
   */
  async request(method, pathname, { query, headers = {}, label = '', onSend } = {}) {
    if (method !== 'GET') throw new Error(`Refusing ${method}: framework is read-only (GET only).`);
    const url = this.buildUrl(pathname, query);
    await this.limiter.acquire(label || `${method} ${url.pathname}`);
    const sentAt = Date.now();
    if (onSend) onSend(url.pathname + url.search);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...headers },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const code = err.name === 'TimeoutError' ? 'TIMEOUT' : (err.cause && err.cause.code) || err.name || 'NETWORK';
      throw new TransportError(`${method} ${url.pathname}${url.search} failed: ${code}${err.cause && err.cause.message ? ' - ' + err.cause.message : ''}`, code);
    }
    const bodyText = await res.text();
    const durationMs = Date.now() - sentAt;
    const respHeaders = {};
    for (const h of KEPT_RESPONSE_HEADERS) if (res.headers.has(h)) respHeaders[h] = res.headers.get(h);
    let json;
    let jsonError = null;
    if (bodyText.length) {
      try { json = JSON.parse(bodyText); } catch (e) { jsonError = e.message; }
    }
    return {
      method,
      url: url.toString(),
      path: url.pathname + url.search,
      requestHeaders: redactHeaders(headers),
      status: res.status,
      ok: res.ok,
      headers: respHeaders,
      bodyText,
      json,
      jsonError,
      durationMs,
      sentAt,
    };
  }

  get(pathname, opts) {
    return this.request('GET', pathname, opts);
  }
}

/** Evidence record safe for display/storage: secrets redacted, PII masked, body truncated. */
function toEvidence(r) {
  let body;
  if (r.json !== undefined) {
    const masked = JSON.stringify(maskPII(r.json));
    body = masked.length > BODY_EVIDENCE_LIMIT ? masked.slice(0, BODY_EVIDENCE_LIMIT) + ' …[truncated]' : masked;
  } else {
    body = r.bodyText.length > BODY_EVIDENCE_LIMIT ? r.bodyText.slice(0, BODY_EVIDENCE_LIMIT) + ' …[truncated]' : r.bodyText;
  }
  return {
    method: r.method,
    url: r.url,
    requestHeaders: r.requestHeaders,
    status: r.status,
    headers: r.headers,
    durationMs: r.durationMs,
    sentAt: new Date(r.sentAt).toISOString(),
    body,
  };
}

module.exports = { HttpClient, TransportError, redactHeaders, maskPII, maskField, toEvidence };
