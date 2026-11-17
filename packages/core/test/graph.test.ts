import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GraphDocument,
  MekdeckError,
  parseGraphData,
  planConnect,
  planRemoveNode,
  stableStringify,
  type ChangeEvent,
  type Op,
} from '../src/index.ts';
import { newDoc, newEditor, testRegistry } from './helpers.ts';

const code = (expected: string) => (e: unknown) => e instanceof MekdeckError && e.code === expected;

test('adding nodes and connecting them builds queryable edges', () => {
  const ed = newEditor();
  const a = ed.addNode('test.num', { values: { value: 2 } });
  const b = ed.addNode('test.add');
  const edge = ed.connect({ node: a.id, port: 'value' }, { node: b.id, port: 'a' });

  assert.equal(ed.doc.nodeCount, 2);
  assert.equal(ed.doc.edgeCount, 1);
  assert.deepEqual(ed.doc.edgesTo(b.id).map((e) => e.id), [edge.id]);
  assert.deepEqual(ed.doc.edgesFrom(a.id, 'value').map((e) => e.id), [edge.id]);
  assert.deepEqual(ed.doc.edgesTo(b.id, 'b'), []);
});

test('connections are checked for type, ports, self-links and duplicates', () => {
  const ed = newEditor();
  const text = ed.addNode('test.text');
  const num = ed.addNode('test.num');
  const add = ed.addNode('test.add');

  assert.throws(() => ed.connect({ node: text.id, port: 'value' }, { node: add.id, port: 'a' }), code('E_TYPE_MISMATCH'));
  assert.throws(() => ed.connect({ node: num.id, port: 'nope' }, { node: add.id, port: 'a' }), code('E_PORT_MISSING'));
  assert.throws(() => ed.connect({ node: num.id, port: 'value' }, { node: add.id, port: 'zzz' }), code('E_PORT_MISSING'));
  assert.throws(() => ed.connect({ node: add.id, port: 'sum' }, { node: add.id, port: 'a' }), code('E_SELF_CONNECTION'));
  assert.throws(() => ed.connect({ node: 'ghost', port: 'value' }, { node: add.id, port: 'a' }), code('E_NODE_MISSING'));

  ed.connect({ node: num.id, port: 'value' }, { node: add.id, port: 'a' });
  assert.throws(() => ed.connect({ node: num.id, port: 'value' }, { node: add.id, port: 'a' }), code('E_DUPLICATE_EDGE'));
});

test('cycles are rejected, including long ones', () => {
  const ed = newEditor();
  const [a, b, c] = [ed.addNode('test.add'), ed.addNode('test.add'), ed.addNode('test.add')] as const;
  ed.connect({ node: a.id, port: 'sum' }, { node: b.id, port: 'a' });
  ed.connect({ node: b.id, port: 'sum' }, { node: c.id, port: 'a' });
  assert.throws(() => ed.connect({ node: c.id, port: 'sum' }, { node: a.id, port: 'a' }), code('E_CYCLE'));
  assert.equal(ed.doc.edgeCount, 2, 'failed connect leaves the graph unchanged');
});

test('connecting to an occupied single-input port replaces the edge as one undoable step', () => {
  const ed = newEditor();
  const n1 = ed.addNode('test.num');
  const n2 = ed.addNode('test.num');
  const add = ed.addNode('test.add');
  const first = ed.connect({ node: n1.id, port: 'value' }, { node: add.id, port: 'a' });
  const second = ed.connect({ node: n2.id, port: 'value' }, { node: add.id, port: 'a' });

  assert.equal(ed.doc.edge(first.id), undefined);
  assert.ok(ed.doc.edge(second.id));
  assert.equal(ed.doc.edgesTo(add.id, 'a').length, 1);

  ed.undo();
  assert.ok(ed.doc.edge(first.id), 'undo restores the replaced edge');
  assert.equal(ed.doc.edge(second.id), undefined);
});

test('strict apply() refuses to double-connect a single-input port', () => {
  const ed = newEditor();
  const n1 = ed.addNode('test.num');
  const n2 = ed.addNode('test.num');
  const add = ed.addNode('test.add');
  ed.connect({ node: n1.id, port: 'value' }, { node: add.id, port: 'a' });
  assert.throws(
    () => ed.doc.apply({ op: 'addEdge', edge: { id: 'e_x', from: { node: n2.id, port: 'value' }, to: { node: add.id, port: 'a' }, order: 99 } }),
    code('E_PORT_OCCUPIED'),
  );
});

test('multi-input ports keep edges in creation order', () => {
  const ed = newEditor();
  const list = ed.addNode('test.list');
  const [x, y, z] = [ed.addNode('test.num'), ed.addNode('test.num'), ed.addNode('test.num')] as const;
  ed.connect({ node: z.id, port: 'value' }, { node: list.id, port: 'items' });
  ed.connect({ node: x.id, port: 'value' }, { node: list.id, port: 'items' });
  ed.connect({ node: y.id, port: 'value' }, { node: list.id, port: 'items' });
  assert.deepEqual(ed.doc.edgesTo(list.id, 'items').map((e) => e.from.node), [z.id, x.id, y.id]);
});

