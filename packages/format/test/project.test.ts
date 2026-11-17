import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MekdeckError, stableStringify } from '@mekdeck/core';
import { createRegistry, createSampleGraph } from '@mekdeck/nodes';
import {
  createProject,
  filesToProject,
  MANIFEST_PATH,
  MEKD_MIMETYPE,
  packProject,
  projectToFiles,
  unpackProject,
  writeZip,
  type MekdProject,
} from '../src/index.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const code = (expected: string) => (e: unknown) => e instanceof MekdeckError && e.code === expected;
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function sampleProject(): MekdProject {
  const project = createProject('Demo ✓', '2026-01-01T00:00:00.000Z');
  project.meta.author = 'Ada';
  project.meta.entryGraph = 'main';
  project.graphs.main = createSampleGraph(createRegistry()).toJSON();
  project.scripts['hello.ts'] = '// héllo ✓\nexport const x = 1;\n';
  project.assets['textures/noise.bin'] = random(4096);
  project.unknown['timelines/main.json'] = utf8('{"tracks":[]}\n');
  return project;
}

const same = (a: MekdProject, b: MekdProject) => {
  assert.equal(stableStringify(a.meta), stableStringify(b.meta));
  assert.equal(stableStringify(a.graphs), stableStringify(b.graphs));
  assert.deepEqual(a.scripts, b.scripts);
  assert.deepEqual(a.assets, b.assets);
  assert.deepEqual(a.unknown, b.unknown);
};

test('a project survives pack and unpack unchanged', async () => {
  const project = sampleProject();
  const bytes = await packProject(project);
  const result = await unpackProject(bytes);
  assert.equal(result.profile, 'project');
  assert.deepEqual(result.diagnostics, []);
  same(result.project, project);
});

test('packing is deterministic and idempotent across a round trip', async () => {
  const project = sampleProject();
  const first = await packProject(project);
  assert.deepEqual(await packProject(project), first);
  const reopened = (await unpackProject(first)).project;
  assert.deepEqual(await packProject(reopened), first, 'pack(unpack(pack(p))) must equal pack(p)');
});

test('a .mekd starts with a recognisable mimetype entry', async () => {
  const bytes = await packProject(sampleProject());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(text(bytes.subarray(30, 38)), 'mimetype');
  assert.equal(text(bytes.subarray(38, 38 + MEKD_MIMETYPE.length)), MEKD_MIMETYPE, 'stored uncompressed at a fixed offset');
});

