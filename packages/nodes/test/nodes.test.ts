import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Evaluator, GraphDocument, GraphEditor, hasErrors, MekdeckError } from '@mekdeck/core';
import { countObjects, walkObjects, type MeshObject } from '@mekdeck/scene';
import { createRegistry, createSampleGraph, evaluateScene, standardNodes } from '../src/index.ts';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('the standard library registers cleanly and exposes palette categories', () => {
  const registry = createRegistry();
  assert.equal(registry.list().length, standardNodes.length);
  const categories = [...registry.byCategory().keys()];
  for (const expected of ['Math', 'Vector', 'Geometry', 'Material', 'Object', 'Light', 'Camera', 'Output', 'Value']) {
    assert.ok(categories.includes(expected), `missing category ${expected}`);
  }
});

test('the sample graph is valid and evaluates to the expected scene', () => {
  const registry = createRegistry();
  const doc = createSampleGraph(registry);
  const diagnostics = doc.validate();
  assert.deepEqual(diagnostics, [], 'sample graph should have no diagnostics at all');

  const scene = evaluateScene(doc);
  assert.equal(scene.objects.length, 5);
  assert.equal(countObjects(scene), 5);
  assert.equal(scene.origin, 'output');
  assert.deepEqual([...scene.background], [0.08, 0.09, 0.12]);
  assert.equal(scene.camera?.name, 'Camera');
  assert.deepEqual([...scene.camera!.position], [3.5, 2.5, 5.5]);

  const meshes = scene.objects.filter((o): o is MeshObject => o.kind === 'mesh');
  const cube = meshes.find((m) => m.name === 'Cube')!;
  assert.deepEqual([...cube.transform.position], [0, 0.5, 0], 'height 1 * 0.5 lifts the cube onto the floor');
  near(cube.transform.rotation[1], (30 * Math.PI) / 180);
  const floor = meshes.find((m) => m.name === 'Floor')!;
  near(floor.transform.rotation[0], -Math.PI / 2);
  assert.deepEqual(floor.geometry, { kind: 'plane', width: 12, height: 12 });
});

test('every scene object points back at a real graph node (code and canvas stay linked)', () => {
  const doc = createSampleGraph(createRegistry());
  const scene = evaluateScene(doc);
  walkObjects(scene.objects, (object) => assert.ok(doc.node(object.origin), `origin ${object.origin} must exist`));
  assert.ok(doc.node(scene.camera!.origin));
});

test('editing the graph changes the scene', () => {
  const doc = createSampleGraph(createRegistry());
  new GraphEditor(doc).setValue('height', 'value', 2);
  const cube = evaluateScene(doc).objects.find((o) => o.name === 'Cube') as MeshObject;
  assert.deepEqual([...cube.transform.position], [0, 1, 0]);
});

test('a graph with no Scene Output says so', () => {
  const doc = new GraphDocument(createRegistry());
  assert.throws(() => evaluateScene(doc), (e: unknown) => e instanceof MekdeckError && e.code === 'E_NO_SCENE_OUTPUT');
});

test('errors name the node that actually failed, not the blocked ones downstream', () => {
  const registry = createRegistry();
  const ed = new GraphEditor(new GraphDocument(registry));
  const mesh = ed.addNode('scene.mesh', { id: 'bad_mesh' }); // geometry is required and unconnected
  const out = ed.addNode('scene.output', { id: 'out' });
  ed.connect({ node: mesh.id, port: 'object' }, { node: out.id, port: 'objects' });

  assert.throws(
    () => evaluateScene(ed.doc),
    (e: unknown) =>
      e instanceof MekdeckError && e.code === 'E_INPUT_MISSING' && /bad_mesh/.test(e.message) && /geometry/.test(e.message),
  );
  assert.ok(hasErrors([]) === false);
});

test('invalid geometry values are rejected with a clear message', () => {
  const ed = new GraphEditor(new GraphDocument(createRegistry()));
  const sphere = ed.addNode('scene.sphere', { id: 'sph', values: { radius: -1 } });
  const mesh = ed.addNode('scene.mesh', { id: 'm' });
  const out = ed.addNode('scene.output', { id: 'out' });
  ed.connect({ node: sphere.id, port: 'geometry' }, { node: mesh.id, port: 'geometry' });
  ed.connect({ node: mesh.id, port: 'object' }, { node: out.id, port: 'objects' });
  assert.throws(() => evaluateScene(ed.doc), /Radius must be greater than 0/);
});

