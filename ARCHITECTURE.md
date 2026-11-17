# Architecture

This document explains how MekDeck is put together and, more importantly, why. It describes what exists today and marks what is planned.

## The big picture

```
   Editor UI (planned)      Scripts (planned)         CLI (today)
          \                       |                       /
           +----------------------+----------------------+
                                  |
                           GraphEditor            validated, undoable commands
                                  |
                           GraphDocument          nodes + edges; every change is an Op
                              |        \
                              |         +-----------------> .mekd file (@mekdeck/format)
                              v
                          Evaluator               lazy, cached, early cutoff
                              |
                              v
                          Scene IR                plain data (@mekdeck/scene)
                  +-----------+-----------+
                  |           |           |
             Renderers    Code generators   Headless render
             (planned)    (three.js today)   (planned)
```

A graph is *evaluated* into a **Scene IR**, a plain-data description of a scene. Anything that wants to show, export or render the scene reads the IR and never touches the graph. That separation is the most important decision in the project: one graph can target a live viewport, generated three.js code, a Node.js server or a headless renderer without any of them knowing about each other.

## Packages and dependency rules

```
core        (no dependencies; no Node or DOM APIs)
scene       (no dependencies)
nodes       -> core, scene
format      -> core                     (Web APIs only: streams, WebCrypto)
codegen     -> core, scene
cli         -> everything               (the only package that touches the file system)
```

- **`core` and `format` run in a browser, a Worker, Electron's renderer, and Node.** They use only standard JavaScript and Web APIs (`CompressionStream`, `crypto.subtle`, `crypto.randomUUID`). File-system code lives in `cli`, and later in the desktop shell.
- Dependencies point one way. `core` knows nothing about 3D; `scene` knows nothing about graphs; `codegen` knows nothing about the editor.
- Packages are source-first (`exports` point at `.ts`), run directly by Node's type stripping, and are type-checked with `tsc --noEmit`. A bundling and publishing pipeline arrives with the first release (see the roadmap).

## Key design decisions

### 1. Every change is an operation

`GraphDocument` can only be changed by `apply(op)`. An operation is a small data object (`addNode`, `addEdge`, `setValue`, `moveNode`, ... or a `batch` of them). `apply`:

- is **atomic**: if any part of a batch fails, everything already applied is rolled back and no event fires;
- returns the **exact inverse** operation;
- emits one `change` event carrying the flattened operations.

Consequences:

| Feature | How it falls out of operations |
| --- | --- |
| Undo / redo | Store the inverse; `History` replays it. Transactions are batches. Dragging a slider coalesces into one step. |
| Scripting | A script gets the same `GraphEditor` the UI uses. Anything the UI can do, a script can do. |
| Incremental evaluation | The evaluator reads the change event to know what could be stale. |
| Collaboration (later) | Operations are the unit that gets sent over the wire. |

`GraphEditor` is the friendly layer on top: it validates first (`planConnect`, `planSetValue`, ...), throws a precise error code if the request is not allowed, and records one undo step.

### 2. Immutable nodes, structural sharing

Node and edge objects are frozen. Changing a node creates a new object, so undo snapshots are free, `toJSON()` is cheap, and an object you were handed can never change underneath you.

Each node has a **revision** that changes only when something that affects its *result* changes (values, params, incoming edges). Moving or renaming a node does not bump it, so dragging nodes around the canvas costs the evaluator nothing.

### 3. A pull-based, incremental evaluator

You ask for a node's output; the evaluator evaluates only what that node depends on.

- **Cached.** Results are kept; asking again does no work.
- **Incremental.** After an edit, only nodes whose inputs actually changed re-run.
- **Early cutoff.** If a node re-runs but produces the same output, nodes downstream of it do not re-run. (Change a number from 5 to 99 and a `sign` node still says `1`: everything after `sign` is reused.)
- **Iterative.** Evaluation uses an explicit stack, so a 20,000-node chain does not overflow the call stack (there is a test for it).
- **Fault-isolating.** A node that throws becomes an error result. Nodes that depend on it are marked *blocked*; unrelated branches keep working. The editor can show one error badge on the node that actually failed.
- **Time-aware.** Nodes marked `volatile` re-run when the playhead moves (`setTime`); everything else is reused. This is the hook the timeline will use.

Node `evaluate` functions must be **pure**: same inputs and params, same outputs, no side effects. That contract is what makes caching, early cutoff, parallelism and generated code all valid.

### 4. Typed ports with explicit conversions

