# MekDeck

**An open-source, node-based platform for building 3D websites, games, apps, and the tools that build them.**

Wire nodes together on a canvas. See the result live. Read the generated code. Script anything. Export a project you own, as a single `.mekd` file or a zip with runnable code.

> **Status: Phase 0 (foundations).** The engine, file format, code generator and command line work and are tested. The desktop editor, live 3D viewport, timeline and scripting are not built yet. See [Status](#status) and the [roadmap](ROADMAP.md). Nothing here pretends to be more finished than it is.

## Why

Blender, Maya, DaVinci Resolve, three.js and SolidWorks are each excellent at one slice. MekDeck's bet is the connective tissue between them:

- **Everything is a graph.** Geometry, materials, cameras, effects and logic are nodes with typed ports, like Blender's shader editor, for the whole project.
- **Everything is code.** Every graph can be turned into readable source (three.js today; Node.js and Next.js next), with a source map from each line back to the node that made it.
- **Everything is data.** Every edit is a plain operation. That one design gives undo/redo, scripting (a script can do anything the UI can), and, later, collaboration.
- **Your files are yours.** `.mekd` is a documented, open ZIP-based format with integrity hashes. Export to zip, import from zip, diff it in git.

## Quick start

Requirements: **Node.js 22.18+** and **pnpm**.

```sh
git clone <your-fork-url> mekdeck && cd mekdeck
pnpm install
pnpm check                      # typecheck + the whole test suite

pnpm mekdeck new my-scene       # a sample project folder
pnpm mekdeck validate my-scene  # check it
pnpm mekdeck pack my-scene      # -> my-scene.mekd
pnpm mekdeck inspect my-scene.mekd
pnpm mekdeck export my-scene.mekd --target three   # -> zip with project + runnable three.js app
```

The exported zip contains your project plus `generated/three/`, a ready-to-run Vite + three.js app (`npm install && npm run dev`). Importing that zip back (`mekdeck import`) gives you the same `.mekd` you started with.

## Status

| Area | State |
| --- | --- |
| Node graph engine: typed ports, cycle and type checking, atomic operations | Working, tested |
| Undo/redo with transactions and drag coalescing | Working, tested |
| Incremental evaluator (lazy, cached, early cutoff, 20,000-node chains) | Working, tested |
| `.mekd` format, zip export and import, integrity hashes, hostile-input safety | Working, tested |
| Scene IR and a 24-node standard library (values, math, vectors, geometry, materials, lights, camera) | Working, small |
| three.js code generation with graph-to-code source map (static snapshot) | Working |
| `mekdeck` command line | Working |
| Desktop app and node editor UI | Not started |
| Live 3D viewport, camera view, code view panel | Not started |
| Timeline and animation | Not started (time already flows through the evaluator) |
| Scripting | Not started (designed: same operations the UI uses) |
| Headless render | Not started |
| Node.js / Next.js targets, MekDeck runtime | Not started |
| Shader graph, VFX, audio, LUT, motion graphics | Not started |

## Repository layout

| Package | What it does |
| --- | --- |
| [`@mekdeck/core`](packages/core) | Node graph model, operations, undo/redo, incremental evaluator. No Node or DOM APIs: runs anywhere. |
| [`@mekdeck/scene`](packages/scene) | Scene IR: the renderer-agnostic description of a scene that graphs produce. |
| [`@mekdeck/nodes`](packages/nodes) | The standard node library and scene evaluation. |
| [`@mekdeck/format`](packages/format) | The `.mekd` container: ZIP reader/writer, manifest, integrity, import/export. Web APIs only. |
| [`@mekdeck/codegen`](packages/codegen) | Scene IR to source code, with source maps. |
| [`@mekdeck/cli`](packages/cli) | The `mekdeck` command. |

Design documents: [ARCHITECTURE](ARCHITECTURE.md) · [.mekd format spec](docs/spec/mekd-format.md) · [node graph spec](docs/spec/node-graph.md) · [decision records](docs/decisions).

## Principles

1. **No dependencies until one is earned.** Phase 0 has zero runtime dependencies. Every dependency is a security and maintenance cost.
2. **Treat every file as hostile.** `.mekd` files and zips come from the internet. They are validated, size-limited and path-checked on open.
3. **Deterministic by default.** The same project packs to the same bytes; the same graph generates the same code.
4. **Fail loudly, name the cause.** Errors have stable codes and point at the node or file that is actually wrong.
5. **Small, tested, boring core.** Cleverness belongs in plugins, not in the part everything else depends on.

## Contributing

Yes, please. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Good first contributions: new node types, more geometry, a new code-generation target, docs, and tests that try to break things.

## License

[Apache License 2.0](LICENSE). Projects you build with MekDeck, and the code it generates for you, belong to you.
