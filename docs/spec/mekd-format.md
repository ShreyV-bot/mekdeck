# The `.mekd` file format

**Format version: 1** · Media type: `application/vnd.mekdeck.project+zip` · Extension: `.mekd`

This document is the specification of what MekDeck writes and what it accepts. Where this text and the code disagree, that is a bug in one of them; please report it. The reference implementation is [`@mekdeck/format`](../../packages/format).

The words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Goals

1. **Open and inspectable.** A `.mekd` is an ordinary ZIP file. Any unzip tool can open it, and every file inside is plain JSON, source text or an original asset.
2. **Safe to open from strangers.** Readers MUST treat the archive as hostile (section 8).
3. **Deterministic.** The same project always serializes to the same bytes (section 7).
4. **Forward compatible.** A reader MUST NOT destroy data it does not understand (section 6).
5. **Round-trips through zip export.** An export bundle imports as a project (section 5).

## 2. Container

A `.mekd` is a ZIP archive (PKWARE APPNOTE) with these constraints.

| Aspect | Rule |
| --- | --- |
| Compression methods | `0` (stored) and `8` (deflate) only |
| Names | UTF-8, forward slashes, no leading `/`. Writers emit no folder entries; readers ignore folder entries (names ending in `/`), which MUST carry no data |
| ZIP64 | Not supported in format version 1. Archives are limited to 65,534 entries and 4 GiB; readers refuse ZIP64 |
| Encryption, multi-disk | Not supported; refused |
| Timestamps | Writers MUST use `1980-01-01 00:00:00`, the earliest DOS time, and file mode `0644`, so output is reproducible |
| Ordering | Writers MUST write entries in the order given in section 3 |
| Choosing a method | Writers use *deflate* only when the file is at least 64 bytes, does not have the extension of an already-compressed format (png, jpg, webp, avif, gif, mp3, mp4, m4a, ogg, opus, webm, mkv, mov, zip, gz, br, zst, 7z, woff, woff2) and deflating actually makes it smaller. Otherwise it is *stored*. The `mimetype` entry is always stored |

Readers MUST treat the **central directory** as the source of truth for names, sizes, methods, CRC-32 and offsets; the local header is used only to find where the data starts (its signature is checked, and its sizes and CRC fields are ignored). A stored entry whose compressed and uncompressed sizes differ is corrupt.

## 3. Archive layout

```
mimetype                       (project profile only; first entry; stored)
mekdeck.json                   manifest
graphs/<graph-id>.graph.json   one file per node graph
scripts/<path>                 source files (reserved for Phase 3)
assets/<path>                  binary assets (images, models, audio, ...)
generated/<target>/<path>      derived code (bundle profile only; never imported)
<any other path>               unknown files: preserved, see section 6
```

