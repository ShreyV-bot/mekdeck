# The node graph

This describes the data model and evaluation rules implemented by [`@mekdeck/core`](../../packages/core) and the standard library in [`@mekdeck/nodes`](../../packages/nodes). The serialized form is the content of `graphs/<id>.graph.json` inside a [`.mekd`](mekd-format.md).

## 1. Concepts

| Term | Meaning |
| --- | --- |
| **Graph** | A set of nodes and edges with an `id` and a display `name` |
| **Node** | An instance of a *node type*, with a unique id, a position, inline `values` and `params` |
| **Node type** | A definition in the registry: ports, params, and a pure `evaluate` function. Identified by a string such as `math.add` |
| **Port** | A named, typed input or output of a node type |
| **Edge** | A connection from one node's output port to another node's input port |
| **Inline value** | The value of an *unconnected* input port, stored on the node |
| **Param** | A static setting of a node (a dropdown, a toggle), not a wire |
| **Operation (op)** | A data object describing one change to a graph. The *only* way a graph changes |

Ids (node, edge, graph) match `^[A-Za-z0-9_-]{1,64}$`.

## 2. Ports and types

Each port has a data type from the `TypeRegistry`. Built in: `any`, `number`, `boolean`, `string`, `vec2`, `vec3` and `color` (an sRGB triple, each channel 0 to 1). The scene library adds `geometry`, `material`, `object`, `scene` and so on.

An edge from an output of type *A* to an input of type *B* is valid when:

- *A* equals *B*, or
- either side is `any`, or
- an implicit conversion *A → B* is registered. The built-in conversions are:

| From | To | Conversion |
| --- | --- | --- |
| `number` | `vec2`, `vec3`, `color` | repeated in every component |
| `boolean` | `number` | `true` is 1, `false` is 0 |
| `vec3` | `color` | copied component-wise |
| `color` | `vec3` | copied component-wise |

An input port may be marked **multi** (accepts any number of edges, in edge `order`, delivered to the node as an array). Any other input accepts at most one edge. An input may also be marked **optional**: it can stay unconnected without a default, and the node then receives `undefined`.

An unconnected input uses its inline value; if there is none it uses the port's `default`; if there is no default either (and the port is not optional or multi), evaluating the node fails with `E_INPUT_MISSING`.

## 3. Validity rules (enforced on every change)

An operation that would break a rule is refused *before* anything changes:

| Rule | Code |
| --- | --- |
| Both endpoints exist; the port names exist on the node types | `E_NODE_MISSING`, `E_PORT_MISSING` |
| Output type converts to the input type | `E_TYPE_MISMATCH` |
| A node cannot connect to itself | `E_SELF_CONNECTION` |
| The connection would create a cycle | `E_CYCLE` |
| The same two ports are not already connected | `E_DUPLICATE_EDGE` |
| A single-input port is not already connected (`planConnect` with `replace` removes the old edge in the same undo step) | `E_PORT_OCCUPIED` |
| A node cannot be removed while edges still touch it (`planRemoveNode` removes them in one batch) | `E_NODE_HAS_EDGES` |
| Inline values and params match their declared types | `E_VALUE_INVALID`, `E_PARAM_INVALID` |

`GraphDocument.checkConnection(from, to)` returns the verdict without changing anything, so an editor can colour a wire while it is being dragged.

Documents loaded from disk are *not* assumed to follow these rules. `validate()` returns diagnostics (section 8) instead of throwing, so a damaged graph can still be opened and repaired.

## 4. Operations

Everything that changes a graph is an operation, applied atomically with `GraphDocument.apply(op)`.

Primitive operations: `addNode`, `removeNode`, `addEdge`, `removeEdge`, `setValue` (an inline value), `setParam`, `moveNode`, `setLabel`. A `batch` is a list of operations applied as one unit.

Guarantees:

- **Atomic.** If any operation in a batch fails, those already applied are rolled back, no event fires and the document is unchanged.
- **Invertible.** `apply` returns the exact inverse operation. Applying it restores the previous state.
- **Observable.** One `change` event per `apply`, carrying the flattened list of primitive operations and the inverse.
- **Versioned.** The document `version` increments on each successful apply. Each node also has a `nodeRevision` that changes only for edits that can affect its *result* (inline values, params, incoming edges); `moveNode` and `setLabel` do not change it, so rearranging a graph never triggers re-evaluation.

