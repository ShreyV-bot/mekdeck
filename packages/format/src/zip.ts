import { MekdeckError } from '@mekdeck/core';
import { crc32 } from './crc32.ts';
import { assertNoCollisions, assertSafePath } from './path.ts';

/**
 * A small, strict ZIP implementation with no dependencies (Web Streams only), so the same
 * code runs in Node, the browser and Electron.
 *
 * Writing is deterministic: fixed timestamps and permissions, caller-controlled order.
 * Reading treats the archive as hostile: paths are validated (zip-slip), declared sizes are
 * enforced while inflating (zip bombs), CRCs are checked, and unsupported features
 * (encryption, ZIP64, multi-disk) are refused with a clear error rather than misread.
 */

export interface ZipFileInput {
  readonly path: string;
  readonly data: Uint8Array;
  /** `auto` deflates compressible data and stores everything else. */
  readonly method?: 'auto' | 'store' | 'deflate';
}

export interface ZipLimits {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 50_000,
  maxEntryBytes: 1024 ** 3,
  maxTotalBytes: 2 * 1024 ** 3,
};

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const MAX32 = 0xffffffff;
// 1980-01-01 00:00:00, the earliest DOS timestamp: keeps output reproducible.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UNIX_FILE_644 = ((0o100644 << 16) >>> 0);
/** Deflate cannot compress better than about 1032:1, so a bigger claim is a lie. */
const MAX_DEFLATE_RATIO = 1040;
const INCOMPRESSIBLE = /\.(png|jpe?g|webp|avif|gif|mp3|mp4|m4a|ogg|opus|webm|mkv|mov|zip|gz|br|zst|7z|woff2?)$/i;

function corrupt(message: string, cause?: unknown): MekdeckError {
  return new MekdeckError('E_ZIP_CORRUPT', `Invalid ZIP archive: ${message}`, undefined, cause ? { cause } : undefined);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function deflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const writing = writer.write(input as BufferSource).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await writing;
  return concat(chunks, total);
}

/** Inflate raw deflate data, refusing to produce more than `expected` bytes. */
async function inflateRaw(input: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  // If we stop reading early the writer may reject; that is expected, not an unhandled error.
  const writing = writer.write(input as BufferSource).then(() => writer.close()).catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > expected) {
        throw new MekdeckError('E_ZIP_BOMB', 'An entry expands to more than its declared size; refusing to continue');
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof MekdeckError) throw error;
    throw corrupt('compressed data is damaged', error);
  }
  await writing;
  if (total !== expected) throw corrupt(`an entry inflated to ${total} bytes but declares ${expected}`);
  return concat(chunks, total);
}

/** Build a ZIP archive. Entries are written in the order given. */
export async function writeZip(files: readonly ZipFileInput[]): Promise<Uint8Array> {
  if (files.length > 0xfffe) throw new MekdeckError('E_ZIP_TOO_LARGE', 'Too many files for a ZIP archive (ZIP64 is not supported yet)');
  for (const file of files) assertSafePath(file.path);
  assertNoCollisions(files.map((f) => f.path));

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.path);
    const crc = crc32(file.data);
    const mode = file.method ?? 'auto';
    let method = 0;
    let body = file.data;
    if (mode === 'deflate' || (mode === 'auto' && file.data.length >= 64 && !INCOMPRESSIBLE.test(file.path))) {
      const packed = await deflateRaw(file.data);
      if (packed.length < file.data.length) {
        method = 8;
        body = packed;
      }
    }
    if (file.data.length > MAX32 || body.length > MAX32) {
      throw new MekdeckError('E_ZIP_TOO_LARGE', `"${file.path}" is too large for a ZIP archive (ZIP64 is not supported yet)`);
    }

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, file.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, (3 << 8) | 20, true); // made by: UNIX, spec 2.0
    cv.setUint16(6, 20, true);
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, file.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, UNIX_FILE_644, true);
    cv.setUint32(42, offset, true);
    entry.set(name, 46);

    parts.push(local, body);
    central.push(entry);
    offset += local.length + body.length;
    if (offset > MAX32) throw new MekdeckError('E_ZIP_TOO_LARGE', 'Archive exceeds 4 GiB (ZIP64 is not supported yet)');
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, end];
  return concat(all, all.reduce((n, p) => n + p.length, 0));
}

export interface ZipEntry {
  readonly path: string;
  /** Uncompressed size in bytes. */
  readonly size: number;
  readonly compressedSize: number;
  /** 0 = stored, 8 = deflate. */
  readonly method: number;
  readonly crc32: number;
  readonly offset: number;
}

/** An opened archive: the directory is parsed and validated, entries are decompressed on demand. */
export class ZipArchive {
  readonly entries: readonly ZipEntry[];
  readonly #bytes: Uint8Array;
  readonly #byPath: Map<string, ZipEntry>;
  readonly #cdOffset: number;

