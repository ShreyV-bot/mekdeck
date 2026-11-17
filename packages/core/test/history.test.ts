import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphEditor, History, MekdeckError, stableStringify } from '../src/index.ts';
import { newDoc, newEditor } from './helpers.ts';

const snap = (ed: GraphEditor) => stableStringify(ed.doc.toJSON());

test('undo and redo walk back and forth through edits', () => {
  const ed = newEditor();
  const empty = snap(ed);
  const a = ed.addNode('test.num');
  const b = ed.addNode('test.add');
  ed.connect({ node: a.id, port: 'value' }, { node: b.id, port: 'a' });
  const full = snap(ed);

  assert.equal(ed.history.undoLabel, 'Connect');
  assert.ok(ed.undo());
  assert.ok(ed.undo());
  assert.ok(ed.undo());
  assert.equal(snap(ed), empty);
  assert.equal(ed.undo(), false);

  assert.ok(ed.redo() && ed.redo() && ed.redo());
  assert.equal(snap(ed), full);
  assert.equal(ed.redo(), false);
});

test('a new edit after undo clears the redo stack', () => {
  const ed = newEditor();
  ed.addNode('test.num');
  ed.undo();
  assert.ok(ed.history.canRedo);
  ed.addNode('test.add');
  assert.equal(ed.history.canRedo, false);
});

test('a transaction is one undo step', () => {
  const ed = newEditor();
  const before = snap(ed);
  ed.transaction('Build chain', () => {
    const a = ed.addNode('test.num');
    const b = ed.addNode('test.add');
    ed.connect({ node: a.id, port: 'value' }, { node: b.id, port: 'a' });
  });
  assert.equal(ed.doc.nodeCount, 2);
  assert.equal(ed.history.undoLabel, 'Build chain');
  ed.undo();
  assert.equal(snap(ed), before);
  assert.equal(ed.history.canUndo, false);
  ed.redo();
  assert.equal(ed.doc.edgeCount, 1);
});

test('a transaction that throws is rolled back and leaves no history', () => {
  const ed = newEditor();
  ed.addNode('test.num');
  const before = snap(ed);
  assert.throws(
    () =>
      ed.transaction('Doomed', () => {
        ed.addNode('test.add');
        ed.addNode('test.add');
        throw new Error('nope');
      }),
    /nope/,
  );
  assert.equal(snap(ed), before);
  assert.equal(ed.history.undoLabel, 'Add Number');
});

test('nested transactions merge into the outermost one', () => {
  const ed = newEditor();
  ed.transaction('Outer', () => {
    ed.addNode('test.num');
    ed.transaction('Inner', () => ed.addNode('test.num'));
  });
  assert.equal(ed.doc.nodeCount, 2);
  ed.undo();
  assert.equal(ed.doc.nodeCount, 0);
});

test('rapid edits with a coalesce key merge into one undo step that restores the original', () => {
  let now = 0;
  const doc = newDoc();
  const ed = new GraphEditor(doc, new History(doc, { now: () => now, coalesceWindowMs: 500 }));
  const n = ed.addNode('test.num', { values: { value: 1 } });

  for (const v of [2, 3, 4, 5]) {
    now += 100;
    ed.setValue(n.id, 'value', v, { coalesce: true });
  }
  assert.equal(doc.node(n.id)!.values.value, 5);

  ed.undo();
  assert.equal(doc.node(n.id)!.values.value, 1, 'one undo returns to the value before the drag');
  ed.redo();
  assert.equal(doc.node(n.id)!.values.value, 5, 'redo returns to the final value');
});

test('coalescing stops after the window and for different targets', () => {
  let now = 0;
  const doc = newDoc();
  const ed = new GraphEditor(doc, new History(doc, { now: () => now, coalesceWindowMs: 500 }));
  const a = ed.addNode('test.num');
  const b = ed.addNode('test.num');

  ed.setValue(a.id, 'value', 1, { coalesce: true });
  now += 100;
  ed.setValue(b.id, 'value', 1, { coalesce: true }); // different key
  now += 1000;
  ed.setValue(b.id, 'value', 2, { coalesce: true }); // outside the window

  ed.undo();
  assert.equal(doc.node(b.id)!.values.value, 1);
  ed.undo();
  assert.equal(doc.node(b.id)!.values.value, undefined);
  ed.undo();
  assert.equal(doc.node(a.id)!.values.value, undefined);
});

test('moveNode coalesces so dragging a node is one step', () => {
  const ed = newEditor();
  const n = ed.addNode('test.num');
  for (let i = 1; i <= 20; i++) ed.moveNode(n.id, { x: i, y: i }, { coalesce: true });
  ed.undo();
  assert.deepEqual({ ...ed.doc.node(n.id)!.position }, { x: 0, y: 0 });
});

test('history depth is bounded', () => {
  const doc = newDoc();
  const ed = new GraphEditor(doc, new History(doc, { limit: 3 }));
  for (let i = 0; i < 10; i++) ed.addNode('test.num');
  let steps = 0;
  while (ed.undo()) steps++;
  assert.equal(steps, 3);
  assert.equal(doc.nodeCount, 7);
});

test('if the document changes behind history, undo fails loudly and history is cleared', () => {
  const ed = newEditor();
  const n = ed.addNode('test.num');
  ed.doc.apply({ op: 'removeNode', id: n.id }, 'remote'); // someone else deleted it
  assert.throws(() => ed.undo(), (e: unknown) => e instanceof MekdeckError && e.code === 'E_HISTORY_DIVERGED');
  assert.equal(ed.history.canUndo, false);
  assert.equal(ed.history.canRedo, false);
});

test('history onChange fires when stacks change', () => {
  const ed = newEditor();
  let count = 0;
  const off = ed.history.onChange(() => count++);
  ed.addNode('test.num');
  ed.undo();
  ed.redo();
  off();
  ed.undo();
  assert.equal(count, 3);
});