`GraphEditor` validates a request, turns it into operations (`planAddNode`, `planConnect`, `planSetValue`, …), applies them and records one undo step. Scripts and the UI both use it.

### History

Undo/redo stacks of inverse operations. `transaction(fn)` groups everything inside into one undo step and rolls back if `fn` throws (nested transactions merge into the outer one). A coalescing key plus a time window merges rapid repeats (dragging a slider) into one step. The history has a size limit. If the document was changed behind the history's back, undo refuses with `E_HISTORY_DIVERGED` rather than corrupting the graph.

## 5. Evaluation

`Evaluator.value(nodeId, port)` pulls the value of an output port.

1. **Pull-based and lazy.** Only the upstream cone of what was requested is evaluated.
2. **Iterative.** An explicit stack is used, so very deep graphs do not overflow the call stack (a 20,000-node chain is tested).
3. **Cached by revision.** A node's result is reused while its own `nodeRevision`, its inputs' versions and the time (if it is volatile) are unchanged.
4. **Early cutoff.** When a node re-runs and produces an equal result, its version does not advance, so downstream nodes keep their cached results.
5. **Pure nodes.** `evaluate({ inputs, params, ctx })` MUST be deterministic and side-effect free (given the same `inputs`, `params` and, for volatile nodes, `ctx.time`). Its inputs have already been converted to the declared port types. `ctx` is `{ time, frame, nodeId }`.
6. **Time.** Nodes declared `volatile: true` depend on the current time (`setTime(time, frame?)`, time in seconds) and re-run when it changes. Nothing else does.
7. **Fault isolation.** A node that throws, returns the wrong shape or is of an unknown type produces an *error result* for that node only. Nodes that depend on it get `E_UPSTREAM` ("blocked"). Unrelated branches continue to evaluate. `evaluate(id)` returns the result either way (`status: 'ok' | 'error'`); `value(id, port)` throws the node's error if it failed.
8. **Statistics.** `stats` is `{ evaluations, reused }`: how many node functions ran and how many cached results were reused. The editor can show it, and the tests use it to prove incrementality.

Error codes that appear on node results: `E_UNKNOWN_NODE_TYPE`, `E_INPUT_MISSING`, `E_INPUT_INVALID`, `E_OUTPUT_MISSING`, `E_EVAL_FAILED` (the node's own code throws), `E_UPSTREAM` (blocked by another node's error). The scene layer reports the **root cause**, not the blocked node: following `E_UPSTREAM` back to the node that actually failed.

## 6. Serialized form

`graphs/<id>.graph.json`:

```json
{
  "edges": {
    "e1": { "from": { "node": "height", "port": "value" }, "id": "e1", "order": 0, "to": { "node": "half", "port": "a" } }
  },
  "id": "main",
  "name": "Main scene",
  "nodes": {
    "height": {
      "id": "height",
      "label": "Cube height",
      "params": {},
      "position": { "x": 0, "y": 0 },
      "type": "value.number",
      "values": { "value": 1 }
    }
  }
}
```

- `nodes` and `edges` are objects keyed by id, and the key MUST equal the contained `id`.
- `from` is always an **output** port, `to` always an **input** port.
- `order` gives multi-input ports their stable order.
- `values` and `params` contain only JSON values; keys named `__proto__` are rejected; non-finite numbers are rejected.
- Output is written with sorted keys, so graph files diff cleanly in git.

## 7. Compatibility

