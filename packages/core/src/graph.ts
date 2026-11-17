import type { Diagnostic } from './diagnostics.ts';
import { Emitter } from './emitter.ts';
import { MekdeckError } from './errors.ts';
import { ID_PATTERN, randomIds, type IdGenerator } from './ids.ts';
import { assertJson, deepEqual, isPlainObject, type JsonValue } from './json.ts';
import { validateParamValue, type NodeRegistry } from './node-type.ts';

export type NodeId = string;
export type EdgeId = string;

export interface NodePosition {
  readonly x: number;
  readonly y: number;
}

export interface PortRef {
  readonly node: NodeId;
  readonly port: string;
}

/** One node. Immutable: every change produces a new object (cheap undo, safe sharing). */
export interface NodeData {
  readonly id: NodeId;
  /** Node type id from the registry, e.g. `math.add`. May be unknown if a plugin is missing. */
  readonly type: string;
  readonly label?: string;
  /** Editor canvas position. Moving a node never invalidates evaluation. */
  readonly position: NodePosition;
  /** Inline values for unconnected input ports, keyed by port name. */
  readonly values: Readonly<Record<string, JsonValue>>;
  /** Static settings (dropdowns, toggles), keyed by param name. */
  readonly params: Readonly<Record<string, JsonValue>>;
}

export interface EdgeData {
  readonly id: EdgeId;
  readonly from: PortRef;
  readonly to: PortRef;
  /** Creation order; gives multi-input ports a deterministic, stable ordering. */
  readonly order: number;
}

/** The serializable form of a graph (what is stored in `graphs/<id>.graph.json`). */
export interface GraphData {
  readonly id: string;
  readonly name: string;
  readonly nodes: Readonly<Record<NodeId, NodeData>>;
  readonly edges: Readonly<Record<EdgeId, EdgeData>>;
}

// ---------------------------------------------------------------------------
// Operations: every change to a document is data. That is what makes undo/redo,
// scripting and (later) collaboration possible with one mechanism.
// ---------------------------------------------------------------------------

export type PrimitiveOp =
  | { readonly op: 'addNode'; readonly node: NodeData }
  | { readonly op: 'removeNode'; readonly id: NodeId }
  | { readonly op: 'addEdge'; readonly edge: EdgeData }
  | { readonly op: 'removeEdge'; readonly id: EdgeId }
  | { readonly op: 'setValue'; readonly node: NodeId; readonly port: string; readonly value?: JsonValue }
  | { readonly op: 'setParam'; readonly node: NodeId; readonly name: string; readonly value?: JsonValue }
  | { readonly op: 'moveNode'; readonly node: NodeId; readonly position: NodePosition }
  | { readonly op: 'setLabel'; readonly node: NodeId; readonly label?: string };

export interface BatchOp {
  readonly op: 'batch';
  readonly ops: readonly Op[];
}

export type Op = PrimitiveOp | BatchOp;

export type ChangeOrigin = 'local' | 'undo' | 'redo' | 'remote';

export interface ChangeEvent {
  readonly origin: ChangeOrigin;
  /** Flattened primitive operations that were applied, in order. */
  readonly ops: readonly PrimitiveOp[];
  /** One operation that exactly reverses this change. */
  readonly inverse: Op;
}

export type ConnectionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

const PORT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EMPTY: readonly EdgeData[] = Object.freeze([]);

export interface NodeInit {
  readonly id: NodeId;
  readonly type: string;
  readonly label?: string;
  readonly position?: NodePosition;
  readonly values?: Readonly<Record<string, JsonValue>>;
  readonly params?: Readonly<Record<string, JsonValue>>;
}

