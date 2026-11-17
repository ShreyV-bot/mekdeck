import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProject, openZip, packProject, projectToFiles, unpackProject, writeZip } from '@mekdeck/format';
import { run, type CliIo } from '../src/cli.ts';
import { VERSION } from '../src/version.ts';

const NOW = '2026-01-01T00:00:00.000Z';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'mekdeck-cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (t) => out.push(t), err: (t) => err.push(t), cwd: dir, now: () => NOW };
  return {
    dir,
    path: (...p: string[]) => join(dir, ...p),
    io,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    clear: () => (out.length = err.length = 0),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function withSandbox(fn: (s: ReturnType<typeof sandbox>) => Promise<void>): Promise<void> {
  const s = sandbox();
  try {
    await fn(s);
  } finally {
    s.cleanup();
  }
}

const cli = (s: ReturnType<typeof sandbox>, ...args: string[]) => run(args, s.io);

test('new, validate, inspect: a fresh project is valid', () =>
  withSandbox(async (s) => {
    assert.equal(await cli(s, 'new', 'demo', '--name', 'Demo Project'), 0);
    assert.ok(existsSync(s.path('demo', 'mekdeck.json')));
    assert.ok(existsSync(s.path('demo', 'graphs', 'main.graph.json')));
    s.clear();

    assert.equal(await cli(s, 'validate', 'demo'), 0, s.stdout() + s.stderr());
    assert.match(s.stdout(), /OK\s+Demo Project: 1 graph\(s\)/);
    s.clear();

    assert.equal(await cli(s, 'inspect', 'demo'), 0);
    for (const expected of ['Demo Project', 'project folder', 'Entry graph: main', 'main', '"Main scene"', 'nodes,']) {
      assert.ok(s.stdout().includes(expected), `inspect output should mention ${expected}\n${s.stdout()}`);
    }
  }));

test('new refuses to write into an existing folder unless forced', () =>
  withSandbox(async (s) => {
    assert.equal(await cli(s, 'new', 'demo'), 0);
    s.clear();
    assert.equal(await cli(s, 'new', 'demo'), 1);
    assert.match(s.stderr(), /already exists.*--force.*E_OUTPUT_EXISTS/);
    assert.equal(await cli(s, 'new', 'demo', '--force'), 0);
  }));

test('pack produces a .mekd that unpacks back to an identical folder (deterministic)', () =>
  withSandbox(async (s) => {
    await cli(s, 'new', 'demo');
    assert.equal(await cli(s, 'pack', 'demo', '-o', 'one.mekd'), 0, s.stderr());

    const bytes = readFileSync(s.path('one.mekd'));
    assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    assert.equal(bytes.subarray(30, 38).toString(), 'mimetype');

    assert.equal(await cli(s, 'unpack', 'one.mekd', '-o', 'again'), 0, s.stderr());
    assert.equal(await cli(s, 'pack', 'again', '-o', 'two.mekd'), 0, s.stderr());
    assert.deepEqual(readFileSync(s.path('two.mekd')), bytes, 'pack -> unpack -> pack must be byte-identical');

    assert.equal(await cli(s, 'pack', 'demo', '-o', 'one.mekd'), 1, 'existing output is not overwritten');
    assert.equal(await cli(s, 'pack', 'demo', '-o', 'one.mekd', '--force'), 0);
  }));

test('eval prints the evaluated Scene IR', () =>
  withSandbox(async (s) => {
    await cli(s, 'new', 'demo');
    s.clear();
    assert.equal(await cli(s, 'eval', 'demo'), 0, s.stderr());
    const scene = JSON.parse(s.stdout());
    assert.equal(scene.objects.length, 5);
    assert.equal(scene.camera.name, 'Camera');
    assert.equal(scene.version, 1);
  }));

test('a project folder is a working copy: edit a graph by hand, pack, and the change is live', () =>
  withSandbox(async (s) => {
    await cli(s, 'new', 'demo');
    const file = s.path('demo', 'graphs', 'main.graph.json');
    const graph = JSON.parse(readFileSync(file, 'utf8'));
    graph.nodes.height.values.value = 4; // cube height 4 -> lifted by 2
    writeFileSync(file, JSON.stringify(graph, null, 2));

    assert.equal(await cli(s, 'validate', 'demo'), 0, 'stale manifest hashes do not matter for a folder');
    assert.equal(await cli(s, 'pack', 'demo', '-o', 'edited.mekd'), 0, s.stderr());
    s.clear();
    assert.equal(await cli(s, 'eval', 'edited.mekd'), 0, s.stderr());
    const cube = JSON.parse(s.stdout()).objects.find((o: { name: string }) => o.name === 'Cube');
    assert.deepEqual(cube.transform.position, [0, 2, 0]);
  }));

test('validate reports graph problems and fails on errors', () =>
  withSandbox(async (s) => {
    await cli(s, 'new', 'demo');
    const file = s.path('demo', 'graphs', 'main.graph.json');
    const graph = JSON.parse(readFileSync(file, 'utf8'));
    graph.nodes.mystery = { id: 'mystery', type: 'plugin.missing', position: { x: 0, y: 0 }, values: {}, params: {} };
    graph.nodes.height.params = { bogus: 1 };
    writeFileSync(file, JSON.stringify(graph));
    s.clear();

    assert.equal(await cli(s, 'validate', 'demo'), 1);
    assert.match(s.stdout(), /error\s+graphs\/main\.graph\.json \[mystery\] unknown-node-type/);
    assert.match(s.stdout(), /warning\s+graphs\/main\.graph\.json \[height\] unknown-param/);
    assert.match(s.stdout(), /1 error\(s\), 1 warning\(s\)/);
  }));

test('a modified .mekd fails validation with an integrity error', () =>
  withSandbox(async (s) => {
    const project = createProject('Tamper', NOW);
    project.scripts['a.txt'] = 'original';
    const files = await projectToFiles(project);
    files.set('scripts/a.txt', new TextEncoder().encode('changed!'));
    writeFileSync(s.path('bad.mekd'), await writeZip([{ path: 'mimetype', data: new TextEncoder().encode('application/vnd.mekdeck.project+zip'), method: 'store' }, ...[...files].map(([path, data]) => ({ path, data }))]));

    assert.equal(await cli(s, 'validate', 'bad.mekd'), 1);
    assert.match(s.stderr(), /scripts\/a\.txt.*E_INTEGRITY/);
  }));

test('codegen writes a runnable three.js project', () =>
  withSandbox(async (s) => {
    await cli(s, 'new', 'demo', '--name', 'Demo');
    assert.equal(await cli(s, 'codegen', 'demo', '--target', 'three', '-o', 'site'), 0, s.stderr());
    for (const f of ['package.json', 'index.html', 'src/main.js']) assert.ok(existsSync(s.path('site', f)), f);
    const check = spawnSync(process.execPath, ['--check', s.path('site', 'src', 'main.js')]);
    // .js without a package.json "type" is parsed as CommonJS, so ESM syntax needs the .mjs copy.
    writeFileSync(s.path('main.mjs'), readFileSync(s.path('site', 'src', 'main.js')));
    const esm = spawnSync(process.execPath, ['--check', s.path('main.mjs')], { encoding: 'utf8' });
    assert.equal(esm.status, 0, esm.stderr);
    void check;
  }));

test('export -> import -> unpack: the zip bundle round-trips and carries generated code', () =>
  withSandbox(async (s) => {
    await cli(s, 'new', 'demo', '--name', 'Demo');
    assert.equal(await cli(s, 'pack', 'demo', '-o', 'demo.mekd'), 0);
    assert.equal(await cli(s, 'export', 'demo.mekd', '--target', 'three', '-o', 'demo.zip'), 0, s.stderr());

    const zipBytes = new Uint8Array(readFileSync(s.path('demo.zip')));
    const names = openZip(zipBytes).entries.map((e) => e.path);
    assert.ok(names.includes('generated/three/src/main.js'));
    assert.ok(names.includes('mekdeck.json'));
    assert.ok(!names.includes('mimetype'));

    assert.equal(await cli(s, 'import', 'demo.zip', '-o', 'imported.mekd'), 0, s.stderr());
    assert.deepEqual(readFileSync(s.path('imported.mekd')), readFileSync(s.path('demo.mekd')), 'import yields exactly the original .mekd');

    const { profile } = await unpackProject(zipBytes);
    assert.equal(profile, 'bundle');

    s.clear();
    assert.equal(await cli(s, 'inspect', 'demo.zip'), 0);
    assert.match(s.stdout(), /export bundle/);
  }));

test('usage errors exit 2 with guidance; help and version exit 0', () =>
  withSandbox(async (s) => {
    assert.equal(await cli(s), 0);
    assert.match(s.stdout(), /Usage: mekdeck <command>/);
    s.clear();
    assert.equal(await cli(s, '--version'), 0);
    assert.equal(s.stdout().trim(), VERSION);
    s.clear();

    assert.equal(await cli(s, 'frobnicate'), 2);
    assert.match(s.stderr(), /unknown command "frobnicate"/);
    s.clear();
    assert.equal(await cli(s, 'pack'), 2);
    assert.match(s.stderr(), /Usage: mekdeck pack/);
    s.clear();
    assert.equal(await cli(s, 'new', 'x', '--bogus'), 2);
    assert.match(s.stderr(), /bogus/);
    s.clear();
    assert.equal(await cli(s, 'eval', 'x', '--time', 'soon'), 2);
    s.clear();
    assert.equal(await cli(s, 'toString'), 2, 'prototype names are not commands');
    assert.equal(await cli(s, 'pack', '--help'), 0);
  }));

test('missing inputs and bad targets are clear failures, not crashes', () =>
  withSandbox(async (s) => {
    assert.equal(await cli(s, 'validate', 'nope.mekd'), 1);
    assert.match(s.stderr(), /Cannot find "nope\.mekd".*E_NOT_FOUND/);
    s.clear();

    await cli(s, 'new', 'demo');
    s.clear();
    assert.equal(await cli(s, 'codegen', 'demo', '--target', 'unreal', '-o', 'out'), 1);
    assert.match(s.stderr(), /Available targets: three.*E_TARGET_UNSUPPORTED/);
    s.clear();
    assert.equal(await cli(s, 'eval', 'demo', '--graph', 'ghost'), 1);
    assert.match(s.stderr(), /no graph "ghost"/);

    writeFileSync(s.path('junk.zip'), 'this is not a zip');
    s.clear();
    assert.equal(await cli(s, 'inspect', 'junk.zip'), 1);
    assert.match(s.stderr(), /E_ZIP_CORRUPT/);
  }));

test('a hostile zip with ../ paths is refused and nothing is written outside the target', () =>
  withSandbox(async (s) => {
    const zip = (await writeZip([{ path: 'abc/def.txt', data: new TextEncoder().encode('pwned') }])).slice();
    const swap = (from: string, to: string) => {
      const a = new TextEncoder().encode(from);
      const b = new TextEncoder().encode(to);
      for (let i = 0; i + a.length <= zip.length; i++) if (a.every((x, k) => zip[i + k] === x)) zip.set(b, i);
    };
    swap('abc/def.txt', '../../a.txt');
    writeFileSync(s.path('evil.zip'), zip);

    assert.equal(await cli(s, 'unpack', 'evil.zip', '-o', 'out'), 1);
    assert.match(s.stderr(), /Unsafe file path.*E_PATH_UNSAFE/);
    assert.ok(!existsSync(s.path('out')));
    assert.ok(!existsSync(join(s.dir, '..', 'a.txt')));
  }));

test('project folders cannot smuggle in symlinks', { skip: process.platform === 'win32' }, () =>
  withSandbox(async (s) => {
    await cli(s, 'new', 'demo');
    mkdirSync(s.path('outside'));
    symlinkSync(s.path('outside'), s.path('demo', 'assets-link'));
    s.clear();
    assert.equal(await cli(s, 'pack', 'demo', '-o', 'x.mekd'), 1);
    assert.match(s.stderr(), /symbolic link.*E_SYMLINK/);
  }));

test('version.ts matches package.json', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.equal(pkg.version, VERSION);
});

test('the real binary runs end to end (shebang, ESM, type stripping)', () => {
  const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'mekdeck-bin-'));
  try {
    const version = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), VERSION);

    const made = spawnSync(process.execPath, [bin, 'new', 'p'], { cwd: dir, encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const packed = spawnSync(process.execPath, [bin, 'pack', 'p'], { cwd: dir, encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    assert.ok(existsSync(join(dir, 'p.mekd')));

    const bad = spawnSync(process.execPath, [bin, 'nonsense'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a project can be built entirely through the API and opened by the CLI', () =>
  withSandbox(async (s) => {
    const project = createProject('From API', NOW);
    project.scripts['x.txt'] = 'hi';
    writeFileSync(s.path('api.mekd'), await packProject(project));
    assert.equal(await cli(s, 'validate', 'api.mekd'), 0, s.stdout() + s.stderr());
    assert.equal(await cli(s, 'eval', 'api.mekd'), 2, 'no graphs: asks the user to choose rather than guessing');
  }));
