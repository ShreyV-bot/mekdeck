import {
  planAddNode,
  planConnect,
  planDisconnect,
  planMoveNode,
  planRemoveNode,
  planSetLabel,
  planSetParam,
  planSetValue,
  type AddNodeOptions,
} from './commands.ts';
import type { EdgeData, EdgeId, GraphDocument, NodeData, NodeId, NodePosition, PortRef } from './graph.ts';
import { History } from './history.ts';
import type { JsonValue } from './json.ts';

/**
 * The friendly, undoable API used by the editor UI, the scripting layer and the CLI.
 * Every method validates first, applies atomically, and records one undo step.
 */
export class GraphEditor {
  readonly doc: GraphDocument;
  readonly history: History;

  constructor(doc: GraphDocument, history: History = new History(doc)) {
    this.doc = doc;
    this.history = history;
  }

  addNode(type: string, options: AddNodeOptions = {}): NodeData {
    const { op, node } = planAddNode(this.doc, type, options);
    const label = this.doc.registry.get(type)?.label ?? type;
    this.history.run(op, { label: `Add ${label}` });
    return node;
  }

  removeNode(id: NodeId): void {
    this.history.run(planRemoveNode(this.doc, id), { label: 'Delete node' });
  }

  connect(from: PortRef, to: PortRef): EdgeData {
    const { op, edge } = planConnect(this.doc, from, to);
    this.history.run(op, { label: 'Connect' });
    return edge;
  }

  disconnect(edgeId: EdgeId): void {
    this.history.run(planDisconnect(this.doc, edgeId), { label: 'Disconnect' });
  }

  /** `coalesce: true` merges rapid consecutive edits (a slider drag) into one undo step. */
  setValue(node: NodeId, port: string, value: JsonValue | undefined, options: { coalesce?: boolean } = {}): void {
    this.history.run(planSetValue(this.doc, node, port, value), {
      label: 'Change value',
      ...(options.coalesce ? { coalesceKey: `value:${node}:${port}` } : {}),
    });
  }

  setParam(node: NodeId, name: string, value: JsonValue | undefined, options: { coalesce?: boolean } = {}): void {
    this.history.run(planSetParam(this.doc, node, name, value), {
      label: 'Change setting',
      ...(options.coalesce ? { coalesceKey: `param:${node}:${name}` } : {}),
    });
  }

  moveNode(node: NodeId, position: NodePosition, options: { coalesce?: boolean } = {}): void {
    this.history.run(planMoveNode(this.doc, node, position), {
      label: 'Move node',
      ...(options.coalesce ? { coalesceKey: `move:${node}` } : {}),
    });
  }

  rename(node: NodeId, label: string | undefined): void {
    this.history.run(planSetLabel(this.doc, node, label), { label: 'Rename node' });
  }

  transaction<T>(label: string, fn: () => T): T {
    return this.history.transaction(label, fn);
  }

  undo(): boolean {
    return this.history.undo();
  }

  redo(): boolean {
    return this.history.redo();
  }
}