/** Validate and freeze a node. */
export function makeNode(init: NodeInit): NodeData {
  if (!ID_PATTERN.test(init.id)) {
    throw new MekdeckError('E_ID_INVALID', `Invalid node id "${init.id}" (use letters, digits, _ or -, max 64)`);
  }
  if (typeof init.type !== 'string' || init.type === '') {
    throw new MekdeckError('E_NODE_INVALID', `Node "${init.id}" needs a type`);
  }
  const position = init.position ?? { x: 0, y: 0 };
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new MekdeckError('E_NODE_INVALID', `Node "${init.id}" has a non-finite position`);
  }
  if (init.label !== undefined && typeof init.label !== 'string') {
    throw new MekdeckError('E_NODE_INVALID', `Node "${init.id}" label must be a string`);
  }
  const values = { ...(init.values ?? {}) };
  const params = { ...(init.params ?? {}) };
  for (const [bag, entries] of [['values', values], ['params', params]] as const) {
    for (const [key, value] of Object.entries(entries)) {
      // A "__proto__" key would be harmless as data but dangerous the moment anything copies it into a plain object.
      if (key === '__proto__') {
        throw new MekdeckError('E_NODE_INVALID', `Node "${init.id}": the key "__proto__" is not allowed in ${bag}`);
      }
      assertJson(value, `${bag}.${key}`);
    }
  }
  return Object.freeze({
    id: init.id,
    type: init.type,
    ...(init.label !== undefined ? { label: init.label } : {}),
    position: Object.freeze({ x: position.x, y: position.y }),
    values: Object.freeze(values),
    params: Object.freeze(params),
  });
}

function makeEdge(edge: EdgeData): EdgeData {
  if (!ID_PATTERN.test(edge.id)) {
    throw new MekdeckError('E_ID_INVALID', `Invalid edge id "${edge.id}"`);
  }
  for (const end of [edge.from, edge.to]) {
    if (!ID_PATTERN.test(end.node) || !PORT_PATTERN.test(end.port) || end.port === '__proto__') {
      throw new MekdeckError('E_EDGE_INVALID', `Edge "${edge.id}" has an invalid endpoint`);
    }
  }
  if (!Number.isFinite(edge.order)) {
    throw new MekdeckError('E_EDGE_INVALID', `Edge "${edge.id}" has a non-finite order`);
  }
  return Object.freeze({
    id: edge.id,
    from: Object.freeze({ node: edge.from.node, port: edge.from.port }),
    to: Object.freeze({ node: edge.to.node, port: edge.to.port }),
    order: edge.order,
  });
}

function compareEdges(a: EdgeData, b: EdgeData): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function withEdge(list: readonly EdgeData[], edge: EdgeData): readonly EdgeData[] {
  return [...list, edge].sort(compareEdges);
}

function withoutEdge(list: readonly EdgeData[], id: EdgeId): readonly EdgeData[] {
  return list.filter((e) => e.id !== id);
}

/**
 * Validate untrusted data (for example a parsed `.graph.json` file) into GraphData.
 * Structural problems throw `E_GRAPH_INVALID`. Semantic problems (unknown node types,
 * type mismatches, cycles) are NOT errors here; `GraphDocument.validate()` reports them,
 * so a graph that uses a missing plugin still opens and is saved back without loss.
 */
