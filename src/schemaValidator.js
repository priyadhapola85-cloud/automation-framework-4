'use strict';
/**
 * Minimal validator for the JSON Schema subset used by the live OpenAPI 3.1
 * contract of this API: $ref, anyOf, type, enum, required, properties, items,
 * minimum/maximum and format "date-time".
 *
 * `additionalProperties` is not enforced because the contract does not declare
 * it, so extra fields are not treated as violations.
 *
 * date-time is checked leniently (ISO-8601 date + time that Date can parse).
 * Whether a missing timezone offset is acceptable is NOT decided here; that
 * question is tracked as a Needs Validation test case.
 */

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref ${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => (node == null ? node : node[key]), root);
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected, v) {
  const actual = typeOf(v);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

function validate(schema, value, root, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.$ref) {
    const target = resolveRef(schema.$ref, root);
    if (!target) errors.push(`${path}: unresolved $ref ${schema.$ref}`);
    else validate(target, value, root, path, errors);
    return errors;
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validate(s, value, root, path, []).length === 0);
    if (!ok) errors.push(`${path}: value ${short(value)} matches none of anyOf [${schema.anyOf.map(describe).join(', ')}]`);
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${typeOf(value)} (${short(value)})`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${short(value)} not in enum [${schema.enum.join(', ')}]`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  if (schema.format === 'date-time' && typeof value === 'string') {
    if (!ISO_DATETIME.test(value) || Number.isNaN(Date.parse(value))) errors.push(`${path}: "${value}" is not an ISO-8601 date-time`);
  }
  if (typeOf(value) === 'object') {
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}: missing required property "${req}"`);
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value) validate(sub, value[k], root, `${path}.${k}`, errors);
    }
  }
  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((item, i) => validate(schema.items, item, root, `${path}[${i}]`, errors));
  }
  return errors;
}

function describe(s) {
  if (s.$ref) return s.$ref.split('/').pop();
  return s.type || 'schema';
}
function short(v) {
  const s = JSON.stringify(v);
  return s && s.length > 60 ? s.slice(0, 57) + '...' : s;
}

module.exports = { validate, resolveRef, typeOf };
