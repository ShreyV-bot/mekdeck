import { MekdeckError } from '@mekdeck/core';

const encoder = new TextEncoder();
// Anything Windows forbids, plus backslash and control characters. Banning it everywhere
// means a project unpacked on one OS can always be unpacked on another.
const ILLEGAL = /[<>:"|?*\\\u0000-\u001f\u007f]/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Throws `E_PATH_UNSAFE` unless `path` is a portable, relative, forward-slash file path
 * that cannot escape its extraction folder ("zip-slip") or misbehave on Windows/macOS.
 */
export function assertSafePath(path: string): void {
  function fail(why: string): never {
    throw new MekdeckError('E_PATH_UNSAFE', `Unsafe file path "${path}": ${why}`);
  }
  if (path.length === 0) fail('it is empty');
  if (encoder.encode(path).length > 1024) fail('it is longer than 1024 bytes');
  if (path !== path.normalize('NFC')) fail('it is not Unicode NFC normalized');
  if (path.startsWith('/')) fail('it must be relative');
  if (path.endsWith('/')) fail('it must name a file, not a folder');

  for (const segment of path.split('/')) {
    if (segment === '') fail('it contains an empty segment');
    if (segment === '.' || segment === '..') fail('it contains "." or ".." segments');
    if (ILLEGAL.test(segment)) fail('it contains characters that are not portable across Windows, macOS and Linux');
    if (/[. ]$/.test(segment)) fail('a name cannot end with a dot or a space');
    if (WINDOWS_DEVICE.test(segment)) fail('it uses a reserved Windows device name');
    if (encoder.encode(segment).length > 255) fail('a name is longer than 255 bytes');
  }
}

/** Windows and macOS are case-insensitive, so "A.png" and "a.png" cannot coexist. */
export function collisionKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

export function assertNoCollisions(paths: Iterable<string>): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const key = collisionKey(path);
    const other = seen.get(key);
    if (other !== undefined) {
      throw new MekdeckError(
        'E_PATH_COLLISION',
        other === path ? `Duplicate file path "${path}"` : `File paths "${other}" and "${path}" differ only by case`,
      );
    }
    seen.set(key, path);
  }
}

/** OS metadata that sneaks into archives made by file managers. Never part of a project. */
export function isJunkPath(path: string): boolean {
  return (
    path.startsWith('__MACOSX/') ||
    path.split('/').some((segment) => segment === '.DS_Store' || segment === 'Thumbs.db' || segment === 'desktop.ini')
  );
}
