import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GraphDocument, GraphEditor, MekdeckError } from '@mekdeck/core';
import { createRegistry, createSampleGraph, evaluateScene } from '@mekdeck/nodes';
import { identityTransform, type MeshObject, type SceneDescription } from '@mekdeck/scene';
import { generateProject, IdentAllocator, num, type GeneratedFile } from '../src/index.ts';

const sampleScene = (): SceneDescription => evaluateScene(createSampleGraph(createRegistry()));
const mainOf = (scene: SceneDescription): GeneratedFile =>
  generateProject(scene, { target: 'three', projectName: 'Demo' }).files.find((f) => f.path === 'src/main.js')!;
const code = (expected: string) => (e: unknown) => e instanceof MekdeckError && e.code === expected;

function syntaxCheck(source: string): { ok: boolean; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mekdeck-gen-'));
  try {
    const file = join(dir, 'main.mjs');
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    return { ok: result.status === 0, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- a recording stand-in for three.js, so we can RUN the generated program ----------------------

interface Fake {
  type: string;
  args: unknown[];
  name?: string;
  children: Fake[];
  calls: [string, unknown[]][];
}

function runGenerated(source: string) {
  const created: Fake[] = [];
  const vec = (owner: Fake, prop: string) => ({ set: (...a: unknown[]) => owner.calls.push([`${prop}.set`, a]) });
  const makeClass = (type: string) =>
    class {
      type = type;
      args: unknown[];
      children: Fake[] = [];
      calls: [string, unknown[]][] = [];
      position = vec(this as unknown as Fake, 'position');
      rotation = vec(this as unknown as Fake, 'rotation');
      scale = vec(this as unknown as Fake, 'scale');
      constructor(...args: unknown[]) {
        this.args = args;
        created.push(this as unknown as Fake);
      }
      add(child: Fake) {
        this.children.push(child);
      }
      lookAt(...a: unknown[]) {
        this.calls.push(['lookAt', a]);
      }
      setRGB(...a: unknown[]) {
        this.calls.push(['setRGB', a]);
        return this;
      }
      updateProjectionMatrix() {}
      setPixelRatio() {}
      setSize() {}
      render(...a: unknown[]) {
        this.calls.push(['render', a]);
      }
      setAnimationLoop(fn: () => void) {
        fn();
      }
      domElement = { tag: 'canvas' };
    };
  const THREE: Record<string, unknown> = { SRGBColorSpace: 'srgb' };
  for (const t of ['Scene', 'Mesh', 'Group', 'BoxGeometry', 'SphereGeometry', 'PlaneGeometry', 'CylinderGeometry', 'TorusGeometry', 'MeshStandardMaterial', 'DirectionalLight', 'AmbientLight', 'PerspectiveCamera', 'WebGLRenderer', 'Color']) {
    THREE[t] = makeClass(t);
  }
  const listeners: Record<string, () => void> = {};
  const window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 2, addEventListener: (e: string, fn: () => void) => (listeners[e] = fn) };
  const document = { body: { appendChild: (el: unknown) => created.push({ type: 'appended', args: [el], children: [], calls: [] }) } };

  const body = source.replace("import * as THREE from 'three';", '');
  new Function('THREE', 'window', 'document', body)(THREE, window, document);
  return { created, listeners };
}

test('generates a complete Vite + three.js project', () => {
  const project = generateProject(sampleScene(), { target: 'three', projectName: 'My Demo' });
  assert.deepEqual(project.files.map((f) => f.path), ['package.json', 'index.html', 'src/main.js', 'README.md', '.gitignore']);
  const pkg = JSON.parse(project.files.find((f) => f.path === 'package.json')!.content);
  assert.equal(pkg.name, 'my-demo');
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.dependencies.three && pkg.devDependencies.vite);
  assert.deepEqual(Object.keys(pkg.scripts), ['dev', 'build', 'preview']);
});

test('generated main.js reads like hand-written three.js', () => {
  const js = mainOf(sampleScene()).content;
  for (const expected of [
    "import * as THREE from 'three';",
    'scene.background = srgb(0.08, 0.09, 0.12);',
    'new THREE.BoxGeometry(1, 1, 1)',
    'new THREE.SphereGeometry(0.5, 32, 16)',
    'new THREE.PlaneGeometry(12, 12)',
    'cube.position.set(0, 0.5, 0);',
    'cube.rotation.set(0, 0.523599, 0);',
    'floor.rotation.set(-1.570796, 0, 0);',
    'new THREE.DirectionalLight(srgb(1, 1, 1), 2.5)',
    'new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000)',
    'camera.lookAt(0, 0.5, 0);',
    'scene.add(cube);',
    'renderer.setAnimationLoop',
  ]) {
    assert.ok(js.includes(expected), `expected generated code to contain: ${expected}\n${js}`);
  }
  assert.ok(!js.includes('cube.scale'), 'default transforms are not emitted');
  assert.ok(!js.includes('emissive'), 'black emissive is not emitted');
});

test('the generated JavaScript is syntactically valid', () => {
  const { ok, stderr } = syntaxCheck(mainOf(sampleScene()).content);
  assert.ok(ok, stderr);
});

test('the generated program RUNS and builds the same scene the graph described', () => {
  const { created, listeners } = runGenerated(mainOf(sampleScene()).content);
  const scene = created.find((o) => o.type === 'Scene')!;
  assert.deepEqual(scene.children.map((c) => c.type), ['Mesh', 'Mesh', 'Mesh', 'DirectionalLight', 'AmbientLight']);

  const cube = scene.children[0]!;
  assert.equal(cube.children.length, 0);
  assert.deepEqual(cube.calls.find(([name]) => name === 'position.set')![1], [0, 0.5, 0]);
  assert.equal((cube.args[0] as Fake).type, 'BoxGeometry');
  assert.equal((cube.args[1] as Fake).type, 'MeshStandardMaterial');

  const camera = created.find((o) => o.type === 'PerspectiveCamera')!;
  assert.deepEqual(camera.args, [50, 800 / 600, 0.1, 1000]);
  assert.deepEqual(camera.calls.find(([n]) => n === 'lookAt')![1], [0, 0.5, 0]);

  const renderer = created.find((o) => o.type === 'WebGLRenderer')!;
  const render = renderer.calls.find(([n]) => n === 'render')!;
  assert.equal(render[1][0], scene);
  assert.equal(render[1][1], camera);
  assert.equal(typeof listeners.resize, 'function', 'handles window resize');
});

test('source ranges tie lines of code back to graph nodes', () => {
  const file = mainOf(sampleScene());
  const lines = file.content.split('\n');
  const slice = (origin: string) => {
    const range = file.ranges!.find((r) => r.origin === origin)!;
    assert.ok(range, `no range for ${origin}`);
    return lines.slice(range.startLine - 1, range.endLine).join('\n');
  };
  assert.match(slice('box'), /BoxGeometry/);
  assert.match(slice('box'), /scene\.add\(cube\)/);
  assert.match(slice('ball'), /SphereGeometry/);
  assert.match(slice('sun'), /DirectionalLight/);
  assert.match(slice('cam'), /PerspectiveCamera/);
  assert.match(slice('output'), /new THREE\.Scene/);
  for (const range of file.ranges!) {
    assert.ok(range.startLine >= 1 && range.endLine <= lines.length && range.startLine <= range.endLine);
  }
  const boxRange = file.ranges!.find((r) => r.origin === 'box')!;
  assert.equal(boxRange.name, 'cube');
  assert.equal(boxRange.kind, 'mesh');
});

test('groups nest their children and the code runs', () => {
  const ed = new GraphEditor(new GraphDocument(createRegistry()));
  const geo = ed.addNode('scene.box', { id: 'geo' });
  const mesh = ed.addNode('scene.mesh', { id: 'mesh', params: { name: 'Inner' } });
  const group = ed.addNode('scene.group', { id: 'grp', params: { name: 'Pair' }, values: { position: [0, 3, 0] } });
  const out = ed.addNode('scene.output', { id: 'out' });
  ed.connect({ node: geo.id, port: 'geometry' }, { node: mesh.id, port: 'geometry' });
  ed.connect({ node: mesh.id, port: 'object' }, { node: group.id, port: 'children' });
  ed.connect({ node: group.id, port: 'object' }, { node: out.id, port: 'objects' });

  const file = mainOf(evaluateScene(ed.doc));
  assert.ok(file.content.includes('inner.add') === false);
  assert.ok(file.content.includes('pair.add(inner);'));
  assert.ok(file.content.includes('scene.add(pair);'));
  assert.ok(file.content.includes('// The graph has no camera'));

  const { created } = runGenerated(file.content);
  const scene = created.find((o) => o.type === 'Scene')!;
  assert.equal(scene.children[0]!.type, 'Group');
  assert.equal(scene.children[0]!.children[0]!.type, 'Mesh');

  const inner = file.ranges!.find((r) => r.origin === 'mesh')!;
  const outer = file.ranges!.find((r) => r.origin === 'grp')!;
  assert.ok(outer.startLine < inner.startLine && inner.endLine < outer.endLine, 'child range sits inside the group range');
  assert.equal(inner.depth, outer.depth + 1);
});

test('hostile object names cannot break out of the generated code', () => {
  const evil = ['x"; process.exit(1); //', "it's \\ a `test` ${1+1}", 'class', 'scene', 'camera', 'THREE', 'default', '1st', 'Ünï cødé 立方体', ' newline ', ''];
  const base = sampleScene();
  const template = base.objects.find((o): o is MeshObject => o.kind === 'mesh')!;
  const scene: SceneDescription = { ...base, objects: evil.map((name, i) => ({ ...template, name, origin: `o${i}` })) };

  const file = mainOf(scene);
  const { ok, stderr } = syntaxCheck(file.content);
  assert.ok(ok, stderr + file.content);

  const { created } = runGenerated(file.content);
  const names = created.find((o) => o.type === 'Scene')!.children.map((c) => c.type);
  assert.equal(names.length, evil.length);

  const idents = file.ranges!.filter((r) => r.kind === 'mesh').map((r) => r.name);
  assert.equal(new Set(idents).size, evil.length, 'identifiers are unique');
  for (const id of idents) assert.match(id, /^[A-Za-z_$][\w$]*$/);
  for (const reserved of ['class', 'scene', 'camera', 'THREE', 'default']) assert.ok(!idents.includes(reserved), `${reserved} must not be used as an identifier`);
});

test('the identifier allocator is unique, camelCased and keyword-safe', () => {
  const ids = new IdentAllocator();
  assert.equal(ids.claim('My Cube!'), 'myCube');
  assert.equal(ids.claim('my cube'), 'myCube2');
  assert.equal(ids.claim('class'), 'class2');
  assert.equal(ids.claim('Café Table'), 'cafeTable');
  assert.equal(ids.claim('9 lives'), '_9Lives');
  assert.equal(ids.claim('立方体'), 'object');
  assert.equal(ids.claim('   '), 'object2');
});

test('numbers are tidy and non-finite values are refused', () => {
  assert.equal(num(0.1 + 0.2), '0.3');
  assert.equal(num(-0), '0');
  assert.equal(num(1e-9), '0');
  assert.equal(num(Math.PI / 6), '0.523599');
  assert.equal(num(1234567), '1234567');
  assert.throws(() => num(Number.NaN), code('E_CODEGEN_NONFINITE'));
  assert.throws(() => num(Number.POSITIVE_INFINITY), code('E_CODEGEN_NONFINITE'));

  const base = sampleScene();
  const mesh = base.objects.find((o): o is MeshObject => o.kind === 'mesh')!;
  const broken: SceneDescription = { ...base, objects: [{ ...mesh, transform: { ...identityTransform(), position: [Number.NaN, 0, 0] } }] };
  assert.throws(() => generateProject(broken, { target: 'three' }), code('E_CODEGEN_NONFINITE'));
});

test('the page title is HTML-escaped and the package name is a safe slug', () => {
  const project = generateProject(sampleScene(), { target: 'three', projectName: '<script>alert(1)</script> & "co"' });
  const html = project.files.find((f) => f.path === 'index.html')!.content;
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;'));
  const pkg = JSON.parse(project.files.find((f) => f.path === 'package.json')!.content);
  assert.match(pkg.name, /^[a-z0-9-]+$/);
});

test('generation is deterministic', () => {
  const a = generateProject(sampleScene(), { target: 'three' });
  const b = generateProject(sampleScene(), { target: 'three' });
  assert.deepEqual(a, b);
});

test('unknown targets list the available ones', () => {
  assert.throws(() => generateProject(sampleScene(), { target: 'unreal' }), (e: unknown) => e instanceof MekdeckError && e.code === 'E_TARGET_UNSUPPORTED' && /three/.test(e.message));
});

test('cameras in the object list are refused with a helpful error', () => {
  const base = sampleScene();
  const scene: SceneDescription = { ...base, objects: [...base.objects, base.camera!] };
  assert.throws(() => generateProject(scene, { target: 'three' }), code('E_CODEGEN_UNSUPPORTED'));
});