- **Unknown node types** (a plugin is missing, or the file came from a newer MekDeck) are preserved when loading and saving. They evaluate to `E_UNKNOWN_NODE_TYPE`, and `validate()` reports an error-level `unknown-node-type` diagnostic. The ports of such nodes cannot be judged, so connections to and from them are tolerated and kept.
- **Unknown inline values and params** on a known node (for example written by a newer version) are kept and reported as `unknown-input-value` or `unknown-param` warnings.
- Node type ids are permanent. A rename needs an alias mechanism and a format-version decision (see [CONTRIBUTING](../../CONTRIBUTING.md#changing-the-file-format)).

## 8. Diagnostics

`GraphDocument.validate()` returns diagnostics instead of throwing:

| Code | Severity | Meaning |
| --- | --- | --- |
| `unknown-node-type` | error | The node's type is not registered (is a plugin missing?) |
| `unknown-input-value` | warning | An inline value names a port the node type does not have |
| `unknown-param` | warning | A param the node type does not declare |
| `invalid-input-value` | error | An inline value has the wrong type |
| `invalid-param` | error | A param value is not allowed |
| `missing-input` | warning | An input has no edge, no value and no default (the node will fail when evaluated) |
| `type-mismatch` | error | An edge connects ports whose types cannot convert |
| `bad-edge` | error | An edge refers to a missing node or port, or connects a node to itself |
| `port-occupied` | error | More than one edge into a single-input port |
| `cycle` | error | The node is part of a cycle |

A diagnostic carries `node`, `edge` and `port` where they apply, so the editor can mark the exact place.

## 9. Error code reference (`@mekdeck/core`)

| Code | Meaning |
| --- | --- |
| `E_ID_INVALID` | An id does not match the allowed pattern |
| `E_NODE_INVALID` | A node is malformed (no type, bad position, bad label, forbidden key) |
| `E_NODE_EXISTS`, `E_NODE_MISSING` | Adding an id that exists / referring to one that does not |
| `E_NODE_HAS_EDGES` | Removing a node that still has edges |
| `E_NODE_TYPE_INVALID` | A node type definition is itself invalid (registration time) |
| `E_UNKNOWN_NODE_TYPE` | The type is not in the registry |
| `E_TYPE_DUPLICATE` | A data type id was registered twice |
| `E_EDGE_INVALID`, `E_EDGE_EXISTS`, `E_EDGE_MISSING` | Malformed / duplicate id / unknown edge |
| `E_DUPLICATE_EDGE` | The two ports are already connected |
| `E_PORT_MISSING`, `E_PORT_OCCUPIED` | No such port / input already connected |
| `E_SELF_CONNECTION`, `E_CYCLE`, `E_TYPE_MISMATCH` | Connection rules (section 3) |
| `E_VALUE_INVALID`, `E_PARAM_INVALID` | Bad inline value or param |
| `E_GRAPH_INVALID` | Loading graph data failed validation (message names the path) |
| `E_JSON_TYPE`, `E_JSON_KEY`, `E_JSON_NONFINITE`, `E_JSON_DEPTH` | A value is not plain JSON, has a forbidden key, is NaN/Infinity, or is nested too deeply |
| `E_INPUT_MISSING`, `E_INPUT_INVALID`, `E_OUTPUT_MISSING`, `E_EVAL_FAILED`, `E_UPSTREAM` | Evaluation results (section 5) |
| `E_HISTORY_DIVERGED` | Undo/redo refused because the document changed outside the history |

Scene layer (`@mekdeck/nodes`, `@mekdeck/scene`): `E_NO_SCENE_OUTPUT` (the graph has no `scene.output` node), `E_BAD_SCENE` (the output is not a valid scene). Code generation: `E_TARGET_UNSUPPORTED`, `E_CODEGEN_UNSUPPORTED`, `E_CODEGEN_NONFINITE`.

## 10. The standard library (24 node types)

| Category | Node types |
| --- | --- |
| Value | `value.number`, `value.vec3`, `value.color` |
| Math | `math.add`, `math.subtract`, `math.multiply`, `math.divide` (÷0 gives 0), `math.sine`, `math.cosine`, `math.time` (volatile) |
| Vector | `vector.combine`, `vector.separate` |
| Geometry | `scene.box`, `scene.sphere`, `scene.plane`, `scene.cylinder`, `scene.torus` |
| Material | `scene.standardMaterial` |
| Object | `scene.mesh`, `scene.group` |
| Light | `scene.directionalLight`, `scene.ambientLight` |
| Camera | `scene.perspectiveCamera` |
| Output | `scene.output` |

Each node's inputs, outputs and description live with its definition in [`library.ts`](../../packages/nodes/src/library.ts) and are the source for the in-app help.
