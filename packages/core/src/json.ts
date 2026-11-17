import { MekdeckError } from './errors.ts';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const MAX_DEPTH = 256;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural equality for JSON-like data. Typed arrays and other exotic objects
 * only compare equal by reference (they can be huge). `budget` caps the number
 * of containers visited; when exceeded the answer is a conservative `false`.
 */
export function deepEqual(a: unknown, b: unknown, budget = 100_000): boolean {
  return equalInner(a, b, { left: budget });
}

function equalInner(a: unknown, b: unknown, state: { left: number }): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (--state.left < 0) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equalInner(a[i], b[i], state)) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  if (!isPlainObject(a) || !isPlainObject(b)) return false;

  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    if (!Object.hasOwn(b, key) || !equalInner(a[key], b[key], state)) return false;
  }
  return true;
}

/**
 * Throws unless `value` is valid, finite, acyclic JSON with no `__proto__` keys.
 * `path` is used to make the error message point at the offending location.
 */
export function assertJson(value: unknown, path = '$', depth = 0): asserts value is JsonValue {
  if (depth > MAX_DEPTH) {
    throw new MekdeckError('E_JSON_DEPTH', `${path}: value is nested too deeply (or circular)`);
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new MekdeckError('E_JSON_NONFINITE', `${path}: numbers must be finite (got ${value})`);
      }
      return;
    case 'object': {
      if (value === null) return;
      if (Array.isArray(value)) {
        value.forEach((item, i) => assertJson(item, `${path}[${i}]`, depth + 1));
        return;
      }
      if (!isPlainObject(value)) {
        throw new MekdeckError('E_JSON_TYPE', `${path}: only plain objects and arrays are allowed`);
      }
      for (const key of Object.keys(value)) {
        if (key === '__proto__') {
          throw new MekdeckError('E_JSON_KEY', `${path}: the key "__proto__" is not allowed`);
        }
        assertJson(value[key], `${path}.${key}`, depth + 1);
      }
      return;
    }
    default:
      throw new MekdeckError('E_JSON_TYPE', `${path}: ${typeof value} is not valid JSON data`);
  }
}

/**
 * Deterministic JSON: object keys are sorted, so equal data always produces
 * byte-identical text (stable hashes, clean git diffs).
 * `undefined` object properties are dropped; non-finite numbers throw.
 */
export function stableStringify(value: unknown, indent: number | string = 2): string {
  return JSON.stringify(canonicalize(value, 0), null, indent);
}

function canonicalize(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    throw new MekdeckError('E_JSON_DEPTH', 'value is nested too deeply (or circular)');
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new MekdeckError('E_JSON_NONFINITE', `numbers must be finite (got ${value})`);
      }
      return value;
    case 'object': {
      if (value === null) return null;
      if (Array.isArray(value)) {
        return value.map((item) => {
          if (item === undefined) {
            throw new MekdeckError('E_JSON_TYPE', 'undefined is not allowed inside arrays');
          }
          return canonicalize(item, depth + 1);
        });
      }
      if (!isPlainObject(value)) {
        throw new MekdeckError('E_JSON_TYPE', 'only plain objects and arrays can be serialized');
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        const item = value[key];
        if (item !== undefined) out[key] = canonicalize(item, depth + 1);
      }
      return out;
    }
    default:
      throw new MekdeckError('E_JSON_TYPE', `${typeof value} cannot be serialized as JSON`);
  }
}
