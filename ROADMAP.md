# Roadmap

MekDeck's ambition is large: a graph-based platform that overlaps with Blender, Maya, DaVinci Resolve, three.js and SolidWorks. Those took decades and large teams. The way to reach even part of that is **order**: build the foundation that everything else stands on, make one slice excellent, then widen.

This roadmap is in phases, not dates. A phase is finished when its exit criteria are demonstrably true, not when time runs out.

## Strategy: pick a wedge

Do not try to out-Blender Blender. MekDeck wins where its design is *different*: one graph that exports to readable code, scriptable end to end, with an open file format. The first wedge is **interactive 3D for the web and game prototypes**: build a scene visually, export clean three.js, and keep extending it in code. Modeling, sculpting, rigging, simulation and CAD come after that slice is excellent, if ever.

## Phase 0: Foundations (done)

- Node-graph engine: typed ports, cycle and type checking, atomic operations.
- Undo/redo: transactions, drag coalescing.
- Incremental evaluator: lazy, cached, early cutoff, fault isolation, volatile (time) nodes.
- `.mekd` format: deterministic ZIP container, SHA-256 manifest, safe on hostile input; zip export and import.
- Scene IR and 24 standard nodes.
- three.js code generation with graph-to-code source map.
- `mekdeck` CLI: `new`, `pack`, `unpack`, `validate`, `inspect`, `eval`, `codegen`, `export`, `import`.
- 139 tests, including attacks on the file reader and a test that runs the generated program.

## Phase 1: Desktop app and node editor

**Goal: build the sample scene in a window, with no code.**

- Electron shell (main / preload / renderer, `contextIsolation` on, no Node in the renderer), Windows, macOS, Linux.
- Node canvas: pan/zoom, drag to connect (live `checkConnection` feedback), box select, copy/paste, minimap, searchable palette generated from `registry.byCategory()`.
- Properties panel: edits inline values and params; slider drags coalesce into one undo step.
- Open/save `.mekd` with atomic writes, autosave and crash recovery; recent files.
- Settings; Help (node reference generated from node definitions).
- **ZIP64 and streaming** pack/unpack for large assets.
- Release pipeline: bundler, signed installers, auto-update, publishing the packages to npm.

**Exit:** a new user builds the sample scene from scratch in the editor and saves it; the saved file opens in the CLI unchanged.

## Phase 2: Live preview, views and timeline

- Renderer adapter that turns Scene IR into a live three.js scene with *incremental* updates (no rebuild per edit).
- Viewport with orbit controls; camera view; preview of the project's own camera.
- **Code view**: generated code beside the graph, with node-to-line highlighting both ways, using the existing source map.
- **Timeline**: keyframes and curves as new project data (a new format version), bound to `Evaluator.setTime`; play, scrub, loop.
- Asset import: glTF/GLB, images; content-addressed storage in the project.

**Exit:** change a value, see it in the viewport within one frame; scrub the timeline and watch a keyframed object move; click a line of code and the owning node highlights.

## Phase 3: Scripting

- A TypeScript scripting API over `GraphEditor`, so a script can do anything the UI can, undoably.
- Custom node types defined in scripts (`defineNode`), appearing in the palette.
- **Sandboxed** execution with a capability-based API (no ambient file or network access); explicit user consent before running scripts from an opened project.
- Script editor with diagnostics and autocomplete for the API.

**Exit:** a script adds 100 nodes, wires them, and one undo removes them all; a malicious script cannot read a file it was not given.

## Phase 4: Headless render

- `mekdeck render project.mekd --frames 0-299 -o out/`: image sequences, and video through ffmpeg when installed.
- Offscreen GPU rendering without a visible window.
- **Cannot crash silently**: work is split into chunks run in child processes under a watchdog, with a memory budget, resumable after failure, and deterministic output for the same input.
- Progress reporting and cancellation.

**Exit:** render a 10,000-frame sequence, kill the process mid-way, resume, and get identical frames.

## Phase 5: More targets and a MekDeck runtime

- `@mekdeck/runtime`: loads a `.mekd` in a browser or Node.js and plays it.
- Targets: Node.js and Next.js alongside three.js.
- **Graph compiler**: emit dynamic code (animation, logic, time-driven values) instead of a static snapshot; tree-shaken output.

**Exit:** an animated, interactive scene exports to a Next.js app whose behavior matches the editor preview.

## Phase 6: Materials, effects and media

- Shader graph compiled to WGSL/GLSL, with a live material preview.
- Post-processing, LUTs and colour management.
- Particles and VFX; audio graph and sound effects; motion-graphics layers (text, shapes).
- Physics, instancing, level of detail.
- WebGPU as a first-class renderer.

## Phase 7: Ecosystem

- Plugin API and a plugin registry with permissions.
- Documentation site, templates and an example gallery.
- Localization and accessibility pass.
- Collaboration on the operations model (already the unit of change).

## Later, if the wedge succeeds

Modeling and sculpting tools, rigging and character animation, simulation, parametric CAD. Each is a project the size of a product; none should start before Phases 1 to 4 are excellent.

## Open decisions

These need a decision before the phase that depends on them. Record each as an ADR in `docs/decisions/`.

| Decision | Needed by | Notes |
| --- | --- | --- |
| Renderer UI framework (React, Svelte, Solid, ...) | Phase 1 | The renderer talks only to `core`, so the choice is reversible |
| Node canvas: build it or adopt a library | Phase 1 | Custom Canvas/WebGL scales to thousands of nodes; a library is faster to start |
| Scripting sandbox technology | Phase 3 | Worker + capability API vs. a WASM JS engine |
| Audio engine, physics engine | Phase 6 | |
| Governance and contributor agreement (DCO vs CLA) | Before first outside PRs | |
| Code of Conduct (adopt the Contributor Covenant) | Before first outside PRs | |
| Name clearance: GitHub org, npm scope `@mekdeck`, domain, trademark | **Now** | A web search found no existing "MekDeck" software or `.mekd` file type, which is not proof of availability |
| Telemetry stance | Phase 1 | Proposal: none by default; opt-in only |
