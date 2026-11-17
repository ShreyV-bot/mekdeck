# ADR 0001: Desktop shell, core language, license and name

- **Status:** Accepted
- **Date:** 2026-11-16
- **Decided by:** the project founder, from options laid out by Claude

## Context

MekDeck is meant to run on Windows, macOS and Linux, to be scriptable by its users, to export to the web (three.js, Node.js, Next.js), and to be developed in the open by many contributors. Four foundational choices shape everything after them and are expensive to reverse: the desktop shell, the language of the core, the license, and the name and file extension.

## Decisions

### 1. Desktop shell: Electron

The editor will be an Electron app.

**Why:** the product's job is to author things that run on the web (WebGL, WebGPU, three.js), so the editor's own viewport *is* a web renderer. Electron gives the same Chromium on every OS, which means one rendering and one GPU behaviour to test, WebGPU support that does not depend on the user's system WebView, and the largest pool of contributors who already know the stack. Scripting in JavaScript/TypeScript needs no second runtime.

**Costs we accept:** a large download and memory footprint, and a security surface that has to be managed deliberately (context isolation, no Node in renderers, strict CSP, validated IPC; see [SECURITY.md](../../SECURITY.md)).

**Considered:** Tauri (smaller and Rust-based, but it uses each OS's own WebView, so WebGPU support and rendering behaviour would vary by platform and by what the user has installed, which a rendering-centred tool would have to test around); a web-only app (no reliable local file system, no headless render, harder offline use). Because the core packages contain no Electron or Node-specific code, the shell can be replaced or complemented (for example by a web build) without rewriting the engine.

### 2. Core language: TypeScript, as a monorepo of small packages

The engine (`core`, `scene`, `nodes`, `format`, `codegen`) is TypeScript, in a pnpm workspace.

**Why:** the same code runs in the editor, in a Worker, in the CLI, in headless render and in exported runtimes, with no foreign-function boundary. The scene graph, scripting API and generated code are all JavaScript-native, so users never cross a language gap. Contributors can start in minutes.

**Costs we accept:** less raw performance than Rust or C++ for heavy geometry work. Mitigation: heavy kernels (mesh processing, simulation) can later be WebAssembly modules behind node types without changing the architecture, since nodes are pure functions over data.

**Tooling choices that follow:**

- **Zero runtime dependencies** in the core packages until one is clearly earned.
- **Node.js 22.18+** and its built-in TypeScript type stripping, so tests and the CLI run from source with no build step in Phase 0. This restricts us to *erasable* TypeScript (no `enum`, `namespace` or parameter properties, enforced by `erasableSyntaxOnly`) and `.ts` import extensions.
- `tsc --noEmit` for type checking and `node --test` for tests.
- A bundling and publishing pipeline is deferred to Phase 1.

### 3. License: Apache License 2.0

**Why:** it is permissive, so people and companies can adopt MekDeck and ship what they make with it, which matters for a tool that wants to become widely used; it includes an explicit **patent grant**, which protects both contributors and users; and it is familiar to enterprises and compatible with most open-source licenses. The generated code and the user's projects belong to the user (stated in [NOTICE](../../NOTICE) and the README).

**Considered:** MIT (simpler, but no patent grant); GPL-3.0 as used by Blender (guarantees every fork stays open, but discourages commercial and embedded adoption and complicates plugins); MPL-2.0 (file-level copyleft; a reasonable middle path that remains available if the project later wants to protect the core while allowing proprietary plugins).

**Open follow-up:** contributor agreement. Whether to use the Developer Certificate of Origin (sign-off on commits) or a CLA must be decided before accepting outside contributions at scale. Relicensing later is only possible with contributor consent, so the choice should be made early.

### 4. Name and extension: MekDeck, `.mekd`

The product is **MekDeck**; project files use the extension **`.mekd`**, media type `application/vnd.mekdeck.project+zip`; the npm scope is `@mekdeck`; the command is `mekdeck`.

**Why:** short, pronounceable, distinct from the big incumbents' names, and the extension is four letters and mnemonic.

**Not yet verified:** a web search during planning found no existing software called MekDeck and no established use of `.mekd`, but that is not proof of availability or freedom from trademark conflict. Before the first public release someone must check: the GitHub organization and repository name, the npm scope, the domain names, and trademark databases in the main markets. Renaming is cheap now (a global rename plus the format's `format: "mekd"` identifier, which is not yet in any shipped file) and expensive after users have saved projects.

## Consequences

- Contributors need Node 22.18 or newer. This is documented in the README and enforced by `engines` and CI.
- Moving to a bundler/compiler later is straightforward because the source is already erasable TypeScript.
- The shell can change (Tauri, web) without touching the engine, because the portability rule (no Node or DOM in `core` and `format`) is part of the contribution guidelines.
- The license choice keeps adoption friction low and cannot be tightened for existing contributions later without their agreement.