Every port has a data type (`number`, `vec3`, `color`, `geometry`, ...). `canConnect` allows identical types, `any`, and a small table of explicit implicit-conversions (number to vector, boolean to number, vec3 and color). The editor can ask `checkConnection` while a wire is being dragged and show why a connection is refused (type mismatch, cycle, occupied port) before the user lets go.

### 5. Unknown things are preserved, not destroyed

A graph that uses a node type from a plugin that is not installed still opens. Those nodes show as errors, and are written back unchanged on save. Likewise, files in a `.mekd` that this version does not understand are kept and rewritten. Losing someone's work because their tools are older than the file is the worst failure a creative tool can have.

### 6. The file format is a ZIP with a manifest

`.mekd` is a ZIP archive with a manifest that records every file's SHA-256. This buys: inspect it with any unzip tool, diff its contents, detect corruption and tampering, and import/export as a zip with no separate code path. Rationale and trade-offs: [ADR 0002](docs/decisions/0002-mekd-is-a-zip-container.md); full rules: [the format spec](docs/spec/mekd-format.md).

### 7. Hostile input is the default assumption

A `.mekd` or `.zip` can come from anyone. On open, MekDeck checks paths (no `..`, absolute paths, drive letters, reserved Windows names; case-insensitive collision), enforces declared sizes while inflating (zip bombs), refuses encryption/ZIP64 rather than misreading them, verifies CRCs and SHA-256s, rejects `__proto__` keys, and refuses symlinks in project folders. Each of these has a test that attacks it. Scripts, once they exist, will never run from a freshly opened file without the user's consent and will run in a sandbox ([SECURITY.md](SECURITY.md)).

### 8. Deterministic output

Packing never reads the clock, uses fixed ZIP timestamps and permissions, sorts everything, and serializes JSON with sorted keys. The same project always produces the same bytes, so `pack(unpack(pack(p))) == pack(p)`; code generation is likewise deterministic. Reproducible builds and meaningful diffs depend on it.

## Scene IR conventions

Everything that produces or consumes a scene must agree on these:

| Thing | Convention |
| --- | --- |
| Coordinates | Right-handed, **Y up**, units are metres |
| Rotations in the IR | Euler **XYZ, radians** |
| Rotations on nodes | **Degrees** (what people type); converted at the node boundary |
| Colours | **sRGB, channels 0 to 1** (what a colour picker shows); converted to linear at the render boundary |
| Provenance | Every IR object carries `origin`, the id of the graph node that produced it |

`origin` is what links the code view and the canvas: click a line of generated code and the owning node highlights, and the reverse. The code generator records exactly which lines each node produced (`SourceRange`).

## Known limitations (by design, for now)

- **Generated code is a snapshot.** The three.js generator evaluates the graph at one point in time and emits code for that scene. It does not yet emit animation or logic driven by `math.time`. Compiling graphs to dynamic code is Phase 5.
- **ZIP64 is unsupported.** Archives are limited to 4 GiB and 65,534 files; the reader refuses ZIP64 clearly instead of misreading it. Large asset libraries will need it (Phase 1/2).
- **Packing is in-memory.** Fine for projects up to hundreds of MB; streaming comes with ZIP64.
- **No sandbox exists because no scripting exists yet.**

## How the original feature list maps onto this

| Wanted | Where it lives | State |
| --- | --- | --- |
| Easy workflow | Editor UI over `GraphEditor`; CLI today | CLI only |
| Nodes for files, actions, cameras, effects, features | `NodeRegistry`, `@mekdeck/nodes` | 24 nodes; more by phase |
| Shader-editor-style nodes, motion graphics, VFX, SFX, LUT | New node libraries and data types | Planned (Phase 6) |
| Scripting | Scripts get `GraphEditor`; custom nodes via `defineNode` | Planned (Phase 3) |
| Views: preview, code, camera | Renderer on Scene IR; `codegen` + `SourceRange` | Code generation done; views planned |
| Own file format | `.mekd` | Done |
| Export zip / import zip | Bundle profile of `.mekd` | Done |
| Own stable format and runtime, plus three.js / Node.js / Next.js | `@mekdeck/runtime`; codegen targets | three.js target done; rest planned |
| Settings, help | Desktop shell; node reference generated from the registry (nodes already carry `description`) | Planned (Phase 1) |
| Timeline | Keyframe data + `Evaluator.setTime` | Evaluator side done |
| Headless render, optimised, never crashes | `mekdeck render`, chunked and isolated | Planned (Phase 4) |
