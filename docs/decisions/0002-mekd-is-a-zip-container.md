# ADR 0002: `.mekd` is a ZIP container with a hashed manifest

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

MekDeck needs its own project file format (`.mekd`), plus export to zip and import of a zip. The format must also:

- hold many kinds of content: graphs (structured text), scripts (text), and large binary assets (images, models, audio);
- be safe to open when it comes from a stranger;
- diff well in version control, and be recoverable if it is damaged or from a newer version;
- be implementable on every platform the app runs on, including a browser, without native code;
- never lose a user's work because their MekDeck is older than the file.

## Decision

A `.mekd` file is a **ZIP archive** whose contents are described by a JSON **manifest** (`mekdeck.json`) that records every file's size and SHA-256. Graphs are individual JSON files with sorted keys; assets are stored as original bytes. A *project* profile begins with a stored `mimetype` entry; an *export bundle* is the same project files plus a `generated/` folder of derived code and imports identically. The full rules are in the [format specification](../spec/mekd-format.md).

The reader and writer are implemented in-house in a few hundred lines with only Web APIs (`CompressionStream`, `DecompressionStream`, `crypto.subtle`), with strict safety checks.

## Why this design

- **"Export as zip / import zip" is not a second feature.** A bundle *is* a project with extra files, so there is one reader and one set of safety rules.
- **Inspectable and recoverable.** Any unzip tool opens a `.mekd`; JSON graphs can be read, repaired and diffed by hand. The manifest lets us detect damage and point at the exact broken file.
- **Mixed content without conversion.** Binary assets stay as normal files, so they are stored once, without base64 inflation.
- **Proven pattern.** OpenDocument, EPUB, Office Open XML and Java JARs are all "a zip with a manifest", for the same reasons. The `mimetype`-first trick is borrowed from OpenDocument and EPUB.
- **Portable.** No native code: the same implementation runs in Electron, Node, a Worker and a browser.

## Why an in-house ZIP implementation

Adding a ZIP library would be the usual choice, so the reasons need stating:

- The security-critical behaviour is exactly what generic libraries make optional: declared-size enforcement *while* inflating, ratio caps, refusing ZIP64 and encryption instead of half-supporting them, path rules for every OS, collision detection, deterministic writing. We wanted that behaviour guaranteed and tested rather than configured.
- Deterministic output (fixed timestamps and modes, fixed order) is rarely a library default.
- The supported subset is small (stored and deflate; no ZIP64 yet), the format is stable and publicly specified, and the implementation is cross-checked against Info-ZIP's `zip` and `unzip` in both directions in the tests.

The trade-off is that we own the code and its bugs. It is mitigated by tests that attack the reader (zip-slip, bombs, truncation, CRC damage, unsupported features) and by keeping the supported subset small. If ZIP64 and streaming prove costly to build well, adopting a vetted library behind the same interface is a reasonable future decision.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A single JSON file with embedded assets | Base64 bloats binary data by about a third, the whole file must be parsed to read anything, and large projects become unwieldy |
| A custom binary format | Not inspectable, needs a bespoke tool to repair, and a bug in the parser is a security bug in a format only we use |
| A folder of files | The right *working* form (the CLI supports it as an editable working copy) but a poor *exchange* form: not one file to share, and path rules differ per OS |
| SQLite container | Excellent for random access and large data, but adds a native or WASM dependency, is opaque to plain tools and diffs badly. May return as an optional cache, not as the interchange format |
| tar | No random access to a single entry without reading preceding data, and no standard compression story |

## Consequences

**Good**

- One reader, one writer, one set of tests for projects and export bundles.
- Files are reproducible: the same project packs to the same bytes (subject to the deflate-implementation caveat in the spec).
- Old readers refuse newer files clearly and never silently drop data.

**Costs and limits**

- Version 1 has no ZIP64: archives are limited to 65,534 files and 4 GiB, and everything is processed in memory. Large asset libraries will need ZIP64 and streaming, planned for Phase 1; it is an additive change that the version rules already accommodate.
- The SHA-256 manifest detects accidental damage and casual tampering but is **not** a signature. Signed projects are future work.
- Opening needs the whole archive in memory in version 1.

## Revisit when

- Projects regularly exceed several hundred MB (streaming, ZIP64, partial loading).
- We need partial, random-access loading of huge asset sets (content-addressed storage or a database-backed cache).
- Signing or encryption of projects is required.