test('cameras are only accepted on the Camera input', () => {
  const ed = new GraphEditor(new GraphDocument(createRegistry()));
  const cam = ed.addNode('scene.perspectiveCamera', { id: 'cam' });
  const out = ed.addNode('scene.output', { id: 'out' });
  ed.connect({ node: cam.id, port: 'camera' }, { node: out.id, port: 'objects' });
  assert.throws(() => evaluateScene(ed.doc), /Camera input/);
});

test('camera field of view is range-checked', () => {
  const ed = new GraphEditor(new GraphDocument(createRegistry()));
  const cam = ed.addNode('scene.perspectiveCamera', { id: 'cam', values: { fov: 200 } });
  const out = ed.addNode('scene.output', { id: 'out' });
  ed.connect({ node: cam.id, port: 'camera' }, { node: out.id, port: 'camera' });
  assert.throws(() => evaluateScene(ed.doc), /Field of view/);
});

test('groups nest objects and apply their own transform', () => {
  const ed = new GraphEditor(new GraphDocument(createRegistry()));
  const box = ed.addNode('scene.box', { id: 'g1' });
  const mesh = ed.addNode('scene.mesh', { id: 'm1' });
  const group = ed.addNode('scene.group', { id: 'grp', values: { position: [0, 3, 0], rotation: [0, 90, 0] }, params: { name: 'Pair' } });
  const out = ed.addNode('scene.output', { id: 'out' });
  ed.connect({ node: box.id, port: 'geometry' }, { node: mesh.id, port: 'geometry' });
  ed.connect({ node: mesh.id, port: 'object' }, { node: group.id, port: 'children' });
  ed.connect({ node: group.id, port: 'object' }, { node: out.id, port: 'objects' });

  const scene = evaluateScene(ed.doc);
  assert.equal(scene.objects.length, 1);
  const g = scene.objects[0]!;
  assert.equal(g.kind, 'group');
  assert.equal(g.kind === 'group' && g.children.length, 1);
  assert.equal(countObjects(scene), 2);
  assert.deepEqual(g.kind === 'group' && [...g.transform.position], [0, 3, 0]);
  near(g.kind === 'group' ? g.transform.rotation[1] : 0, Math.PI / 2);
});

test('math and vector nodes behave', () => {
  const ed = new GraphEditor(new GraphDocument(createRegistry()));
  const div = ed.addNode('math.divide', { id: 'div', values: { a: 5, b: 0 } });
  const sub = ed.addNode('math.subtract', { id: 'sub', values: { a: 5, b: 2 } });
  const sin = ed.addNode('math.sine', { id: 'sin', values: { value: Math.PI / 2 } });
  const comb = ed.addNode('vector.combine', { id: 'comb', values: { x: 1, y: 2, z: 3 } });
  const sep = ed.addNode('vector.separate', { id: 'sep' });
  ed.connect({ node: comb.id, port: 'vector' }, { node: sep.id, port: 'vector' });
  const ev = new Evaluator(ed.doc);
  assert.equal(ev.value(div.id, 'result'), 0, 'division by zero is 0, not Infinity');
  assert.equal(ev.value(sub.id, 'result'), 3);
  near(ev.value(sin.id, 'result') as number, 1);
  assert.deepEqual([ev.value(sep.id, 'x'), ev.value(sep.id, 'y'), ev.value(sep.id, 'z')], [1, 2, 3]);
});

test('the Time node follows the playhead', () => {
  const ed = new GraphEditor(new GraphDocument(createRegistry()));
  const t = ed.addNode('math.time', { id: 't' });
  const ev = new Evaluator(ed.doc, { time: 0 });
  assert.equal(ev.value(t.id, 'time'), 0);
  ev.setTime(2.5, 150);
  assert.equal(ev.value(t.id, 'time'), 2.5);
  assert.equal(ev.value(t.id, 'frame'), 150);
});

test('scene evaluation does not mutate the document', () => {
  const doc = createSampleGraph(createRegistry());
  const before = JSON.stringify(doc.toJSON());
  evaluateScene(doc);
  evaluateScene(doc, { time: 3 });
  assert.equal(JSON.stringify(doc.toJSON()), before);
});