test('removing a node removes its edges and one undo restores everything exactly', () => {
  const ed = newEditor();
  const a = ed.addNode('test.num');
  const b = ed.addNode('test.add');
  const c = ed.addNode('test.mul');
  ed.connect({ node: a.id, port: 'value' }, { node: b.id, port: 'a' });
  ed.connect({ node: b.id, port: 'sum' }, { node: c.id, port: 'a' });
  const before = stableStringify(ed.doc.toJSON());

  ed.removeNode(b.id);
  assert.equal(ed.doc.nodeCount, 2);
  assert.equal(ed.doc.edgeCount, 0);

  ed.undo();
  assert.equal(stableStringify(ed.doc.toJSON()), before);
});

test('removeNode primitive refuses while edges remain', () => {
  const ed = newEditor();
  const a = ed.addNode('test.num');
  const b = ed.addNode('test.add');
  ed.connect({ node: a.id, port: 'value' }, { node: b.id, port: 'a' });
  assert.throws(() => ed.doc.apply({ op: 'removeNode', id: a.id }), code('E_NODE_HAS_EDGES'));
});

test('a failing batch rolls back completely and emits no event', () => {
  const doc = newDoc();
  const events: ChangeEvent[] = [];
  doc.on((e) => events.push(e));
  const node = (id: string) => ({ id, type: 'test.num', position: { x: 0, y: 0 }, values: {}, params: {} });
  const batch: Op = { op: 'batch', ops: [{ op: 'addNode', node: node('one') }, { op: 'addNode', node: node('two') }, { op: 'addNode', node: node('one') }] };

  assert.throws(() => doc.apply(batch), code('E_NODE_EXISTS'));
  assert.equal(doc.nodeCount, 0);
  assert.equal(events.length, 0);
  assert.equal(doc.version, 0);
});

test('change events carry an inverse that restores the previous state', () => {
  const doc = newDoc();
  const events: ChangeEvent[] = [];
  doc.on((e) => events.push(e));
  const ed = newEditor();
  void ed;

  doc.apply({ op: 'addNode', node: { id: 'a', type: 'test.num', position: { x: 1, y: 2 }, values: { value: 5 }, params: {} } });
  const snapshot = stableStringify(doc.toJSON());
  doc.apply({ op: 'setValue', node: 'a', port: 'value', value: 9 });
  doc.apply({ op: 'moveNode', node: 'a', position: { x: 10, y: 20 } });
  doc.apply({ op: 'setLabel', node: 'a', label: 'Hello' });
  assert.notEqual(stableStringify(doc.toJSON()), snapshot);

  for (const event of events.slice(1).reverse()) doc.apply(event.inverse, 'undo');
  assert.equal(stableStringify(doc.toJSON()), snapshot);
  assert.equal(doc.version, 7);
});

test('moving or renaming a node does not change its revision; editing a value does', () => {
  const ed = newEditor();
  const n = ed.addNode('test.num');
  const rev = ed.doc.nodeRevision(n.id);
  ed.moveNode(n.id, { x: 50, y: 50 });
  ed.rename(n.id, 'Renamed');
  assert.equal(ed.doc.nodeRevision(n.id), rev);
  ed.setValue(n.id, 'value', 3);
  assert.notEqual(ed.doc.nodeRevision(n.id), rev);
});

test('node data handed out is immutable', () => {
  const ed = newEditor();
  const n = ed.addNode('test.num', { values: { value: 1 } });
  assert.throws(() => {
    (n.values as Record<string, unknown>).value = 2;
  }, TypeError);
  assert.ok(Object.isFrozen(ed.doc.node(n.id)));
});

test('planners validate values and params before anything is applied', () => {
  const ed = newEditor();
  assert.throws(() => ed.addNode('test.nope'), code('E_UNKNOWN_NODE_TYPE'));
  assert.throws(() => ed.addNode('test.num', { values: { value: 'x' } }), code('E_VALUE_INVALID'));
  assert.throws(() => ed.addNode('test.num', { values: { nope: 1 } }), code('E_PORT_MISSING'));
  assert.throws(() => ed.addNode('test.scale', { params: { mode: 'zzz' } }), code('E_PARAM_INVALID'));
  assert.throws(() => ed.addNode('test.num', { id: 'bad id!' }), code('E_ID_INVALID'));
  assert.equal(ed.doc.nodeCount, 0);
  assert.equal(ed.history.canUndo, false);

  const n = ed.addNode('test.scale');
  assert.throws(() => ed.setParam(n.id, 'factor', 'big'), code('E_PARAM_INVALID'));
  assert.throws(() => ed.setValue(n.id, 'value', [1, 2]), code('E_VALUE_INVALID'));
  assert.doesNotThrow(() => planRemoveNode(ed.doc, n.id));
  assert.throws(() => planConnect(ed.doc, { node: n.id, port: 'out' }, { node: 'ghost', port: 'x' }), code('E_NODE_MISSING'));
});

