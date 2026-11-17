import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Evaluator, GraphDocument, MekdeckError, type GraphEditor, type NodeId } from '../src/index.ts';
import { calls, newEditor, resetCalls, testRegistry } from './helpers.ts';

beforeEach(resetCalls);

const wire = (ed: GraphEditor, from: NodeId, fromPort: string, to: NodeId, toPort: string) =>
  ed.connect({ node: from, port: fromPort }, { node: to, port: toPort });

test('evaluates a chain: (2 + 3) * 4 = 20', () => {
  const ed = newEditor();
  const two = ed.addNode('test.num', { values: { value: 2 } });
  const three = ed.addNode('test.num', { values: { value: 3 } });
  const add = ed.addNode('test.add');
  const mul = ed.addNode('test.mul', { values: { b: 4 } });
  wire(ed, two.id, 'value', add.id, 'a');
  wire(ed, three.id, 'value', add.id, 'b');
  wire(ed, add.id, 'sum', mul.id, 'a');

  const ev = new Evaluator(ed.doc);
  assert.equal(ev.value(mul.id, 'product'), 20);
});

test('unconnected inputs fall back to inline value, then port default', () => {
  const ed = newEditor();
  const mul = ed.addNode('test.mul', { values: { a: 6 } }); // b defaults to 1
  assert.equal(new Evaluator(ed.doc).value(mul.id, 'product'), 6);
});

test('params are resolved with defaults and overrides', () => {
  const ed = newEditor();
  const s = ed.addNode('test.scale', { values: { value: 10 } });
  const ev = new Evaluator(ed.doc);
  assert.equal(ev.value(s.id, 'out'), 20);
  ed.setParam(s.id, 'factor', 3);
  assert.equal(ev.value(s.id, 'out'), 30);
});

test('results are cached: asking again does no work', () => {
  const ed = newEditor();
  const a = ed.addNode('test.num', { values: { value: 1 } });
  const add = ed.addNode('test.add');
  wire(ed, a.id, 'value', add.id, 'a');
  const ev = new Evaluator(ed.doc);

  ev.evaluate(add.id);
  assert.equal(ev.stats.evaluations, 2);
  ev.evaluate(add.id);
  ev.evaluate(add.id);
  assert.equal(ev.stats.evaluations, 2);
});

test('after an edit only the affected branch re-runs', () => {
  const ed = newEditor();
  const a = ed.addNode('test.num', { values: { value: 1 } });
  const b = ed.addNode('test.num', { values: { value: 2 } });
  const add = ed.addNode('test.add');
  const tail = ed.addNode('test.mul');
  wire(ed, a.id, 'value', add.id, 'a');
  wire(ed, b.id, 'value', add.id, 'b');
  wire(ed, add.id, 'sum', tail.id, 'a');
  const ev = new Evaluator(ed.doc);
  assert.equal(ev.value(tail.id, 'product'), 3);
  resetCalls();

  ed.setValue(b.id, 'value', 10);
  assert.equal(ev.value(tail.id, 'product'), 11);
  assert.equal(calls['test.num'], 1, 'only the edited number re-ran');
  assert.equal(calls['test.add'], 1);
  assert.equal(calls['test.mul'], 1);
});

test('early cutoff: a node that recomputes to the same output does not re-run its dependents', () => {
  const ed = newEditor();
  const n = ed.addNode('test.num', { values: { value: 5 } });
  const sign = ed.addNode('test.sign');
  const tail = ed.addNode('test.mul');
  wire(ed, n.id, 'value', sign.id, 'value');
  wire(ed, sign.id, 'sign', tail.id, 'a');
  const ev = new Evaluator(ed.doc);
  assert.equal(ev.value(tail.id, 'product'), 1);
  resetCalls();

  ed.setValue(n.id, 'value', 99); // sign is still 1
  assert.equal(ev.value(tail.id, 'product'), 1);
  assert.equal(calls['test.num'], 1);
  assert.equal(calls['test.sign'], 1);
  assert.equal(calls['test.mul'], undefined, 'downstream was cut off');

  ed.setValue(n.id, 'value', -3); // sign flips
  assert.equal(ev.value(tail.id, 'product'), -1);
  assert.equal(calls['test.mul'], 1);
});

test('moving or renaming nodes costs nothing', () => {
  const ed = newEditor();
  const a = ed.addNode('test.num', { values: { value: 1 } });
  const ev = new Evaluator(ed.doc);
  ev.evaluate(a.id);
  const before = { ...ev.stats };
  ed.moveNode(a.id, { x: 100, y: 100 });
  ed.rename(a.id, 'x');
  ev.evaluate(a.id);
  assert.deepEqual(ev.stats, before);
});