export function parseGraphData(raw: unknown): GraphData {
  function bad(path: string, message: string): never {
    throw new MekdeckError('E_GRAPH_INVALID', `Invalid graph at ${path}: ${message}`);
  }
  if (!isPlainObject(raw)) return bad('$', 'expected an object');
  const id = raw.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return bad('id', 'expected an id (letters, digits, _ or -)');
  const name = raw.name ?? '';
  if (typeof name !== 'string') return bad('name', 'expected a string');
  const rawNodes = raw.nodes;
  if (!isPlainObject(rawNodes)) return bad('nodes', 'expected an object');
  const rawEdges = raw.edges ?? {};
  if (!isPlainObject(rawEdges)) return bad('edges', 'expected an object');

  const nodes: Record<NodeId, NodeData> = {};
  for (const [key, value] of Object.entries(rawNodes)) {
    const at = `nodes.${key}`;
    if (!isPlainObject(value)) return bad(at, 'expected an object');
    if (value.id !== key) return bad(`${at}.id`, 'must equal its key');
    if (typeof value.type !== 'string' || value.type === '') return bad(`${at}.type`, 'expected a node type string');
    const pos = value.position;
    if (!isPlainObject(pos) || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
      return bad(`${at}.position`, 'expected { x: number, y: number }');
    }
    if (value.label !== undefined && typeof value.label !== 'string') return bad(`${at}.label`, 'expected a string');
    const values = value.values ?? {};
    const params = value.params ?? {};
    if (!isPlainObject(values)) return bad(`${at}.values`, 'expected an object');
    if (!isPlainObject(params)) return bad(`${at}.params`, 'expected an object');
    try {
      nodes[key] = makeNode({
        id: key,
        type: value.type,
        ...(value.label !== undefined ? { label: value.label } : {}),
        position: { x: pos.x, y: pos.y },
        values: values as Record<string, JsonValue>,
        params: params as Record<string, JsonValue>,
      });
    } catch (error) {
      return bad(at, error instanceof Error ? error.message : String(error));
    }
  }

  const edges: Record<EdgeId, EdgeData> = {};
  for (const [key, value] of Object.entries(rawEdges)) {
    const at = `edges.${key}`;
    if (!isPlainObject(value)) return bad(at, 'expected an object');
    if (value.id !== key) return bad(`${at}.id`, 'must equal its key');
    const ends: PortRef[] = [];
    for (const side of ['from', 'to'] as const) {
      const end = value[side];
      if (!isPlainObject(end) || typeof end.node !== 'string' || typeof end.port !== 'string') {
        return bad(`${at}.${side}`, 'expected { node: string, port: string }');
      }
      if (!Object.hasOwn(nodes, end.node)) return bad(`${at}.${side}`, `refers to missing node "${end.node}"`);
      ends.push({ node: end.node, port: end.port });
    }
    if (typeof value.order !== 'number') return bad(`${at}.order`, 'expected a number');
    try {
      edges[key] = makeEdge({ id: key, from: ends[0]!, to: ends[1]!, order: value.order });
    } catch (error) {
      return bad(at, error instanceof Error ? error.message : String(error));
    }
  }
  return { id, name, nodes, edges };
}

export interface GraphDocumentOptions {
  readonly id?: string;
  readonly name?: string;
  readonly ids?: IdGenerator;
}

/**
 * A node graph. All state changes go through `apply(op)`, which is atomic, emits one
 * `change` event, and returns the inverse operation. Higher-level conveniences live in
 * `commands.ts` and `editor.ts`.
 */
export class GraphDocument {
  readonly id: string;
  name: string;
  readonly registry: NodeRegistry;

  readonly #nodes = new Map<NodeId, NodeData>();
  readonly #edges = new Map<EdgeId, EdgeData>();
  readonly #in = new Map<NodeId, readonly EdgeData[]>();
  readonly #out = new Map<NodeId, readonly EdgeData[]>();
  readonly #rev = new Map<NodeId, number>();
  readonly #events = new Emitter<ChangeEvent>();
  readonly #ids: IdGenerator;
  #version = 0;
  #revCounter = 0;
  #nextOrder = 1;

  constructor(registry: NodeRegistry, options: GraphDocumentOptions = {}) {
    this.registry = registry;
    this.#ids = options.ids ?? randomIds;
    this.id = options.id ?? this.#ids('g');
    if (!ID_PATTERN.test(this.id)) {
      throw new MekdeckError('E_ID_INVALID', `Invalid graph id "${this.id}"`);
    }
    this.name = options.name ?? 'Untitled';
  }

  /** Load a document from untrusted data. See `parseGraphData` for what is checked. */
  static fromData(registry: NodeRegistry, raw: unknown, options: Pick<GraphDocumentOptions, 'ids'> = {}): GraphDocument {
    const data = parseGraphData(raw);
    const doc = new GraphDocument(registry, { id: data.id, name: data.name, ...options });
    for (const node of Object.values(data.nodes)) {
      doc.#nodes.set(node.id, node);
      doc.#bump(node.id);
    }
    for (const edge of Object.values(data.edges)) doc.#indexEdge(edge);
    return doc;
  }

