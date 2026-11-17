import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { MekdeckError, type Diagnostic } from '@mekdeck/core';
import { assertSafePath, filesToProject, isJunkPath, unpackProject, type MekdProject } from '@mekdeck/format';

/** Version-control and tooling folders that are not part of a project. */
const IGNORED_AT_ROOT = new Set(['.git', '.gitignore', '.gitattributes', 'node_modules']);

/** Read a project folder into a path -> bytes map. Symlinks are refused (they could point anywhere). */
export async function readFolder(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (prefix === '' && IGNORED_AT_ROOT.has(entry.name)) continue;
      // macOS can report decomposed (NFD) names; project paths are always NFC.
      const rel = (prefix === '' ? entry.name : `${prefix}/${entry.name}`).normalize('NFC');
      if (isJunkPath(rel)) continue;
      if (entry.isSymbolicLink()) {
        throw new MekdeckError('E_SYMLINK', `"${rel}" is a symbolic link; project folders cannot contain links`);
      }
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (entry.isFile()) files.set(rel, new Uint8Array(await readFile(join(dir, entry.name))));
    }
  }
  await walk(root, '');
  return files;
}

export interface LoadedProject {
  project: MekdProject;
  diagnostics: Diagnostic[];
  /** Where it came from: a folder is a working copy (hashes are not checked, the manifest is rebuilt on pack). */
  source: 'folder' | 'file';
  profile?: 'project' | 'bundle';
}

/** Load a project from a folder, a `.mekd`, or an export `.zip`. */
export async function loadProject(path: string, shown: string = path): Promise<LoadedProject> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new MekdeckError('E_NOT_FOUND', `Cannot find "${shown}"`);
  }
  if (info.isDirectory()) {
    const { project, diagnostics } = await filesToProject(await readFolder(path), { verify: 'off' });
    return { project, diagnostics, source: 'folder' };
  }
  const { project, diagnostics, profile } = await unpackProject(new Uint8Array(await readFile(path)));
  return { project, diagnostics, source: 'file', profile };
}

/** `true` if `path` exists and (for folders) is not empty. */
export async function exists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return (await readdir(path)).length > 0;
    return true;
  } catch {
    return false;
  }
}

/** Write files below `root`, refusing any path that would land outside it. */
export async function writeFolder(root: string, files: Iterable<[string, Uint8Array | string]>): Promise<number> {
  const base = resolve(root);
  let count = 0;
  for (const [rel, data] of files) {
    assertSafePath(rel);
    const target = resolve(base, ...rel.split('/'));
    if (target !== base && !target.startsWith(base + sep)) {
      throw new MekdeckError('E_PATH_UNSAFE', `Refusing to write outside the output folder: "${rel}"`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    count++;
  }
  return count;
}