test('the manifest lists every file with size and SHA-256, in a stable order', async () => {
  const files = await projectToFiles(sampleProject());
  assert.equal([...files.keys()][0], MANIFEST_PATH);
  const manifest = JSON.parse(text(files.get(MANIFEST_PATH)!));
  assert.equal(manifest.format, 'mekd');
  assert.equal(manifest.formatVersion, 1);
  assert.deepEqual(Object.keys(manifest.files), ['assets/textures/noise.bin', 'graphs/main.graph.json', 'scripts/hello.ts', 'timelines/main.json']);
  for (const info of Object.values<{ size: number; sha256: string }>(manifest.files)) {
    assert.match(info.sha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(text(files.get(MANIFEST_PATH)!).endsWith('\n'));
});

test('tampering with a file is detected (strict), reportable (warn) or ignorable (off)', async () => {
  const files = await projectToFiles(sampleProject());
  const tampered = new Map(files);
  tampered.set('scripts/hello.ts', utf8('// evil\n'));

  await assert.rejects(filesToProject(tampered), code('E_INTEGRITY'));

  const warned = await filesToProject(tampered, { verify: 'warn' });
  assert.ok(warned.diagnostics.some((d) => d.code === 'integrity-failed' && d.path === 'scripts/hello.ts'));
  assert.equal(warned.project.scripts['hello.ts'], '// evil\n');

  const off = await filesToProject(tampered, { verify: 'off' });
  assert.deepEqual(off.diagnostics, []);
});

test('missing and resized files fail integrity checks', async () => {
  const files = await projectToFiles(sampleProject());
  const missing = new Map(files);
  missing.delete('assets/textures/noise.bin');
  await assert.rejects(filesToProject(missing), /missing/);

  const resized = new Map(files);
  resized.set('assets/textures/noise.bin', random(10));
  await assert.rejects(filesToProject(resized), /10 bytes/);
});

test('an archive that is not a MekDeck project is rejected clearly', async () => {
  const plain = await writeZip([{ path: 'readme.txt', data: utf8('just a zip') }]);
  await assert.rejects(unpackProject(plain), code('E_NOT_MEKDECK'));

  const wrong = await writeZip([{ path: MANIFEST_PATH, data: utf8('{"format":"something-else"}') }]);
  await assert.rejects(unpackProject(wrong), code('E_NOT_MEKDECK'));

  const notJson = await writeZip([{ path: MANIFEST_PATH, data: utf8('not json') }]);
  await assert.rejects(unpackProject(notJson), code('E_NOT_MEKDECK'));
});

test('a file from a newer MekDeck is refused with an upgrade message, never half-read', async () => {
  const files = await projectToFiles(sampleProject());
  const manifest = JSON.parse(text(files.get(MANIFEST_PATH)!));
  manifest.formatVersion = 2;
  const next = new Map(files);
  next.set(MANIFEST_PATH, utf8(JSON.stringify(manifest)));
  await assert.rejects(filesToProject(next), (e: unknown) => e instanceof MekdeckError && e.code === 'E_FORMAT_TOO_NEW' && /Update MekDeck/.test(e.message));
});

test('a wrong mimetype is rejected', async () => {
  const files = await projectToFiles(sampleProject());
  const zip = await writeZip([{ path: 'mimetype', data: utf8('application/other'), method: 'store' }, ...[...files].map(([path, data]) => ({ path, data }))]);
  await assert.rejects(unpackProject(zip), code('E_BAD_MIMETYPE'));
});

test('malformed graph files are reported with their path', async () => {
  const files = await projectToFiles(sampleProject());
  const broken = new Map(files);
  broken.set('graphs/main.graph.json', utf8('{"id":"main","name":"x","nodes":[],"edges":{}}'));
  // Keep the manifest honest so we reach graph parsing rather than the integrity check.
  await assert.rejects(filesToProject(broken, { verify: 'off' }), (e: unknown) => e instanceof MekdeckError && e.code === 'E_FORMAT_INVALID' && /graphs\/main\.graph\.json/.test(e.message));

  const mismatch = new Map(files);
  mismatch.set('graphs/other.graph.json', files.get('graphs/main.graph.json')!);
  await assert.rejects(filesToProject(mismatch, { verify: 'off' }), /does not match the file name/);
});

test('unknown files are preserved; unlisted ones warn; OS junk is ignored', async () => {
  const files = new Map(await projectToFiles(sampleProject()));
  files.set('extras/note.txt', utf8('added by another tool'));
  files.set('__MACOSX/._main.graph.json', utf8('junk'));
  files.set('assets/.DS_Store', utf8('junk'));
  const { project, diagnostics } = await filesToProject(files);

  assert.equal(text(project.unknown['timelines/main.json']!), '{"tracks":[]}\n');
  assert.equal(text(project.unknown['extras/note.txt']!), 'added by another tool');
  assert.ok(diagnostics.some((d) => d.code === 'unlisted-file' && d.path === 'extras/note.txt'));
  assert.ok(!('__MACOSX/._main.graph.json' in project.unknown));
  assert.ok(!('.DS_Store' in project.assets));
});

test('files in MekDeck-owned folders cannot be smuggled in as "unknown"', async () => {
  const project = sampleProject();
  project.unknown['graphs/sneaky.json'] = utf8('{}');
  await assert.rejects(packProject(project), code('E_PATH_RESERVED'));
});

test('invalid projects are refused when packing', async () => {
  const noEntry = sampleProject();
  noEntry.meta.entryGraph = 'ghost';
  await assert.rejects(packProject(noEntry), code('E_FORMAT_INVALID'));

  const wrongId = sampleProject();
  wrongId.graphs.renamed = wrongId.graphs.main!;
  await assert.rejects(packProject(wrongId), /must match/);

  const badName = sampleProject();
  badName.meta.name = '';
  await assert.rejects(packProject(badName), code('E_FORMAT_INVALID'));

  const badAsset = sampleProject();
  badAsset.assets['../escape.bin'] = random(4);
  await assert.rejects(packProject(badAsset), code('E_PATH_UNSAFE'));
});

test('a missing entry graph is a diagnostic when reading, not a crash', async () => {
  const files = new Map(await projectToFiles(sampleProject()));
  files.delete('graphs/main.graph.json');
  const { diagnostics } = await filesToProject(files, { verify: 'warn' });
  assert.ok(diagnostics.some((d) => d.code === 'missing-entry-graph'));
});

test('export bundle: same project plus generated code, importable like a .mekd', async () => {
  const project = sampleProject();
  const bundle = await packProject(project, {
    profile: 'bundle',
    generated: [
      { path: 'three/src/main.js', content: 'console.log("hi");\n' },
      { path: 'three/package.json', content: '{}\n' },
    ],
  });
  const { project: back, profile, diagnostics } = await unpackProject(bundle);
  assert.equal(profile, 'bundle');
  assert.deepEqual(diagnostics, []);
  same(back, project);

  assert.ok(!Object.keys(back.unknown).some((p) => p.startsWith('generated/')), 'generated code is derived, never imported');
  const names = (await (await import('../src/index.ts')).openZip(bundle)).entries.map((e) => e.path);
  assert.ok(names.includes('generated/three/src/main.js'));
  assert.ok(!names.includes('mimetype'));
});

test('a .mekd cannot carry generated code', async () => {
  await assert.rejects(packProject(sampleProject(), { generated: [{ path: 'x.js', content: '' }] }), code('E_PACK_OPTIONS'));
});

test('decoding enforces archive limits', async () => {
  const bytes = await packProject(sampleProject());
  await assert.rejects(unpackProject(bytes, { limits: { maxEntries: 2, maxEntryBytes: 1e9, maxTotalBytes: 1e9 } }), code('E_ZIP_LIMIT'));
});

test('large projects round-trip (many assets, binary and text)', async () => {
  const project = sampleProject();
  for (let i = 0; i < 300; i++) project.assets[`bulk/file${String(i).padStart(3, '0')}.bin`] = random(1000 + i);
  project.assets['big/zeros.bin'] = new Uint8Array(3_000_000);
  const bytes = await packProject(project);
  assert.ok(bytes.length < 1_500_000, 'zeros compress');
  same((await unpackProject(bytes)).project, project);
});