  // ----- queries ---------------------------------------------------------

  /** Increases on every applied change. */
  get version(): number {
    return this.#version;
  }

  /**
   * Changes whenever anything that affects the node's *result* changes (its values,
   * params, or incoming edges). Does not change when the node is merely moved or renamed.
   */
  nodeRevision(id: NodeId): number {
    return this.#rev.get(id) ?? 0;
  }

  get nodeCount(): number {
    return this.#nodes.size;
  }

  get edgeCount(): number {
    return this.#edges.size;
  }

  node(id: NodeId): NodeData | undefined {
    return this.#nodes.get(id);
  }

  nodes(): IterableIterator<NodeData> {
    return this.#nodes.values();
  }

  edge(id: EdgeId): EdgeData | undefined {
    return this.#edges.get(id);
  }

  edges(): IterableIterator<EdgeData> {
    return this.#edges.values();
  }

  /** Incoming edges, ordered by creation order. Optionally only those into `port`. */
  edgesTo(node: NodeId, port?: string): readonly EdgeData[] {
    const all = this.#in.get(node) ?? EMPTY;
    return port === undefined ? all : all.filter((e) => e.to.port === port);
  }

  /** Outgoing edges, ordered by creation order. Optionally only those from `port`. */
  edgesFrom(node: NodeId, port?: string): readonly EdgeData[] {
    const all = this.#out.get(node) ?? EMPTY;
    return port === undefined ? all : all.filter((e) => e.from.port === port);
  }

