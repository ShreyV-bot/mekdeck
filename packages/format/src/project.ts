import {
  ID_PATTERN,
  isPlainObject,
  MekdeckError,
  parseGraphData,
  stableStringify,
  type Diagnostic,
  type GraphData,
} from '@mekdeck/core';
import { sha256Hex } from './hash.ts';
import { assertNoCollisions, assertSafePath, isJunkPath } from './path.ts';
import { DEFAULT_ZIP_LIMITS, openZip, writeZip, type ZipFileInput, type ZipLimits } from './zip.ts';

export const MEKD_FORMAT = 'mekd';
export const MEKD_FORMAT_VERSION = 1;
export const MEKD_MIMETYPE = 'application/vnd.mekdeck.project+zip';
export const MANIFEST_PATH = 'mekdeck.json';
export const MIMETYPE_PATH = 'mimetype';
/** Everything under here is derived output (generated code). Never imported, always regenerable. */
export const GENERATED_PREFIX = 'generated/';

export interface ProjectMeta {
  name: string;
  description?: string;
  author?: string;
  license?: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. Supplied by the caller: packing never reads the clock, so output is reproducible. */
  modifiedAt: string;
  /** Id of the graph that is the project's entry point. */
  entryGraph?: string;
  generator?: { name: string; version: string };
}

/** The in-memory form of a project. Everything in a `.mekd` maps to one of these fields. */
export interface MekdProject {
  meta: ProjectMeta;
  /** Node graphs by graph id: `graphs/<id>.graph.json`. */
  graphs: Record<string, GraphData>;
  /** Source files by path under `scripts/`. */
  scripts: Record<string, string>;
  /** Binary assets by path under `assets/`. */
  assets: Record<string, Uint8Array>;
  /**
   * Files this version does not understand, keyed by full path (for example a newer
   * minor feature's `timelines/main.json`). Kept and written back so nothing is lost.
   */
  unknown: Record<string, Uint8Array>;
}

export function createProject(name: string, now: string = new Date().toISOString()): MekdProject {
  return { meta: { name, createdAt: now, modifiedAt: now }, graphs: {}, scripts: {}, assets: {}, unknown: {} };
}

interface FileInfo {
  size: number;
  sha256: string;
}

interface Manifest {
  format: typeof MEKD_FORMAT;
  formatVersion: number;
  project: ProjectMeta;
  files: Record<string, FileInfo>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const RESERVED = [MANIFEST_PATH, MIMETYPE_PATH, 'graphs/', 'scripts/', 'assets/', GENERATED_PREFIX];

function invalid(message: string, details?: unknown): MekdeckError {
  return new MekdeckError('E_FORMAT_INVALID', message, details);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function validateMeta(raw: unknown, where: string): ProjectMeta {
  if (!isPlainObject(raw)) throw invalid(`${where}: expected an object`);
  const { name, createdAt, modifiedAt } = raw;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 200) throw invalid(`${where}.name: expected a name (1-200 characters)`);
  if (!isIsoDate(createdAt)) throw invalid(`${where}.createdAt: expected an ISO 8601 date`);
  if (!isIsoDate(modifiedAt)) throw invalid(`${where}.modifiedAt: expected an ISO 8601 date`);
  const meta: ProjectMeta = { name, createdAt, modifiedAt };
  for (const key of ['description', 'author', 'license'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 10_000) throw invalid(`${where}.${key}: expected a string`);
    meta[key] = value;
  }
  if (raw.entryGraph !== undefined) {
    if (typeof raw.entryGraph !== 'string' || !ID_PATTERN.test(raw.entryGraph)) throw invalid(`${where}.entryGraph: expected a graph id`);
    meta.entryGraph = raw.entryGraph;
  }
  const generator = raw.generator;
  if (generator !== undefined) {
    if (!isPlainObject(generator) || typeof generator.name !== 'string' || typeof generator.version !== 'string') {
      throw invalid(`${where}.generator: expected { name, version }`);
    }
    meta.generator = { name: generator.name, version: generator.version };
  }
  return meta;
}

function parseManifest(bytes: Uint8Array): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new MekdeckError('E_NOT_MEKDECK', `${MANIFEST_PATH} is not valid JSON`, undefined, { cause: error });
  }
  if (!isPlainObject(raw) || raw.format !== MEKD_FORMAT) {
    throw new MekdeckError('E_NOT_MEKDECK', `${MANIFEST_PATH} does not describe a MekDeck project`);
  }
  const version = raw.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw invalid(`${MANIFEST_PATH}: formatVersion must be a positive integer`);
  }
  if (version > MEKD_FORMAT_VERSION) {
    throw new MekdeckError(
      'E_FORMAT_TOO_NEW',
      `This project uses file format version ${version}, but this MekDeck only understands up to version ${MEKD_FORMAT_VERSION}. Update MekDeck to open it.`,
      { found: version, supported: MEKD_FORMAT_VERSION },
    );
  }
  // Future: migrate older versions here, one step at a time (v1 -> v2 -> ...).

  const meta = validateMeta(raw.project, 'project');
  if (!isPlainObject(raw.files)) throw invalid('files: expected an object');
  const files: Record<string, FileInfo> = {};
  for (const [path, info] of Object.entries(raw.files)) {
    assertSafePath(path);
    if (!isPlainObject(info) || !Number.isInteger(info.size) || (info.size as number) < 0 || typeof info.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(info.sha256)) {
      throw invalid(`files.${path}: expected { size, sha256 }`);
    }
    files[path] = { size: info.size as number, sha256: info.sha256 };
  }
  return { format: MEKD_FORMAT, formatVersion: version, project: meta, files };
}