  constructor(bytes: Uint8Array, entries: readonly ZipEntry[], cdOffset: number) {
    this.#bytes = bytes;
    this.entries = entries;
    this.#cdOffset = cdOffset;
    this.#byPath = new Map(entries.map((e) => [e.path, e]));
  }

  has(path: string): boolean {
    return this.#byPath.has(path);
  }

  async read(path: string): Promise<Uint8Array> {
    const entry = this.#byPath.get(path);
    if (!entry) throw new MekdeckError('E_ZIP_ENTRY_MISSING', `The archive has no file "${path}"`);

    const bytes = this.#bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = entry.offset;
    if (at + 30 > this.#cdOffset || view.getUint32(at, true) !== SIG_LOCAL) throw corrupt(`bad header for "${path}"`);
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const end = start + entry.compressedSize;
    if (end > this.#cdOffset) throw corrupt(`data of "${path}" runs past the end of the archive`);

    const raw = bytes.subarray(start, end);
    const data = entry.method === 0 ? raw.slice() : await inflateRaw(raw, entry.size);
    if (data.length !== entry.size) throw corrupt(`size mismatch for "${path}"`);
    if (crc32(data) !== entry.crc32) {
      throw new MekdeckError('E_ZIP_CRC', `Checksum mismatch in "${path}": the file is damaged`);
    }
    return data;
  }

  /** Read several entries (default: all) into a map. */
  async readAll(paths: Iterable<string> = this.entries.map((e) => e.path)): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    for (const path of paths) out.set(path, await this.read(path));
    return out;
  }
}

/** Parse and validate a ZIP's directory. Throws on anything malformed, unsafe or unsupported. */
export function openZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipArchive {
  if (bytes.length < 22) throw corrupt('the file is too small to be a ZIP archive');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === SIG_EOCD && i + 22 + view.getUint16(i + 20, true) === bytes.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw corrupt('no end-of-archive record (not a ZIP file, or it is truncated)');

  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === MAX32 || cdOffset === MAX32) {
    throw new MekdeckError('E_ZIP_UNSUPPORTED', 'ZIP64 archives are not supported yet');
  }
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0 || view.getUint16(eocd + 8, true) !== total) {
    throw new MekdeckError('E_ZIP_UNSUPPORTED', 'Multi-disk archives are not supported');
  }
  if (cdOffset + cdSize > eocd) throw corrupt('the central directory is out of bounds');
  if (total > limits.maxEntries) {
    throw new MekdeckError('E_ZIP_LIMIT', `The archive has ${total} entries; the limit is ${limits.maxEntries}`);
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: ZipEntry[] = [];
  let pos = cdOffset;
  let sum = 0;
  for (let i = 0; i < total; i++) {
    if (pos + 46 > eocd || view.getUint32(pos, true) !== SIG_CENTRAL) throw corrupt('the central directory is damaged');
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const offset = view.getUint32(pos + 42, true);
    const next = pos + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) throw corrupt('the central directory is damaged');

    let name: string;
    try {
      name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    } catch (error) {
      throw corrupt('a file name is not valid UTF-8', error);
    }
    pos = next;

    if (name.endsWith('/')) {
      if (size !== 0) throw corrupt(`folder entry "${name}" has data`);
      continue; // folders carry no information we need
    }
    if (compressedSize === MAX32 || size === MAX32 || offset === MAX32) {
      throw new MekdeckError('E_ZIP_UNSUPPORTED', 'ZIP64 entries are not supported yet');
    }
    if (flags & FLAG_ENCRYPTED) throw new MekdeckError('E_ZIP_UNSUPPORTED', `"${name}" is encrypted; encrypted archives are not supported`);
    if (method !== 0 && method !== 8) throw new MekdeckError('E_ZIP_UNSUPPORTED', `"${name}" uses compression method ${method}; only stored and deflate are supported`);
    if (method === 0 && compressedSize !== size) throw corrupt(`stored entry "${name}" has inconsistent sizes`);
    if (method === 8 && size > compressedSize * MAX_DEFLATE_RATIO + 1024) throw new MekdeckError('E_ZIP_BOMB', `"${name}" declares an impossible compression ratio`);
    if (size > limits.maxEntryBytes) throw new MekdeckError('E_ZIP_LIMIT', `"${name}" is ${size} bytes; the per-file limit is ${limits.maxEntryBytes}`);
    sum += size;
    if (sum > limits.maxTotalBytes) throw new MekdeckError('E_ZIP_LIMIT', `The archive expands to more than ${limits.maxTotalBytes} bytes`);

    assertSafePath(name);
    entries.push({ path: name, size, compressedSize, method, crc32: crc, offset });
  }
  assertNoCollisions(entries.map((e) => e.path));
  return new ZipArchive(bytes, entries, cdOffset);
}