  /** A fresh, unused node id. */
  newNodeId(): NodeId {
    let id: string;
    do id = this.#ids('n');
    while (this.#nodes.has(id));
    return id;
  }

  /** A fresh, unused edge id. */
  newEdgeId(): EdgeId {
    let id: string;
    do id = this.#ids('e');
    while (this.#edges.has(id));
    return id;
  }

  /** The `order` to give the next edge created. */
  nextEdgeOrder(): number {
    return this.#nextOrder;
  }

  toJSON(): GraphData {
    return {
      id: this.id,
      name: this.name,
      nodes: Object.fromEntries(this.#nodes),
      edges: Object.fromEntries(this.#edges),
    };
  }

  on(listener: (event: ChangeEvent) => void): () => void {
    return this.#events.subscribe(listener);
  }

  // ----- connection rules ---------------------------------------------------

  /**
   * Would this connection be allowed? Used by `apply` and by editors for live feedback
   * while dragging a wire. With `replace`, an occupied single-input port is acceptable
   * because the caller will remove the old edge in the same batch.
   */
  checkConnection(from: PortRef, to: PortRef, options: { replace?: boolean } = {}): ConnectionCheck {
    const endpoints = this.#checkEndpoints(from, to);
    if (!endpoints.ok) return endpoints;

    if (this.edgesTo(to.node, to.port).some((e) => e.from.node === from.node && e.from.port === from.port)) {
      return fail('E_DUPLICATE_EDGE', 'These ports are already connected');
    }
    const targetDef = this.registry.get(this.#nodes.get(to.node)!.type);
    const targetPort = targetDef?.inputs[to.port];
    if (!options.replace && targetPort && !targetPort.multi && this.edgesTo(to.node, to.port).length > 0) {
      return fail('E_PORT_OCCUPIED', `Input "${to.port}" is already connected`);
    }
    if (this.#reaches(to.node, from.node)) {
      return fail('E_CYCLE', 'This connection would create a cycle');
    }
    return { ok: true };
  }

  #checkEndpoints(from: PortRef, to: PortRef): ConnectionCheck {
    const source = this.#nodes.get(from.node);
    const target = this.#nodes.get(to.node);
    if (!source) return fail('E_NODE_MISSING', `Node "${from.node}" does not exist`);
    if (!target) return fail('E_NODE_MISSING', `Node "${to.node}" does not exist`);
    if (from.node === to.node) return fail('E_SELF_CONNECTION', 'A node cannot connect to itself');

    const sourceDef = this.registry.get(source.type);
    const targetDef = this.registry.get(target.type);
    // Unknown node types (missing plugin) are tolerated: we cannot judge their ports.
    const out = sourceDef && (Object.hasOwn(sourceDef.outputs, from.port) ? sourceDef.outputs[from.port] : null);
    const inn = targetDef && (Object.hasOwn(targetDef.inputs, to.port) ? targetDef.inputs[to.port] : null);
    if (out === null) return fail('E_PORT_MISSING', `${sourceDef!.label} has no output "${from.port}"`);
    if (inn === null) return fail('E_PORT_MISSING', `${targetDef!.label} has no input "${to.port}"`);
    if (out && inn && !this.registry.types.canConnect(out.type, inn.type)) {
      return fail('E_TYPE_MISMATCH', `Cannot connect ${out.type} to ${inn.type}`);
    }
    return { ok: true };
  }

  /** Is `target` reachable by following edges downstream from `start` (or equal to it)? */
  #reaches(start: NodeId, target: NodeId): boolean {
    if (start === target) return true;
    const seen = new Set<NodeId>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const edge of this.#out.get(current) ?? EMPTY) {
        const next = edge.to.node;
        if (next === target) return true;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  }

  // ----- mutation -----------------------------------------------------------

  /**
   * Apply an operation atomically. If any part of a batch fails, everything already
   * applied is rolled back, the error is rethrown, and no event is emitted.
   * Returns the inverse operation.
   */
  apply(op: Op, origin: ChangeOrigin = 'local'): Op {
    const applied: PrimitiveOp[] = [];
    const inverses: PrimitiveOp[] = [];
    try {
      this.#applyInto(op, applied, inverses);
    } catch (error) {
      for (let i = inverses.length - 1; i >= 0; i--) this.#applyPrimitive(inverses[i]!);
      throw error;
    }
    const reversed = inverses.reverse();
    const inverse: Op = reversed.length === 1 ? reversed[0]! : { op: 'batch', ops: reversed };
    if (applied.length > 0) {
      this.#version++;
      this.#events.emit({ origin, ops: applied, inverse });
    }
    return inverse;
  }

  #applyInto(op: Op, applied: PrimitiveOp[], inverses: PrimitiveOp[]): void {
    if (op.op === 'batch') {
      for (const child of op.ops) this.#applyInto(child, applied, inverses);
      return;
    }
    inverses.push(this.#applyPrimitive(op));
    applied.push(op);
  }

  #bump(id: NodeId): void {
    this.#rev.set(id, ++this.#revCounter);
  }

  #indexEdge(edge: EdgeData): void {
    this.#edges.set(edge.id, edge);
    this.#in.set(edge.to.node, withEdge(this.#in.get(edge.to.node) ?? EMPTY, edge));
    this.#out.set(edge.from.node, withEdge(this.#out.get(edge.from.node) ?? EMPTY, edge));
    if (edge.order >= this.#nextOrder) this.#nextOrder = Math.floor(edge.order) + 1;
    this.#bump(edge.to.node);
  }

  #unindexEdge(edge: EdgeData): void {
    this.#edges.delete(edge.id);
    this.#in.set(edge.to.node, withoutEdge(this.#in.get(edge.to.node) ?? EMPTY, edge.id));
    this.#out.set(edge.from.node, withoutEdge(this.#out.get(edge.from.node) ?? EMPTY, edge.id));
    this.#bump(edge.to.node);
  }

  #requireNode(id: NodeId): NodeData {
    const node = this.#nodes.get(id);
    if (!node) throw new MekdeckError('E_NODE_MISSING', `Node "${id}" does not exist`);
    return node;
  }