test('only the nodes you ask about (and their ancestors) are evaluated', () => {
  const ed = newEditor();
  const used = ed.addNode('test.num');
  ed.addNode('test.num'); // unrelated
  ed.addNode('test.boom'); // unrelated and broken
  new Evaluator(ed.doc).evaluate(used.id);
  assert.equal(calls['test.num'], 1);
  assert.equal(calls['test.boom'], undefined);
});

test('volatile nodes follow time; everything else is reused', () => {
  const ed = newEditor();
  const t = ed.addNode('test.time');
  const k = ed.addNode('test.num', { values: { value: 10 } });
  const mul = ed.addNode('test.mul');
  wire(ed, t.id, 't', mul.id, 'a');
  wire(ed, k.id, 'value', mul.id, 'b');
  const ev = new Evaluator(ed.doc);

  assert.equal(ev.value(mul.id, 'product'), 0);
  ev.setTime(2);
  assert.equal(ev.value(mul.id, 'product'), 20);
  assert.equal(calls['test.num'], 1, 'non-volatile node ran once in total');

  const before = ev.stats.evaluations;
  ev.setTime(2); // unchanged
  ev.evaluate(mul.id);
  assert.equal(ev.stats.evaluations, before);
});

test('a failing node becomes an error; dependents are blocked; unrelated branches still work', () => {
  const ed = newEditor();
  const boom = ed.addNode('test.boom');
  const add = ed.addNode('test.add');
  const fine = ed.addNode('test.num', { values: { value: 7 } });
  wire(ed, boom.id, 'out', add.id, 'a');
  const ev = new Evaluator(ed.doc);

  const failed = ev.evaluate(boom.id);
  assert.equal(failed.status, 'error');
  assert.equal(failed.status === 'error' && failed.error.code, 'E_EVAL_FAILED');
  assert.match(failed.status === 'error' ? failed.error.message : '', /kaboom/);

  const blocked = ev.evaluate(add.id);
  assert.equal(blocked.status === 'error' && blocked.error.code, 'E_UPSTREAM');

  assert.equal(ev.value(fine.id, 'value'), 7);
  assert.throws(() => ev.value(add.id, 'sum'), (e: unknown) => e instanceof MekdeckError && e.code === 'E_UPSTREAM');

  const all = ev.evaluateAll();
  assert.equal([...all.values()].filter((r) => r.status === 'error').length, 2);
});

test('a missing required input is an error on that node only', () => {
  const ed = newEditor();
  const r = ed.addNode('test.required');
  const result = new Evaluator(ed.doc).evaluate(r.id);
  assert.equal(result.status === 'error' && result.error.code, 'E_INPUT_MISSING');
});

test('an invalid inline value is reported instead of crashing the node', () => {
  const doc = GraphDocument.fromData(testRegistry(), {
    id: 'g',
    name: '',
    nodes: { n: { id: 'n', type: 'test.num', position: { x: 0, y: 0 }, values: { value: 'oops' }, params: {} } },
    edges: {},
  });
  const result = new Evaluator(doc).evaluate('n');
  assert.equal(result.status === 'error' && result.error.code, 'E_INPUT_INVALID');
});

test('unknown node types evaluate to an error but the document still loads', () => {
  const doc = GraphDocument.fromData(testRegistry(), {
    id: 'g',
    name: '',
    nodes: { m: { id: 'm', type: 'plugin.missing', position: { x: 0, y: 0 }, values: {}, params: {} } },
    edges: {},
  });
  const result = new Evaluator(doc).evaluate('m');
  assert.equal(result.status === 'error' && result.error.code, 'E_UNKNOWN_NODE_TYPE');
});

test('cycles in loaded data are reported, never loop forever, and block dependents', () => {
  const doc = GraphDocument.fromData(testRegistry(), {
    id: 'g',
    name: '',
    nodes: {
      a: { id: 'a', type: 'test.add', position: { x: 0, y: 0 }, values: {}, params: {} },
      b: { id: 'b', type: 'test.add', position: { x: 0, y: 0 }, values: {}, params: {} },
      c: { id: 'c', type: 'test.add', position: { x: 0, y: 0 }, values: {}, params: {} },
    },
    edges: {
      e1: { id: 'e1', from: { node: 'a', port: 'sum' }, to: { node: 'b', port: 'a' }, order: 1 },
      e2: { id: 'e2', from: { node: 'b', port: 'sum' }, to: { node: 'a', port: 'a' }, order: 2 },
      e3: { id: 'e3', from: { node: 'b', port: 'sum' }, to: { node: 'c', port: 'a' }, order: 3 },
    },
  });
  const ev = new Evaluator(doc);
  const code = (id: string) => {
    const r = ev.evaluate(id);
    return r.status === 'error' ? r.error.code : 'ok';
  };
  assert.equal(code('a'), 'E_CYCLE');
  assert.equal(code('b'), 'E_CYCLE');
  assert.equal(code('c'), 'E_UPSTREAM');
});

