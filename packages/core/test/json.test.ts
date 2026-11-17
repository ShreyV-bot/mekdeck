import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertJson, deepEqual, MekdeckError, stableStringify } from '../src/index.ts';

test('stableStringify is independent of key insertion order', () => {
  const a = stableStringify({ b: 1, a: { d: [1, 2], c: null } });
  const b = stableStringify({ a: { c: null, d: [1, 2] }, b: 1 });
  assert.equal(a, b);
  assert.deepEqual(Object.keys(JSON.parse(a)), ['a', 'b']);
});

test('stableStringify drops undefined properties but rejects unsafe values', () => {
  assert.equal(stableStringify({ a: 1, b: undefined }, 0), '{"a":1}');
  assert.throws(() => stableStringify({ a: Number.NaN }), (e: unknown) => e instanceof MekdeckError && e.code === 'E_JSON_NONFINITE');
  assert.throws(() => stableStringify([undefined]), (e: unknown) => e instanceof MekdeckError && e.code === 'E_JSON_TYPE');
  assert.throws(() => stableStringify({ d: new Date() }), (e: unknown) => e instanceof MekdeckError && e.code === 'E_JSON_TYPE');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => stableStringify(circular), (e: unknown) => e instanceof MekdeckError && e.code === 'E_JSON_DEPTH');
});

test('assertJson accepts clean JSON and points at the bad location', () => {
  assertJson({ a: [1, 'x', true, null, { b: 2 }] });
  assert.throws(() => assertJson({ a: [1, Number.POSITIVE_INFINITY] }), /\$\.a\[1\]/);
  assert.throws(() => assertJson(JSON.parse('{"__proto__": 1}')), /__proto__/);
  assert.throws(() => assertJson({ f: () => 1 }), /function/);
});

test('deepEqual compares structure, not identity', () => {
  assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.ok(!deepEqual({ a: [1, 2] }, { a: [1, 3] }));
  assert.ok(!deepEqual([1], { 0: 1 }));
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(deepEqual(Number.NaN, Number.NaN));
  const big = new Float32Array(4);
  assert.ok(deepEqual(big, big));
  assert.ok(!deepEqual(new Float32Array(4), new Float32Array(4)), 'typed arrays compare by reference');
});

test('deepEqual gives a conservative false when the budget runs out', () => {
  const deep = (n: number): unknown => (n === 0 ? 1 : [deep(n - 1)]);
  assert.ok(deepEqual(deep(10), deep(10)));
  assert.ok(!deepEqual(deep(50), deep(50), 10));
});