**Order of entries when writing:** `mimetype` (project profile), then `mekdeck.json`, then all other project files sorted by path (bytewise on the UTF-16 code units, i.e. JavaScript's default string order), then `generated/` files sorted by path.

### 3.1 `mimetype`

Only in the *project* profile (a `.mekd` file). It MUST be the first entry, stored (not compressed), containing exactly `application/vnd.mekdeck.project+zip` with no trailing newline. This lets tools identify the file by its first bytes (the same trick as OpenDocument and EPUB). A reader that finds a `mimetype` entry with any other content MUST reject the file (`E_BAD_MIMETYPE`).

### 3.2 `mekdeck.json` (the manifest)

UTF-8 JSON, written with sorted keys and 2-space indentation and a final newline.

```json
{
  "files": {
    "assets/wood.png": { "sha256": "9f86d0…", "size": 20481 },
    "graphs/main.graph.json": { "sha256": "e3b0c4…", "size": 3921 }
  },
  "format": "mekd",
  "formatVersion": 1,
  "project": {
    "createdAt": "2026-11-16T09:58:00.000Z",
    "entryGraph": "main",
    "generator": { "name": "mekdeck", "version": "0.1.0" },
    "modifiedAt": "2026-11-16T10:12:00.000Z",
    "name": "My Scene"
  }
}
```

| Field | Type | Rule |
| --- | --- | --- |
| `format` | string | MUST be `"mekd"` |
| `formatVersion` | integer ≥ 1 | See section 6 |
| `project.name` | string | 1 to 200 characters, not blank |
| `project.createdAt`, `project.modifiedAt` | string | ISO 8601. The writer's caller supplies them: packing never reads the clock |
| `project.description`, `author`, `license` | string, optional | At most 10,000 characters |
| `project.entryGraph` | string, optional | A graph id that MUST exist in `graphs/` |
| `project.generator` | `{name, version}`, optional | Informational |
| `files` | object | Maps each file path to `{ size, sha256 }`: the byte length and lowercase hex SHA-256 of the **uncompressed** contents |

`files` lists every file except `mekdeck.json` itself and `mimetype`, and excludes `generated/`.

### 3.3 Graph files

`graphs/<id>.graph.json`, where `<id>` matches `^[A-Za-z0-9_-]{1,64}$` and equals the `id` field inside the file. Detailed in the [node graph spec](node-graph.md#6-serialized-form).

### 3.4 Scripts and assets

`scripts/**` are UTF-8 text files, and a reader rejects invalid UTF-8 (`E_FORMAT_INVALID`). `assets/**` are opaque bytes. Neither is interpreted in format version 1 beyond being stored, hashed and round-tripped.

## 4. Profiles

| | **project** (`.mekd`) | **bundle** (export `.zip`) |
| --- | --- | --- |
| `mimetype` entry | yes, first, stored | no |
| `mekdeck.json` and project files | yes | yes (identical) |
| `generated/` | not allowed (`E_PACK_OPTIONS`) | yes: `generated/<target>/…` |
| Intended use | Saving and sharing a project | Handing someone a runnable app *and* the source project |

A reader distinguishes the two by the presence of `mimetype`. Both import to the same in-memory project: `generated/` is ignored on import because it is derived output and can always be regenerated. The sequence *export bundle → import → pack as project* therefore returns exactly the original `.mekd` bytes.

## 5. Reading a file (normative procedure)

1. Open the ZIP safely (section 8): central directory, limits and per-entry checks. **Every** entry name is validated against section 8.1 and checked for case-insensitive collisions at this point, including entries that will be discarded in step 3; one bad name rejects the whole archive. CRC-32 is verified when an entry is read.
2. If a `mimetype` entry exists, it MUST equal the media type above; the profile is *project*. Otherwise the profile is *bundle*.
3. Discard `mimetype`, everything under `generated/`, and operating-system junk (`__MACOSX/`, `.DS_Store`, `Thumbs.db`, `desktop.ini`).
4. Files read from a project **folder** (rather than a ZIP) go through the same path validation and collision check.
5. Read `mekdeck.json`. Missing → `E_NOT_MEKDECK`. Not JSON or wrong `format` → `E_NOT_MEKDECK`. Newer `formatVersion` → `E_FORMAT_TOO_NEW`. Malformed fields → `E_FORMAT_INVALID`.
6. **Verify integrity** (section 9).
7. Classify files: `graphs/*.graph.json` are parsed and validated; `scripts/**`; `assets/**`; anything else is *unknown*.
8. If `entryGraph` names a graph that is not present, report the diagnostic `missing-entry-graph` (an error-level diagnostic, not an exception, so a damaged project can still be opened and repaired).

## 6. Versioning and compatibility

- `formatVersion` is a single integer. It increases only when a change would make an older reader **misinterpret** a file.
- **Adding** optional files or optional fields does *not* change the version.
- A reader that sees a **newer** version than it supports MUST refuse with `E_FORMAT_TOO_NEW` (and say which version it found). It MUST NOT guess.
- A reader that sees an **older** version MUST migrate it one step at a time (v1 → v2 → …). There is nothing to migrate yet.
- **Unknown files** (any path outside `graphs/`, `scripts/`, `assets/`, `generated/` and the two root files) are kept verbatim and written back on save, so a project edited by an older MekDeck does not lose files from a newer minor feature (for example a future `timelines/` folder).
- **Unknown node types** inside a graph are preserved too; see [the node graph spec](node-graph.md#7-compatibility).
- Writers MUST NOT put unknown files inside reserved folders (`E_PATH_RESERVED`).

## 7. Determinism

For a given project, a conforming writer produces identical bytes:

- JSON is serialized with sorted object keys, 2-space indent, final newline.
- Text files end with exactly one newline when written by MekDeck (`scripts/` content is written verbatim).
- Fixed ZIP timestamps and permissions; fixed entry order; the compression method follows the fixed rule in section 2 (which does compare the deflated size with the original, so it is deterministic only for a given deflate implementation).
- No data from the clock, the machine, the user or randomness enters the file other than the `createdAt`/`modifiedAt` values the caller passes.

(Byte-for-byte reproduction also assumes the same deflate implementation: the reference implementation uses the runtime's built-in `CompressionStream`, so output may differ between runtimes that bundle different zlib versions. Reading is unaffected, and the manifest hashes cover the *uncompressed* contents, which are always identical. Verifying byte-identical output across Windows, macOS and Linux is pending the first CI run.)

## 8. Safety rules for readers

A `.mekd` or bundle is untrusted input.

### 8.1 Paths

Every path MUST satisfy all of:

- non-empty, at most 1024 UTF-8 bytes; each segment at most 255 bytes
- relative; forward slashes only; no empty segments; no `.` or `..` segments; does not end with `/`
- Unicode NFC normalized
- no characters `< > : " | ? * \` and no control characters (U+0000 to U+001F, U+007F), so the file can be extracted on Windows, macOS and Linux
- no segment ending in a dot or a space
- no segment that is a Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), with or without an extension, in any case

Violations are `E_PATH_UNSAFE`. Two paths that are equal ignoring case (after NFC) are `E_PATH_COLLISION`.

### 8.2 Limits (defaults; a host MAY lower them)

| Limit | Default | Error |
| --- | --- | --- |
| Entries per archive | 50,000 | `E_ZIP_LIMIT` |
| Uncompressed size per entry | 1 GiB | `E_ZIP_LIMIT` |
| Total uncompressed size | 2 GiB | `E_ZIP_LIMIT` |
| Claimed compression ratio | 1040 : 1 (deflate cannot exceed about 1032 : 1) | `E_ZIP_BOMB` |
| Actual inflated bytes vs. declared size | must match exactly; inflation is **aborted** the moment it exceeds the declaration | `E_ZIP_BOMB` |

### 8.3 Other checks

- CRC-32 of every entry MUST match (`E_ZIP_CRC`).
- Truncated or malformed structures: `E_ZIP_CORRUPT`. Missing entry: `E_ZIP_ENTRY_MISSING`.
- ZIP64, encryption, multi-disk, other compression methods: `E_ZIP_UNSUPPORTED`.
- JSON containing a `__proto__` key anywhere is rejected (prototype pollution); JSON nesting is capped.
- Reading never executes anything.

## 9. Integrity verification modes

| Mode | Behaviour | Used by |
| --- | --- | --- |
| `strict` (default) | A file that is listed but missing, has the wrong size, or has the wrong SHA-256 → `E_INTEGRITY` | Opening a `.mekd` or zip |
| `warn` | The same problems become error diagnostics (`integrity-failed`) and loading continues, for recovery | Repairing a damaged project |
| `off` | No hash checks; unlisted files give no warning | Working-copy folders, whose manifest is regenerated on pack |

Files present but not listed in the manifest produce the warning diagnostic `unlisted-file` (not in `off` mode). The SHA-256 manifest detects accidental damage and casual tampering. It is **not** a signature: someone who edits a file can also recompute the manifest. Signing is future work.

## 10. Error and diagnostic reference

Thrown errors (`MekdeckError.code`):

| Code | Meaning |
| --- | --- |
| `E_NOT_MEKDECK` | The archive or manifest is not a MekDeck project |
| `E_BAD_MIMETYPE` | A `mimetype` entry exists but has the wrong content |
| `E_FORMAT_TOO_NEW` | `formatVersion` is newer than this reader supports |
| `E_FORMAT_INVALID` | The manifest, a graph or a script is malformed |
| `E_INTEGRITY` | A file's size or SHA-256 does not match the manifest |
| `E_PATH_UNSAFE` | A path breaks section 8.1 |
| `E_PATH_COLLISION` | Two paths differ only by case |
| `E_PATH_RESERVED` | An unknown file was placed in a reserved folder |
| `E_PACK_OPTIONS` | Invalid packing options (for example `generated` on a project) |
| `E_ZIP_CORRUPT` | Not a valid or complete ZIP |
| `E_ZIP_CRC` | An entry's CRC-32 is wrong |
| `E_ZIP_ENTRY_MISSING` | Requested entry does not exist |
| `E_ZIP_LIMIT` | A size or entry-count limit was exceeded |
| `E_ZIP_BOMB` | Decompression bomb detected |
| `E_ZIP_TOO_LARGE` | Writing: ZIP64 would be needed (not supported) |
| `E_ZIP_UNSUPPORTED` | ZIP64, encryption, multi-disk or unsupported compression |

Diagnostics (returned, not thrown; `severity` and `code`): `integrity-failed` (error), `missing-entry-graph` (error), `unlisted-file` (warning).

## 11. Future directions (non-normative)

ZIP64 and streaming for very large projects; content-addressed assets; detached signatures; `timelines/` for animation data; an optional single-file binary form for faster loading. Each will be introduced under the rules in section 6.
