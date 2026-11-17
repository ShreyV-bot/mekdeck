# Security policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting ("Security" tab, then "Report a vulnerability") on this repository. If that is not enabled yet, contact a maintainer privately and ask for a secure channel. *(Maintainers: enable private vulnerability reporting and put a contact address here before the first release.)*

Please include: what you found, a minimal file or steps that reproduce it, the version or commit, and what you think the impact is. We aim to acknowledge reports within a few days and to agree on a fix and disclosure timeline with you. Reporters who want credit get it.

## Supported versions

MekDeck is pre-release (Phase 0). Only the latest commit on `main` is supported. This section will list supported release lines once releases exist.

## Threat model

MekDeck opens files that other people made: `.mekd` projects, export zips, graphs, and (in the future) scripts and assets. **Any such file may be hostile.** The security goal is:

> Opening, inspecting, validating, importing or exporting a file must never let its author read or write anything outside what you asked for, run code you did not approve, or make the program use unbounded memory or time.

### What exists today, and how it is checked

| Threat | Defence | Where it is tested |
| --- | --- | --- |
| **Zip-slip**: entries named `../../x`, absolute paths, drive letters, backslashes | Every path is validated (relative, forward-slash, no `.` or `..`, no empty segments, NFC-normalized, no characters illegal on Windows, no reserved device names, length limits) before use; extraction to disk re-checks that the result stays inside the target folder | `zip.test.ts`, `project.test.ts`, `cli.test.ts` |
| **Case and Unicode collisions** (`A.png` vs `a.png`) overwriting each other on Windows/macOS | Case-insensitive collision check on read and write | `project.test.ts` |
| **Zip bombs** (tiny file, enormous contents) | Entry count, per-entry and total size limits; an entry that inflates past its *declared* size is aborted while inflating (not after); impossible compression ratios are refused | `zip.test.ts` |
| **Corrupt or tampered archives** | CRC-32 on every entry; SHA-256 manifest verified (strict by default) | `zip.test.ts`, `project.test.ts` |
| **Archive features we cannot handle safely** | ZIP64, encryption, multi-disk and unknown compression methods are refused with a clear error rather than misread | `zip.test.ts` |
| **Prototype pollution** via `__proto__` keys in graph JSON | Rejected when parsing and when building nodes and operations | `json.test.ts`, `graph.test.ts` |
| **Symlink tricks** in project folders | Symlinks are refused when reading a folder | `cli.test.ts` |
| **Code injection through generated code** (a node named `"); fetch(...)//`) | Generated code embeds user text only as escaped string literals and sanitized identifiers; a test runs the generated program with hostile names | `three.test.ts` |
| **Resource exhaustion in the evaluator** | Iterative evaluation (no stack overflow on deep graphs); numbers must be finite; JSON depth is capped | `evaluator.test.ts`, `json.test.ts` |
| **Version confusion** (a newer file read by an older program and silently corrupted) | Newer `formatVersion` is rejected; unknown files are preserved rather than dropped | `project.test.ts` |

### Known gaps (honest list)

- **Memory use.** Unpacking holds the archive in memory; limits cap it at 2 GiB total, which is generous. Lower the limits (`ZipLimits`) when handling files from untrusted sources on small machines.
- **No streaming.** Streaming and ZIP64 are planned (Phase 1).
- **Generated projects pull npm dependencies** (`three`, `vite`) when you install them. That is standard supply-chain exposure; review and pin as you would for any project.
- **Packages have not been published or signed yet**, and the build/release pipeline does not exist.
- **The Electron app does not exist yet.** When it does it must ship with `contextIsolation`, no `nodeIntegration` in renderers, a strict Content-Security-Policy, validated IPC, and no remote content loaded into privileged windows.

### Scripting (future, Phase 3): the rules in advance

Scripts are arbitrary code, so they will be designed under these constraints:

1. A script in a file you just opened **never runs automatically.** You must approve it, and the prompt will say what it asks for.
2. Scripts run in a **sandbox** (a separate Worker or isolate) with **no ambient authority**: no file system, network, or process access unless a specific capability is granted, per project.
3. Scripts get the same `GraphEditor` as the UI, so everything they do is an undoable, validated operation.
4. CPU time and memory are bounded; a runaway script is terminated without taking the app with it.

Plugins will use the same capability model.

## Handling `.mekd` files you did not create

- Prefer `mekdeck inspect` and `mekdeck validate` first; they read and check without executing anything.
- Do not run `npm install` inside a generated project you did not generate yourself without reading its `package.json`.
- If something looks wrong, report it.