test('multi-input ports deliver values in connection order', () => {
  const ed = newEditor();
  const list = ed.addNode('test.list');
  const x = ed.addNode('test.num', { values: { value: 1 } });
  const y = ed.addNode('test.num', { values: { value: 2 } });
  const z = ed.addNode('test.num', { values: { value: 3 } });
  wire(ed, z.id, 'value', list.id, 'items');
  wire(ed, x.id, 'value', list.id, 'items');
  wire(ed, y.id, 'value', list.id, 'items');
  assert.deepEqual(new Evaluator(ed.doc).value(list.id, 'list'), [3, 1, 2]);
});

test('an unconnected multi-input is an empty list', () => {
  const ed = newEditor();
  const list = ed.addNode('test.list');
  assert.deepEqual(new Evaluator(ed.doc).value(list.id, 'list'), []);
});

test('values are converted along edges (number to vec3)', () => {
  const ed = newEditor();
  const n = ed.addNode('test.num', { values: { value: 2 } });
  const v = ed.addNode('test.vec');
  wire(ed, n.id, 'value', v.id, 'v');
  assert.deepEqual(new Evaluator(ed.doc).value(v.id, 'v'), [2, 2, 2]);
});

test('the evaluator follows undo and redo', () => {
  const ed = newEditor();
  const n = ed.addNode('test.num', { values: { value: 1 } });
  const ev = new Evaluator(ed.doc);
  assert.equal(ev.value(n.id, 'value'), 1);
  ed.setValue(n.id, 'value', 2);
  assert.equal(ev.value(n.id, 'value'), 2);
  ed.undo();
  assert.equal(ev.value(n.id, 'value'), 1);
  ed.redo();
  assert.equal(ev.value(n.id, 'value'), 2);
});

test('a removed node cannot be evaluated; a re-added node with the same id is fresh', () => {
  const ed = newEditor();
  const n = ed.addNode('test.num', { id: 'fixed', values: { value: 1 } });
  const ev = new Evaluator(ed.doc);
  ev.evaluate(n.id);
  ed.removeNode(n.id);
  assert.throws(() => ev.evaluate('fixed'), (e: unknown) => e instanceof MekdeckError && e.code === 'E_NODE_MISSING');
  ed.addNode('test.num', { id: 'fixed', values: { value: 9 } });
  assert.equal(ev.value('fixed', 'value'), 9);
});

test('a disposed evaluator stops listening', () => {
  const ed = newEditor();
  const ev = new Evaluator(ed.doc);
  ev.dispose();
  ed.addNode('test.num');
  assert.equal(ed.doc.version, 1);
});

test('a 20,000-node chain evaluates iteratively (no stack overflow) and updates incrementally', () => {
  const ed = newEditor();
  const doc = ed.doc;
  const N = 20_000;
  const ids: string[] = [];
  const ops = [];
  for (let i = 0; i < N; i++) {
    const id = `c${i}`;
    ids.push(id);
    ops.push({ op: 'addNode' as const, node: { id, type: i === 0 ? 'test.num' : 'test.add', position: { x: i, y: 0 }, values: i === 0 ? { value: 1 } : { b: 1 }, params: {} } });
  }
  doc.apply({ op: 'batch', ops });
  const edgeOps = [];
  for (let i = 1; i < N; i++) {
    edgeOps.push({
      op: 'addEdge' as const,
      edge: { id: `x${i}`, from: { node: ids[i - 1]!, port: i === 1 ? 'value' : 'sum' }, to: { node: ids[i]!, port: 'a' }, order: i },
    });
  }
  doc.apply({ op: 'batch', ops: edgeOps });

  const ev = new Evaluator(doc);
  const last = ids[N - 1]!;
  assert.equal(ev.value(last, 'sum'), N); // 1 + (N-1) additions of 1
  assert.equal(ev.stats.evaluations, N);

  ev.value(last, 'sum');
  assert.equal(ev.stats.evaluations, N, 'second pull is free');

  doc.apply({ op: 'setValue', node: 'c0', port: 'value', value: 11 });
  assert.equal(ev.value(last, 'sum'), N + 10);
  assert.equal(ev.stats.evaluations, 2 * N);
});
