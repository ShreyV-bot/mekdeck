import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MekdeckError } from '@mekdeck/core';
import { crc32, DEFAULT_ZIP_LIMITS, openZip, sha256Hex, writeZip, type ZipFileInput } from '../src/index.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const code = (expected: string) => (e: unknown) => e instanceof MekdeckError && e.code === expected;
const random = (n: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
};
const have = (cmd: string) => spawnSync(cmd, ['-v'], { stdio: 'ignore' }).error === undefined;
const tmp = () => mkdtempSync(join(tmpdir(), 'mekdeck-test-'));

/** Replace every occurrence of `from` with equally long `to`. */
function patchBytes(bytes: Uint8Array, from: string, to: string): Uint8Array {
  assert.equal(from.length, to.length);
  const a = utf8(from);
  const b = utf8(to);
  const out = bytes.slice();
  let hits = 0;
  for (let i = 0; i + a.length <= out.length; i++) {
    if (a.every((byte, k) => out[i + k] === byte)) {
      out.set(b, i);
      hits++;
    }
  }
  assert.ok(hits >= 2, 'name should appear in the local and the central header');
  return out;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const centralOffset = (b: Uint8Array) => view(b).getUint32(b.length - 22 + 16, true);

test('known-answer checks for CRC-32 and SHA-256', async () => {
  assert.equal(crc32(utf8('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(await sha256Hex(utf8('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('write then read round-trips text, binary, empty and unicode-named files', async () => {
  const files: ZipFileInput[] = [
    { path: 'a.txt', data: utf8('hello') },
    { path: 'dir/deep/b.json', data: utf8(JSON.stringify({ n: 'x'.repeat(5000) })) },
    { path: 'empty.bin', data: new Uint8Array(0) },
    { path: 'rand.bin', data: random(20_000) },
    { path: 'ünïcødé/文件.txt', data: utf8('✓ unicode') },
    { path: 'big.txt', data: utf8('lorem ipsum '.repeat(50_000)) },
  ];
  const zip = await writeZip(files);
  const archive = openZip(zip);
  assert.deepEqual(archive.entries.map((e) => e.path), files.map((f) => f.path));
  for (const file of files) assert.deepEqual(await archive.read(file.path), file.data, file.path);
  assert.ok(zip.length < 200_000, 'repetitive data should have been compressed');
});

test('compression method selection: store for tiny/incompressible/forced, deflate for compressible', async () => {
  const zip = await writeZip([
    { path: 'tiny.txt', data: utf8('hi') },
    { path: 'pic.png', data: utf8('x'.repeat(5000)) },
    { path: 'forced.txt', data: utf8('x'.repeat(5000)), method: 'store' },
    { path: 'text.txt', data: utf8('x'.repeat(5000)) },
    { path: 'noise.dat', data: random(5000) },
  ]);
  const method = Object.fromEntries(openZip(zip).entries.map((e) => [e.path, e.method]));
  assert.deepEqual(method, { 'tiny.txt': 0, 'pic.png': 0, 'forced.txt': 0, 'text.txt': 8, 'noise.dat': 0 });
});

test('output is deterministic', async () => {
  const files = [{ path: 'a.txt', data: utf8('same '.repeat(100)) }, { path: 'b.bin', data: random(300) }];
  assert.deepEqual(await writeZip(files), await writeZip(files));
});

test('unsafe or colliding paths are refused when writing', async () => {
  const bad = ['../x', '/abs', 'a\\b', 'C:file', 'con.txt', 'dir/NUL', 'trail.', 'sp ace ', '', 'a//b', 'a/./b', 'a/../b', 'dir/', 'q?.txt', 'nul\u0000.txt', 'é.txt'];
  for (const path of bad) {
    await assert.rejects(writeZip([{ path, data: utf8('x') }]), code('E_PATH_UNSAFE'), JSON.stringify(path));
  }
  await assert.rejects(writeZip([{ path: 'A.txt', data: utf8('1') }, { path: 'a.txt', data: utf8('2') }]), code('E_PATH_COLLISION'));
  await assert.rejects(writeZip([{ path: 'a.txt', data: utf8('1') }, { path: 'a.txt', data: utf8('2') }]), code('E_PATH_COLLISION'));
});

test('a hostile archive naming "../../a.txt" is rejected on open (zip-slip)', async () => {
  const zip = await writeZip([{ path: 'abc/def.txt', data: utf8('pwned') }]);
  assert.throws(() => openZip(patchBytes(zip, 'abc/def.txt', '../../a.txt')), code('E_PATH_UNSAFE'));
  assert.throws(() => openZip(patchBytes(zip, 'abc/def.txt', '/etc/a.txt!')), code('E_PATH_UNSAFE'));
});

test('a damaged byte is caught by the CRC', async () => {
  const zip = await writeZip([{ path: 'a.txt', data: utf8('hello world, hello world'), method: 'store' }]);
  const damaged = zip.slice();
  const at = damaged.findIndex((_, i) => text(damaged.subarray(i, i + 5)) === 'hello');
  damaged[at] = 'J'.charCodeAt(0);
  await assert.rejects(openZip(damaged).read('a.txt'), code('E_ZIP_CRC'));
});

test('an entry that inflates past its declared size is a zip bomb and is stopped', async () => {
  const zip = (await writeZip([{ path: 'zeros.bin', data: new Uint8Array(1_000_000) }])).slice();
  assert.equal(openZip(zip).entries[0]!.method, 8);
  // Lie: claim the file is only 1000 bytes (local header offset 22, central header offset 24).
  view(zip).setUint32(22, 1000, true);
  view(zip).setUint32(centralOffset(zip) + 24, 1000, true);
  await assert.rejects(openZip(zip).read('zeros.bin'), code('E_ZIP_BOMB'));
});

test('an impossible compression ratio is rejected before any inflating', async () => {
  const zip = (await writeZip([{ path: 'zeros.bin', data: new Uint8Array(100_000) }])).slice();
  view(zip).setUint32(centralOffset(zip) + 24, 0x7fffffff, true);
  assert.throws(() => openZip(zip), code('E_ZIP_BOMB'));
});

test('size and entry-count limits are enforced', async () => {
  const zip = await writeZip([
    { path: 'a.bin', data: random(1000) },
    { path: 'b.bin', data: random(1000) },
  ]);
  assert.throws(() => openZip(zip, { ...DEFAULT_ZIP_LIMITS, maxEntries: 1 }), code('E_ZIP_LIMIT'));
  assert.throws(() => openZip(zip, { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 500 }), code('E_ZIP_LIMIT'));
  assert.throws(() => openZip(zip, { ...DEFAULT_ZIP_LIMITS, maxTotalBytes: 1500 }), code('E_ZIP_LIMIT'));
});

test('unsupported features fail clearly instead of being misread', async () => {
  const zip = await writeZip([{ path: 'a.txt', data: utf8('x'.repeat(100)) }]);
  const cd = centralOffset(zip);

  const encrypted = zip.slice();
  view(encrypted).setUint16(cd + 8, view(encrypted).getUint16(cd + 8, true) | 1, true);
  assert.throws(() => openZip(encrypted), code('E_ZIP_UNSUPPORTED'));

  const zip64 = zip.slice();
  view(zip64).setUint32(cd + 20, 0xffffffff, true);
  assert.throws(() => openZip(zip64), code('E_ZIP_UNSUPPORTED'));

  const exotic = zip.slice();
  view(exotic).setUint16(cd + 10, 12, true); // bzip2
  assert.throws(() => openZip(exotic), code('E_ZIP_UNSUPPORTED'));
});

test('truncated, garbage and empty inputs are rejected with E_ZIP_CORRUPT', async () => {
  const zip = await writeZip([{ path: 'a.txt', data: utf8('hello'.repeat(50)) }]);
  assert.throws(() => openZip(zip.subarray(0, zip.length - 10)), code('E_ZIP_CORRUPT'));
  assert.throws(() => openZip(zip.subarray(0, 40)), code('E_ZIP_CORRUPT'));
  assert.throws(() => openZip(random(500)), code('E_ZIP_CORRUPT'));
  assert.throws(() => openZip(new Uint8Array(0)), code('E_ZIP_CORRUPT'));
});

test('corrupt deflate data is reported, not thrown as a raw stream error', async () => {
  const zip = (await writeZip([{ path: 'a.txt', data: utf8('compress me '.repeat(500)) }])).slice();
  const entry = openZip(zip).entries[0]!;
  assert.equal(entry.method, 8);
  for (let i = 40; i < 60; i++) zip[i] = 0xff; // trash the start of the compressed stream
  await assert.rejects(openZip(zip).read('a.txt'), (e: unknown) => e instanceof MekdeckError && (e.code === 'E_ZIP_CORRUPT' || e.code === 'E_ZIP_CRC' || e.code === 'E_ZIP_BOMB'));
});

test('reading a missing entry is a clear error', async () => {
  const archive = openZip(await writeZip([{ path: 'a.txt', data: utf8('x') }]));
  await assert.rejects(archive.read('nope.txt'), code('E_ZIP_ENTRY_MISSING'));
});

test('our archives pass `unzip -t` and extract byte-for-byte (interop)', { skip: !have('unzip') }, async () => {
  const dir = tmp();
  try {
    const files: ZipFileInput[] = [
      { path: 'mimetype', data: utf8('application/test'), method: 'store' },
      { path: 'sub/dir/text.txt', data: utf8('lorem ipsum '.repeat(10_000)) },
      { path: 'bin.dat', data: random(30_000) },
      { path: 'unicode/日本語.txt', data: utf8('ok') },
    ];
    const zipPath = join(dir, 'ours.zip');
    writeFileSync(zipPath, await writeZip(files));
    const test_ = spawnSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
    assert.equal(test_.status, 0, test_.stdout + test_.stderr);
    for (const file of files.filter((f) => !f.path.includes('日本語'))) {
      const out = spawnSync('unzip', ['-p', zipPath, file.path]);
      assert.equal(out.status, 0, file.path);
      assert.deepEqual(new Uint8Array(out.stdout), file.data, file.path);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('we read archives made by Info-ZIP, including streamed ones with data descriptors (interop)', { skip: !have('zip') }, async () => {
  const dir = tmp();
  try {
    const src = join(dir, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    const expected: Record<string, Uint8Array> = {
      'a.txt': utf8('hello zip'),
      'sub/b.txt': utf8('lorem ipsum '.repeat(20_000)),
      'bin.dat': random(8_000),
    };
    for (const [path, data] of Object.entries(expected)) writeFileSync(join(src, path), data);

    const fileZip = join(dir, 'file.zip');
    const streamZip = join(dir, 'stream.zip');
    assert.equal(spawnSync('zip', ['-q', '-r', '-X', fileZip, '.'], { cwd: src }).status, 0);
    assert.equal(spawnSync('sh', ['-c', `cd "${src}" && zip -q -r -X - . > "${streamZip}"`]).status, 0);

    for (const zipPath of [fileZip, streamZip]) {
      const archive = openZip(new Uint8Array(readFileSync(zipPath)));
      assert.deepEqual(archive.entries.map((e) => e.path).sort(), Object.keys(expected).sort(), zipPath);
      for (const [path, data] of Object.entries(expected)) assert.deepEqual(await archive.read(path), data, `${zipPath}: ${path}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