test('toJSON / fromData round-trips, including nodes of unknown types', () => {
  const ed = newEditor();
  const a = ed.addNode('test.num', { values: { value: 4 }, position: { x: 10, y: 20 } });
  const b = ed.addNode('test.add');
  ed.connect({ node: a.id, port: 'value' }, { node: b.id, port: 'a' });
  ed.doc.apply({ op: 'addNode', node: { id: 'mystery', type: 'plugin.missing', position: { x: 0, y: 0 }, values: { q: 1 }, params: { z: 'k' } } });

  const json = JSON.parse(stableStringify(ed.doc.toJSON()));
  const loaded = GraphDocument.fromData(testRegistry(), json);
  assert.equal(stableStringify(loaded.toJSON()), stableStringify(ed.doc.toJSON()));
  assert.ok(loaded.validate().some((d) => d.code === 'unknown-node-type' && d.node === 'mystery'));
});

test('parseGraphData rejects malformed files with a pointer to the problem', () => {
  const good = { id: 'g1', name: 'ok', nodes: { a: { id: 'a', type: 'test.num', position: { x: 0, y: 0 }, values: {}, params: {} } }, edges: {} };
  assert.doesNotThrow(() => parseGraphData(good));

  const bad = (patch: Record<string, unknown>) => () => parseGraphData({ ...good, ...patch });
  assert.throws(() => parseGraphData(null), code('E_GRAPH_INVALID'));
  assert.throws(bad({ id: '../evil' }), /id/);
  assert.throws(bad({ nodes: [] }), /nodes/);
  assert.throws(bad({ nodes: { a: { ...good.nodes.a, id: 'other' } } }), /nodes\.a\.id/);
  assert.throws(bad({ nodes: { a: { ...good.nodes.a, position: { x: 'q', y: 0 } } } }), /position/);
  assert.throws(bad({ nodes: { a: { ...good.nodes.a, values: { v: Number.NaN } } } }), /finite/);
  assert.throws(
    bad({ edges: { e1: { id: 'e1', from: { node: 'a', port: 'value' }, to: { node: 'ghost', port: 'a' }, order: 1 } } }),
    /missing node "ghost"/,
  );
  assert.throws(
    bad({ edges: { e1: { id: 'e1', from: { node: 'a', port: '__proto__' }, to: { node: 'a', port: 'a' }, order: 1 } } }),
    code('E_GRAPH_INVALID'),
  );
  assert.throws(() => parseGraphData(JSON.parse('{"id":"g","name":"","nodes":{"a":{"id":"a","type":"t.t","position":{"x":0,"y":0},"values":{"__proto__":1},"params":{}}},"edges":{}}')), /__proto__/);
});

test('validate() reports unknown ports, bad params, missing inputs, mismatches and cycles from loaded data', () => {
  const data = {
    id: 'g',
    name: 'bad',
    nodes: {
      s: { id: 's', type: 'test.scale', position: { x: 0, y: 0 }, values: { ghost: 1 }, params: { factor: 'x', extra: 1 } },
      r: { id: 'r', type: 'test.required', position: { x: 0, y: 0 }, values: {}, params: {} },
      t: { id: 't', type: 'test.text', position: { x: 0, y: 0 }, values: {}, params: {} },
      a: { id: 'a', type: 'test.add', position: { x: 0, y: 0 }, values: {}, params: {} },
      b: { id: 'b', type: 'test.add', position: { x: 0, y: 0 }, values: {}, params: {} },
    },
    edges: {
      m: { id: 'm', from: { node: 't', port: 'value' }, to: { node: 's', port: 'value' }, order: 1 },
      c1: { id: 'c1', from: { node: 'a', port: 'sum' }, to: { node: 'b', port: 'a' }, order: 2 },
      c2: { id: 'c2', from: { node: 'b', port: 'sum' }, to: { node: 'a', port: 'a' }, order: 3 },
    },
  };
  const found = new Set(GraphDocument.fromData(testRegistry(), data).validate().map((d) => d.code));
  for (const expected of ['unknown-input-value', 'invalid-param', 'unknown-param', 'missing-input', 'type-mismatch', 'cycle']) {
    assert.ok(found.has(expected), `expected a "${expected}" diagnostic, got ${[...found].join(', ')}`);
  }
});

test('ids from the random generator never collide with existing ones', () => {
  const doc = new GraphDocument(testRegistry(), { ids: (() => { let n = 0; return () => `n_${n++ < 3 ? 1 : n}`; })() });
  doc.apply({ op: 'addNode', node: { id: 'n_1', type: 'test.num', position: { x: 0, y: 0 }, values: {}, params: {} } });
  const id = doc.newNodeId();
  assert.notEqual(id, 'n_1');
});
