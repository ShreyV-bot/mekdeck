import { MekdeckError } from './errors.ts';
import { makeNode, type EdgeData, type GraphDocument, type NodeData, type NodeId, type NodePosition, type Op, type PortRef } from './graph.ts';
import type { JsonValue } from './json.ts';
import { validateParamValue } from './node-type.ts';

/**
 * "Planners" turn an intent ("connect A to B") into an operation, validating it first and
 * throwing a `MekdeckError` with a precise code if it is not allowed. They do not change
 * the document; pass the result to `doc.apply()` or `history.run()`.
 */

export interface AddNodeOptions {
  readonly id?: NodeId;
  readonly label?: string;
  readonly position?: NodePosition;
  readonly values?: Readonly<Record<string, JsonValue>>;
  readonly params?: Readonly<Record<string, JsonValue>>;
}

export function planAddNode(doc: GraphDocument, type: string, options: AddNodeOptions = {}): { op: Op; node: NodeData } {
  const def = doc.registry.get(type);
  if (!def) throw new MekdeckError('E_UNKNOWN_NODE_TYPE', `Unknown node type "${type}"`);

  for (const [port, value] of Object.entries(options.values ?? {})) {
    const portDef = Object.hasOwn(def.inputs, port) ? def.inputs[port] : undefined;
    if (!portDef) throw new MekdeckError('E_PORT_MISSING', `${def.label} has no input "${port}"`);
    if (!doc.registry.types.check(portDef.type, value)) {
      throw new MekdeckError('E_VALUE_INVALID', `Value of "${port}" is not a valid ${portDef.type}`);
    }
  }
  for (const [name, value] of Object.entries(options.params ?? {})) {
    const param = Object.hasOwn(def.params ?? {}, name) ? def.params![name] : undefined;
    if (!param) throw new MekdeckError('E_PARAM_INVALID', `${def.label} has no setting "${name}"`);
    if (!validateParamValue(param, value)) {
      throw new MekdeckError('E_PARAM_INVALID', `Setting "${name}" of ${def.label} has an invalid value`);
    }
  }
  const node = makeNode({ ...options, id: options.id ?? doc.newNodeId(), type });
  return { op: { op: 'addNode', node }, node };
}

/** Removes a node together with every edge attached to it. */
export function planRemoveNode(doc: GraphDocument, id: NodeId): Op {
  if (!doc.node(id)) throw new MekdeckError('E_NODE_MISSING', `Node "${id}" does not exist`);
  const attached = new Map<string, EdgeData>();
  for (const edge of [...doc.edgesTo(id), ...doc.edgesFrom(id)]) attached.set(edge.id, edge);
  return {
    op: 'batch',
    ops: [...[...attached.keys()].map((edgeId) => ({ op: 'removeEdge' as const, id: edgeId })), { op: 'removeNode', id }],
  };
}

/**
 * Connects two ports. On a single-input port that is already connected, the old edge is
 * replaced in the same batch (so one undo restores it).
 */
export function planConnect(doc: GraphDocument, from: PortRef, to: PortRef): { op: Op; edge: EdgeData } {
  const check = doc.checkConnection(from, to, { replace: true });
  if (!check.ok) throw new MekdeckError(check.code, check.message);

  const targetDef = doc.registry.get(doc.node(to.node)!.type);
  const multi = targetDef ? (targetDef.inputs[to.port]?.multi ?? false) : true;
  const replaced = multi ? [] : doc.edgesTo(to.node, to.port);

  const edge: EdgeData = { id: doc.newEdgeId(), from, to, order: doc.nextEdgeOrder() };
  return {
    op: {
      op: 'batch',
      ops: [...replaced.map((e) => ({ op: 'removeEdge' as const, id: e.id })), { op: 'addEdge', edge }],
    },
    edge,
  };
}

export function planDisconnect(doc: GraphDocument, edgeId: string): Op {
  if (!doc.edge(edgeId)) throw new MekdeckError('E_EDGE_MISSING', `Edge "${edgeId}" does not exist`);
  return { op: 'removeEdge', id: edgeId };
}

/** Set (or with `undefined`, clear) the inline value of an input port. */
export function planSetValue(doc: GraphDocument, node: NodeId, port: string, value: JsonValue | undefined): Op {
  const data = doc.node(node);
  if (!data) throw new MekdeckError('E_NODE_MISSING', `Node "${node}" does not exist`);
  const def = doc.registry.get(data.type);
  if (def) {
    const portDef = Object.hasOwn(def.inputs, port) ? def.inputs[port] : undefined;
    if (!portDef) throw new MekdeckError('E_PORT_MISSING', `${def.label} has no input "${port}"`);
    if (value !== undefined && !doc.registry.types.check(portDef.type, value)) {
      throw new MekdeckError('E_VALUE_INVALID', `Value of "${port}" is not a valid ${portDef.type}`);
    }
  }
  return { op: 'setValue', node, port, ...(value !== undefined ? { value } : {}) };
}

export function planSetParam(doc: GraphDocument, node: NodeId, name: string, value: JsonValue | undefined): Op {
  const data = doc.node(node);
  if (!data) throw new MekdeckError('E_NODE_MISSING', `Node "${node}" does not exist`);
  const def = doc.registry.get(data.type);
  if (def) {
    const param = Object.hasOwn(def.params ?? {}, name) ? def.params![name] : undefined;
    if (!param) throw new MekdeckError('E_PARAM_INVALID', `${def.label} has no setting "${name}"`);
    if (value !== undefined && !validateParamValue(param, value)) {
      throw new MekdeckError('E_PARAM_INVALID', `Setting "${name}" of ${def.label} has an invalid value`);
    }
  }
  return { op: 'setParam', node, name, ...(value !== undefined ? { value } : {}) };
}

export function planMoveNode(doc: GraphDocument, node: NodeId, position: NodePosition): Op {
  if (!doc.node(node)) throw new MekdeckError('E_NODE_MISSING', `Node "${node}" does not exist`);
  return { op: 'moveNode', node, position };
}

export function planSetLabel(doc: GraphDocument, node: NodeId, label: string | undefined): Op {
  if (!doc.node(node)) throw new MekdeckError('E_NODE_MISSING', `Node "${node}" does not exist`);
  return { op: 'setLabel', node, ...(label !== undefined ? { label } : {}) };
}