function textFile(text: string): Uint8Array {
  return encoder.encode(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * Flatten a project into the files a `.mekd` contains (the manifest first, then the rest
 * sorted by path), with every file's size and SHA-256 recorded in the manifest.
 */
export async function projectToFiles(project: MekdProject): Promise<Map<string, Uint8Array>> {
  const meta = validateMeta(project.meta, 'meta');
  const content = new Map<string, Uint8Array>();

  for (const [id, graph] of Object.entries(project.graphs)) {
    if (!ID_PATTERN.test(id)) throw invalid(`Graph id "${id}" is not valid`);
    if (graph.id !== id) throw invalid(`Graph stored as "${id}" has id "${graph.id}"; they must match`);
    content.set(`graphs/${id}.graph.json`, textFile(stableStringify(graph)));
  }
  for (const [path, source] of Object.entries(project.scripts)) content.set(`scripts/${path}`, encoder.encode(source));
  for (const [path, data] of Object.entries(project.assets)) content.set(`assets/${path}`, data);
  for (const [path, data] of Object.entries(project.unknown)) {
    if (RESERVED.some((r) => path === r || (r.endsWith('/') && path.startsWith(r)))) {
      throw new MekdeckError('E_PATH_RESERVED', `"${path}" is in a folder reserved for MekDeck's own files`);
    }
    content.set(path, data);
  }
  for (const path of content.keys()) assertSafePath(path);
  assertNoCollisions(content.keys());

  if (meta.entryGraph !== undefined && !(meta.entryGraph in project.graphs)) {
    throw invalid(`entryGraph "${meta.entryGraph}" does not exist in this project`);
  }

  const files: Record<string, FileInfo> = {};
  for (const path of [...content.keys()].sort()) {
    const data = content.get(path)!;
    files[path] = { size: data.length, sha256: await sha256Hex(data) };
  }
  const manifest: Manifest = { format: MEKD_FORMAT, formatVersion: MEKD_FORMAT_VERSION, project: meta, files };

  const out = new Map<string, Uint8Array>();
  out.set(MANIFEST_PATH, textFile(stableStringify(manifest)));
  for (const path of [...content.keys()].sort()) out.set(path, content.get(path)!);
  return out;
}

export type VerifyMode = 'strict' | 'warn' | 'off';

export interface ReadOptions {
  /**
   * `strict` (default): a missing, resized or altered file throws `E_INTEGRITY`.
   * `warn`: report it as an error diagnostic and load what is readable (recovery mode).
   * `off`: skip hash checks.
   */
  readonly verify?: VerifyMode;
}

export interface ReadResult {
  project: MekdProject;
  diagnostics: Diagnostic[];
}

/** Build a project from a map of files (a folder on disk, or an unzipped archive). */
export async function filesToProject(files: ReadonlyMap<string, Uint8Array>, options: ReadOptions = {}): Promise<ReadResult> {
  const verify = options.verify ?? 'strict';
  const diagnostics: Diagnostic[] = [];
  for (const path of files.keys()) assertSafePath(path);
  assertNoCollisions(files.keys());

  const manifestBytes = files.get(MANIFEST_PATH);
  if (!manifestBytes) {
    throw new MekdeckError('E_NOT_MEKDECK', `This is not a MekDeck project: it has no ${MANIFEST_PATH}`);
  }
  const manifest = parseManifest(manifestBytes);

  if (verify !== 'off') {
    for (const [path, info] of Object.entries(manifest.files)) {
      const data = files.get(path);
      let problem: string | undefined;
      if (!data) problem = 'is listed in the manifest but missing';
      else if (data.length !== info.size) problem = `has ${data.length} bytes but the manifest says ${info.size}`;
      else if ((await sha256Hex(data)) !== info.sha256) problem = 'does not match its recorded SHA-256 (it was modified or damaged)';
      if (problem === undefined) continue;
      const message = `"${path}" ${problem}`;
      if (verify === 'strict') throw new MekdeckError('E_INTEGRITY', message, { path });
      diagnostics.push({ severity: 'error', code: 'integrity-failed', message, path });
    }
  }

  const project: MekdProject = { meta: manifest.project, graphs: {}, scripts: {}, assets: {}, unknown: {} };
  for (const [path, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (path === MANIFEST_PATH || path === MIMETYPE_PATH || path.startsWith(GENERATED_PREFIX) || isJunkPath(path)) continue;

    const graphMatch = /^graphs\/([^/]+)\.graph\.json$/.exec(path);
    if (graphMatch) {
      const id = graphMatch[1]!;
      try {
        const graph = parseGraphData(JSON.parse(decoder.decode(data)));
        if (graph.id !== id) throw invalid(`its id "${graph.id}" does not match the file name`);
        project.graphs[id] = graph;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new MekdeckError('E_FORMAT_INVALID', `${path}: ${reason}`, { path }, { cause: error });
      }
    } else if (path.startsWith('scripts/')) {
      try {
        project.scripts[path.slice('scripts/'.length)] = decoder.decode(data);
      } catch (error) {
        throw new MekdeckError('E_FORMAT_INVALID', `${path}: not valid UTF-8 text`, { path }, { cause: error });
      }
    } else if (path.startsWith('assets/')) {
      project.assets[path.slice('assets/'.length)] = data;
    } else {
      project.unknown[path] = data;
      // With verification off the files are a working copy (a folder someone is editing),
      // where the manifest is expected to be stale, so unlisted files are not worth a warning.
      if (verify !== 'off' && !(path in manifest.files)) {
        diagnostics.push({ severity: 'warning', code: 'unlisted-file', message: `"${path}" is not listed in the manifest`, path });
      }
    }
  }

  const entry = project.meta.entryGraph;
  if (entry !== undefined && !(entry in project.graphs)) {
    diagnostics.push({ severity: 'error', code: 'missing-entry-graph', message: `The entry graph "${entry}" is missing` });
  }
  return { project, diagnostics };
}

export type PackProfile = 'project' | 'bundle';

export interface PackOptions {
  /**
   * `project` (default): a `.mekd` file. Starts with a `mimetype` entry so tools can
   * recognise it by its first bytes.
   * `bundle`: an export ZIP: the same project files plus `generated/` code. Imports like a `.mekd`.
   */
  readonly profile?: PackProfile;
  /** Bundle only. Paths are relative to `generated/` (for example `three/src/main.js`). */
  readonly generated?: readonly { readonly path: string; readonly content: string | Uint8Array }[];
}

/** Serialize a project to bytes. The same project always produces the same bytes. */
export async function packProject(project: MekdProject, options: PackOptions = {}): Promise<Uint8Array> {
  const profile = options.profile ?? 'project';
  if (profile === 'project' && options.generated !== undefined) {
    throw new MekdeckError('E_PACK_OPTIONS', 'Generated code can only be added to a bundle, not a .mekd project file');
  }
  const files = await projectToFiles(project);

  const entries: ZipFileInput[] = [];
  if (profile === 'project') entries.push({ path: MIMETYPE_PATH, data: encoder.encode(MEKD_MIMETYPE), method: 'store' });
  for (const [path, data] of files) entries.push({ path, data });
  for (const item of [...(options.generated ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    entries.push({ path: `${GENERATED_PREFIX}${item.path}`, data: typeof item.content === 'string' ? encoder.encode(item.content) : item.content });
  }
  return writeZip(entries);
}

export interface UnpackOptions extends ReadOptions {
  readonly limits?: ZipLimits;
}

export interface UnpackResult extends ReadResult {
  readonly profile: PackProfile;
}

/** Decode a `.mekd` or a bundle ZIP. Safe to call on untrusted files. */
export async function unpackProject(bytes: Uint8Array, options: UnpackOptions = {}): Promise<UnpackResult> {
  const archive = openZip(bytes, options.limits ?? DEFAULT_ZIP_LIMITS);

  let profile: PackProfile = 'bundle';
  if (archive.has(MIMETYPE_PATH)) {
    const mimetype = decoder.decode(await archive.read(MIMETYPE_PATH));
    if (mimetype !== MEKD_MIMETYPE) {
      throw new MekdeckError('E_BAD_MIMETYPE', `Unexpected file type "${mimetype}"; expected "${MEKD_MIMETYPE}"`);
    }
    profile = 'project';
  }

  const wanted = archive.entries
    .map((e) => e.path)
    .filter((path) => path !== MIMETYPE_PATH && !path.startsWith(GENERATED_PREFIX) && !isJunkPath(path));
  const result = await filesToProject(await archive.readAll(wanted), options);
  return { ...result, profile };
}
