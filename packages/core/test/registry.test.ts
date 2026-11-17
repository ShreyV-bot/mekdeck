import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MekdeckError, NodeRegistry, TypeRegistry, type NodeTypeDef } from '../src/index.ts';

const ok = (type: string, extra: Partial<NodeTypeDef> = {}): NodeTypeDef => ({
  type,
  label: 'X',
  category: 'Test',
  inputs: {},
  outputs: {},
  evaluate: () => ({}),
  ...extra,
});

const invalid = (e: unknown) => e instanceof MekdeckError && e.code === 'E_NODE_TYPE_INVALID';

test('type registry connects equal types, any, and registered conversions only', () => {
  const t = new TypeRegistry();
  assert.ok(t.canConnect('number', 'number'));
  assert.ok(t.canConnect('number', 'any'));
  assert.ok(t.canConnect('any', 'vec3'));
  assert.ok(t.canConnect('number', 'vec3'));
  assert.ok(t.canConnect('vec3', 'color'));
  assert.ok(!t.canConnect('string', 'number'));
  assert.ok(!t.canConnect('vec3', 'number'));
  assert.ok(!t.canConnect('number', 'nonexistent'));
  assert.deepEqual(t.convert('number', 'vec3', 2), [2, 2, 2]);
  assert.equal(t.convert('boolean', 'number', true), 1);
  assert.throws(() => t.convert('string', 'number', 'x'), /No conversion/);
});

test('type checks validate tuple shapes and finiteness', () => {
  const t = new TypeRegistry();
  assert.ok(t.check('vec3', [1, 2, 3]));
  assert.ok(!t.check('vec3', [1, 2]));
  assert.ok(!t.check('vec3', [1, 2, Number.NaN]));
  assert.ok(!t.check('number', '1'));
  assert.ok(t.check('any', { whatever: true }));
});

test('registering a duplicate data type fails', () => {
  assert.throws(() => new TypeRegistry().register({ id: 'number', label: 'dup' }), /already registered/);
});

test('node registry accepts a valid definition and lists it by category', () => {
  const r = new NodeRegistry().register(ok('a.b', { category: 'Zed' }), ok('a.c', { category: 'Alpha' }));
  assert.ok(r.has('a.b'));
  assert.deepEqual([...r.byCategory().keys()], ['Alpha', 'Zed']);
});

test('node registry rejects bad names, duplicates and unknown port types', () => {
  const r = new NodeRegistry().register(ok('a.b'));
  assert.throws(() => r.register(ok('nodots')), invalid);
  assert.throws(() => r.register(ok('A.b')), invalid);
  assert.throws(() => r.register(ok('a.b')), invalid);
  assert.throws(() => r.register(ok('a.d', { inputs: { x: { type: 'nope' } } })), invalid);
  assert.throws(() => r.register(ok('a.e', { inputs: { 'bad name': { type: 'number' } } })), invalid);
  // JSON.parse creates a real own "__proto__" key (an object literal would just set the prototype).
  const hostile = JSON.parse('{"__proto__": {"type": "number"}}');
  assert.throws(() => r.register(ok('a.f', { inputs: hostile })), invalid);
  assert.throws(() => r.register(ok('a.g', { inputs: { constructor: { type: 'number' } } })), invalid);
});

test('node registry rejects invalid defaults and misuse of output port flags', () => {
  const r = new NodeRegistry();
  assert.throws(() => r.register(ok('a.h', { inputs: { v: { type: 'vec3', default: [1, 2] } } })), invalid);
  assert.throws(() => r.register(ok('a.i', { outputs: { o: { type: 'number', multi: true } } })), invalid);
  assert.throws(() => r.register(ok('a.j', { params: { m: { type: 'enum', default: 'z', options: ['a'] } } })), invalid);
});
