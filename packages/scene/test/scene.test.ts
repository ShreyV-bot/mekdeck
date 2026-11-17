import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countObjects,
  identityTransform,
  isCamera,
  isGeometry,
  isMaterial,
  isScene,
  isSceneObject,
  SCENE_IR_VERSION,
  walkObjects,
  type GroupObject,
  type MeshObject,
  type SceneDescription,
  type SceneObject,
} from '../src/index.ts';

const mesh = (name: string): MeshObject => ({
  kind: 'mesh',
  origin: `n_${name}`,
  name,
  transform: identityTransform(),
  geometry: { kind: 'box', width: 1, height: 1, depth: 1 },
  material: { kind: 'standard', color: [1, 1, 1], roughness: 0.5, metalness: 0, emissive: [0, 0, 0] },
});

const group = (name: string, children: SceneObject[]): GroupObject => ({
  kind: 'group',
  origin: `n_${name}`,
  name,
  transform: identityTransform(),
  children,
});

const sceneOf = (objects: SceneObject[]): SceneDescription => ({
  version: SCENE_IR_VERSION,
  origin: 'out',
  background: [0, 0, 0],
  objects,
  camera: null,
});

test('identityTransform gives independent identity values', () => {
  assert.deepEqual(identityTransform(), { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  assert.notEqual(identityTransform(), identityTransform());
});

test('type guards accept real values and reject lookalikes', () => {
  assert.ok(isSceneObject(mesh('a')));
  assert.ok(isSceneObject({ kind: 'ambientLight' }));
  assert.ok(!isSceneObject({ kind: 'spaceship' }));
  assert.ok(!isSceneObject(null) && !isSceneObject('mesh') && !isSceneObject({ kind: 5 }));

  assert.ok(isCamera({ kind: 'perspectiveCamera' }));
  assert.ok(!isCamera(mesh('a')));
  assert.ok(isGeometry({ kind: 'torus' }) && !isGeometry({ kind: 'mesh' }));
  assert.ok(isMaterial({ kind: 'standard' }) && !isMaterial({ kind: 'toon' }));
  assert.ok(isScene(sceneOf([])) && !isScene({ objects: [] }) && !isScene(null));
});

test('walkObjects visits depth-first with depths, and countObjects counts everything', () => {
  const scene = sceneOf([mesh('a'), group('g', [mesh('b'), group('h', [mesh('c')])]), mesh('d')]);
  const seen: [string, number][] = [];
  walkObjects(scene.objects, (o, depth) => seen.push([o.name, depth]));
  assert.deepEqual(seen, [['a', 0], ['g', 0], ['b', 1], ['h', 1], ['c', 2], ['d', 0]]);
  assert.equal(countObjects(scene), 6);
  assert.equal(countObjects(sceneOf([])), 0);
});