  #replaceNode(next: NodeData, semantic: boolean): void {
    this.#nodes.set(next.id, next);
    if (semantic) this.#bump(next.id);
  }

  /** Applies one primitive operation and returns its exact inverse. */
  #applyPrimitive(op: PrimitiveOp): PrimitiveOp {
    switch (op.op) {
      case 'addNode': {
        if (this.#nodes.has(op.node.id)) {
          throw new MekdeckError('E_NODE_EXISTS', `Node "${op.node.id}" already exists`);
        }
        const node = makeNode(op.node);
        this.#nodes.set(node.id, node);
        this.#bump(node.id);
        return { op: 'removeNode', id: node.id };
      }
      case 'removeNode': {
        const node = this.#requireNode(op.id);
        if (this.edgesTo(op.id).length > 0 || this.edgesFrom(op.id).length > 0) {
          throw new MekdeckError('E_NODE_HAS_EDGES', `Node "${op.id}" still has connections; remove them first`);
        }
        this.#nodes.delete(op.id);
        this.#in.delete(op.id);
        this.#out.delete(op.id);
        this.#rev.delete(op.id);
        return { op: 'addNode', node };
      }
      case 'addEdge': {
        const edge = makeEdge(op.edge);
        if (this.#edges.has(edge.id)) {
          throw new MekdeckError('E_EDGE_EXISTS', `Edge "${edge.id}" already exists`);
        }
        const check = this.checkConnection(edge.from, edge.to);
        if (!check.ok) throw new MekdeckError(check.code, check.message);
        this.#indexEdge(edge);
        return { op: 'removeEdge', id: edge.id };
      }
      case 'removeEdge': {
        const edge = this.#edges.get(op.id);
        if (!edge) throw new MekdeckError('E_EDGE_MISSING', `Edge "${op.id}" does not exist`);
        this.#unindexEdge(edge);
        return { op: 'addEdge', edge };
      }
      case 'setValue': {
        const node = this.#requireNode(op.node);
        if (op.port === '__proto__') throw new MekdeckError('E_PORT_MISSING', 'Invalid port name');
        if (op.value !== undefined) assertJson(op.value, `values.${op.port}`);
        const previous = Object.hasOwn(node.values, op.port) ? node.values[op.port] : undefined;
        const values: Record<string, JsonValue> = { ...node.values };
        if (op.value === undefined) delete values[op.port];
        else values[op.port] = op.value;
        this.#replaceNode(makeNode({ ...node, values }), true);
        return { op: 'setValue', node: op.node, port: op.port, ...(previous !== undefined ? { value: previous } : {}) };
      }
      case 'setParam': {
        const node = this.#requireNode(op.node);
        if (op.name === '__proto__') throw new MekdeckError('E_PARAM_INVALID', 'Invalid param name');
        if (op.value !== undefined) assertJson(op.value, `params.${op.name}`);
        const previous = Object.hasOwn(node.params, op.name) ? node.params[op.name] : undefined;
        const params: Record<string, JsonValue> = { ...node.params };
        if (op.value === undefined) delete params[op.name];
        else params[op.name] = op.value;
        this.#replaceNode(makeNode({ ...node, params }), true);
        return { op: 'setParam', node: op.node, name: op.name, ...(previous !== undefined ? { value: previous } : {}) };
      }
      case 'moveNode': {
        const node = this.#requireNode(op.node);
        this.#replaceNode(makeNode({ ...node, position: op.position }), false);
        return { op: 'moveNode', node: op.node, position: node.position };
      }
      case 'setLabel': {
        const node = this.#requireNode(op.node);
        const { label: previous, ...rest } = node;
        this.#replaceNode(makeNode({ ...rest, ...(op.label !== undefined ? { label: op.label } : {}) }), false);
        return { op: 'setLabel', node: op.node, ...(previous !== undefined ? { label: previous } : {}) };
      }
    }
  }

  // ----- validation ---------------------------------------------------------

  /** Semantic checks that do not stop a graph from loading. */
  validate(): Diagnostic[] {
    const out: Diagnostic[] = [];
    const types = this.registry.types;

    for (const node of this.#nodes.values()) {
      const def = this.registry.get(node.type);
      if (!def) {
        out.push({ severity: 'error', code: 'unknown-node-type', message: `Unknown node type "${node.type}" (is a plugin missing?)`, node: node.id });
        continue;
      }
      for (const [port, value] of Object.entries(node.values)) {
        const portDef = Object.hasOwn(def.inputs, port) ? def.inputs[port] : undefined;
        if (!portDef) {
          out.push({ severity: 'warning', code: 'unknown-input-value', message: `${def.label} has no input "${port}"`, node: node.id, port });
        } else if (!types.check(portDef.type, value)) {
          out.push({ severity: 'error', code: 'invalid-input-value', message: `Value of "${port}" is not a valid ${portDef.type}`, node: node.id, port });
        }
      }
      for (const [name, value] of Object.entries(node.params)) {
        const param = Object.hasOwn(def.params ?? {}, name) ? def.params![name] : undefined;
        if (!param) {
          out.push({ severity: 'warning', code: 'unknown-param', message: `${def.label} has no setting "${name}"`, node: node.id });
        } else if (!validateParamValue(param, value)) {
          out.push({ severity: 'error', code: 'invalid-param', message: `Setting "${name}" has an invalid value`, node: node.id });
        }
      }
      const connected = new Set(this.edgesTo(node.id).map((e) => e.to.port));
      for (const [port, portDef] of Object.entries(def.inputs)) {
        if (connected.has(port) || portDef.multi || portDef.optional) continue;
        if (node.values[port] !== undefined || portDef.default !== undefined) continue;
        out.push({ severity: 'warning', code: 'missing-input', message: `${def.label}: input "${port}" is not connected and has no value`, node: node.id, port });
      }
    }

    const perPort = new Map<string, number>();
    for (const edge of this.#edges.values()) {
      const check = this.#checkEndpoints(edge.from, edge.to);
      if (!check.ok) {
        out.push({ severity: 'error', code: check.code === 'E_TYPE_MISMATCH' ? 'type-mismatch' : 'bad-edge', message: check.message, edge: edge.id, node: edge.to.node, port: edge.to.port });
      }
      const key = `${edge.to.node}\u0000${edge.to.port}`;
      perPort.set(key, (perPort.get(key) ?? 0) + 1);
    }
    for (const edge of this.#edges.values()) {
      const key = `${edge.to.node}\u0000${edge.to.port}`;
      const def = this.registry.get(this.#nodes.get(edge.to.node)!.type);
      if ((perPort.get(key) ?? 0) > 1 && def && Object.hasOwn(def.inputs, edge.to.port) && !def.inputs[edge.to.port]!.multi) {
        out.push({ severity: 'error', code: 'port-occupied', message: `Input "${edge.to.port}" has several connections but accepts one`, edge: edge.id, node: edge.to.node, port: edge.to.port });
      }
    }

    for (const id of this.#cyclicNodes()) {
      out.push({ severity: 'error', code: 'cycle', message: 'Node is part of a cycle', node: id });
    }
    return out;
  }

  /** Nodes that remain after repeatedly removing nodes with no unresolved inputs (Kahn). */
  #cyclicNodes(): NodeId[] {
    const indegree = new Map<NodeId, number>();
    for (const id of this.#nodes.keys()) indegree.set(id, this.edgesTo(id).length);
    const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
    let processed = 0;
    while (queue.length > 0) {
      const id = queue.pop()!;
      processed++;
      for (const edge of this.edgesFrom(id)) {
        const left = (indegree.get(edge.to.node) ?? 0) - 1;
        indegree.set(edge.to.node, left);
        if (left === 0) queue.push(edge.to.node);
      }
    }
    if (processed === this.#nodes.size) return [];
    return [...indegree].filter(([, n]) => n > 0).map(([id]) => id);
  }

  /** True if two documents hold identical graph data. */
  equals(other: GraphDocument): boolean {
    return deepEqual(this.toJSON(), other.toJSON());
  }
}

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}
