import { errorMessage, MekdeckError } from './errors.ts';
import type { ChangeEvent, EdgeData, GraphDocument, NodeData, NodeId } from './graph.ts';
import { deepEqual } from './json.ts';
import { resolveParams, type NodeRegistry, type NodeTypeDef } from './node-type.ts';

export interface EvalError {
  readonly code: string;
  readonly message: string;
  readonly nodeId: NodeId;
}

export type NodeResult =
  | { readonly status: 'ok'; readonly outputs: Readonly<Record<string, unknown>>; readonly version: number }
  | { readonly status: 'error'; readonly error: EvalError; readonly outputs: Readonly<Record<string, unknown>>; readonly version: number };

type Draft =
  | { readonly status: 'ok'; readonly outputs: Readonly<Record<string, unknown>> }
  | { readonly status: 'error'; readonly error: EvalError; readonly outputs: Readonly<Record<string, unknown>> };

interface Entry {
  result: NodeResult;
  /** `doc.nodeRevision` when computed. */
  rev: number;
  /** Time key for volatile nodes (empty for others). */
  timeKey: string;
  /** Result versions of the upstream nodes (aligned with `edgesTo`) when computed. */
  upstream: readonly number[];
  /** The evaluator epoch at which this entry was last confirmed up to date. */
  verifiedEpoch: number;
}

const NO_OUTPUTS: Readonly<Record<string, unknown>> = Object.freeze({});

function errorDraft(code: string, message: string, nodeId: NodeId): Draft {
  return { status: 'error', error: { code, message, nodeId }, outputs: NO_OUTPUTS };
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function draftsEqual(prev: NodeResult, next: Draft): boolean {
  if (prev.status !== next.status) return false;
  if (prev.status === 'error' && next.status === 'error') {
    return prev.error.code === next.error.code && prev.error.message === next.error.message;
  }
  const a = prev.outputs;
  const b = next.outputs;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && (Object.is(a[key], b[key]) || deepEqual(a[key], b[key])));
}

/**
 * Pull-based, incremental graph evaluator.
 *
 * - Only the upstream part of what you ask for is evaluated (lazy).
 * - Results are cached; after an edit only nodes whose inputs actually changed re-run.
 * - Early cutoff: if a node re-runs but produces the same outputs, nodes downstream of it
 *   are NOT re-run.
 * - Moving or renaming nodes never invalidates anything.
 * - Evaluation is iterative (no recursion), so very deep graphs cannot overflow the stack.
 * - A failing node does not stop the graph: it becomes an error result and nodes that
 *   depend on it are marked blocked, while unrelated branches keep working.
 */
export class Evaluator {
  readonly doc: GraphDocument;
  readonly stats = { evaluations: 0, reused: 0 };

  readonly #registry: NodeRegistry;
  readonly #entries = new Map<NodeId, Entry>();
  readonly #unsubscribe: () => void;
  #epoch = 1;
  #versionCounter = 0;
  #time: number;
  #frame: number;

  constructor(doc: GraphDocument, options: { time?: number; frame?: number } = {}) {
    this.doc = doc;
    this.#registry = doc.registry;
    this.#time = options.time ?? 0;
    this.#frame = options.frame ?? 0;
    this.#unsubscribe = doc.on((event) => this.#onChange(event));
  }

  dispose(): void {
    this.#unsubscribe();
    this.#entries.clear();
  }

  get time(): number {
    return this.#time;
  }

  /** Move the playhead. Only nodes marked `volatile` (and what depends on them) are affected. */
  setTime(time: number, frame: number = this.#frame): void {
    if (time === this.#time && frame === this.#frame) return;
    this.#time = time;
    this.#frame = frame;
    this.#epoch++;
  }

  evaluate(nodeId: NodeId): NodeResult {
    if (!this.doc.node(nodeId)) {
      throw new MekdeckError('E_NODE_MISSING', `Node "${nodeId}" does not exist`);
    }
    this.#verify(nodeId);
    return this.#entries.get(nodeId)!.result;
  }

  /** The value of one output; throws the node's error if it failed. */
  value(nodeId: NodeId, port: string): unknown {
    const result = this.evaluate(nodeId);
    if (result.status === 'error') {
      throw new MekdeckError(result.error.code, result.error.message, { nodeId: result.error.nodeId });
    }
    if (!Object.hasOwn(result.outputs, port)) {
      throw new MekdeckError('E_OUTPUT_MISSING', `Node "${nodeId}" has no output "${port}"`);
    }
    return result.outputs[port];
  }

  /** Evaluate every node (what the editor does to show previews and error badges). */
  evaluateAll(): Map<NodeId, NodeResult> {
    const all = new Map<NodeId, NodeResult>();
    for (const node of this.doc.nodes()) all.set(node.id, this.evaluate(node.id));
    return all;
  }

  #onChange(event: ChangeEvent): void {
    let semantic = false;
    for (const op of event.ops) {
      if (op.op === 'removeNode') this.#entries.delete(op.id);
      if (op.op !== 'moveNode' && op.op !== 'setLabel') semantic = true;
    }
    if (semantic) this.#epoch++;
  }

  /** Bring `root` and everything upstream of it up to date. */
  #verify(root: NodeId): void {
    const epoch = this.#epoch;
    if (this.#entries.get(root)?.verifiedEpoch === epoch) return;

    interface Frame {
      readonly id: NodeId;
      readonly preds: readonly NodeId[];
      next: number;
    }
    const frameFor = (id: NodeId): Frame => ({
      id,
      preds: [...new Set(this.doc.edgesTo(id).map((e) => e.from.node))],
      next: 0,
    });

    const state = new Map<NodeId, 1 | 2>(); // 1 = on the DFS stack, 2 = finished
    const order: NodeId[] = [];
    const cyclic = new Set<NodeId>();
    const stack: Frame[] = [frameFor(root)];
    state.set(root, 1);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.next < frame.preds.length) {
        const pred = frame.preds[frame.next++]!;
        if (!this.doc.node(pred)) continue;
        const seen = state.get(pred);
        if (seen === 2) continue;
        if (seen === 1) {
          for (let i = stack.findIndex((f) => f.id === pred); i < stack.length; i++) cyclic.add(stack[i]!.id);
          continue;
        }
        if (this.#entries.get(pred)?.verifiedEpoch === epoch) {
          state.set(pred, 2);
          continue;
        }
        state.set(pred, 1);
        stack.push(frameFor(pred));
      } else {
        stack.pop();
        state.set(frame.id, 2);
        order.push(frame.id);
      }
    }
    for (const id of order) this.#compute(id, cyclic.has(id));
  }

  #compute(id: NodeId, cyclic: boolean): void {
    const node = this.doc.node(id)!;
    const def = this.#registry.get(node.type);
    const rev = this.doc.nodeRevision(id);
    const prev = this.#entries.get(id);
    const edges = this.doc.edgesTo(id);
    const timeKey = def?.volatile ? `${this.#time}|${this.#frame}` : '';
    const upstream = edges.map((e) => this.#entries.get(e.from.node)?.result.version ?? 0);

    if (prev && !cyclic && prev.rev === rev && prev.timeKey === timeKey && sameNumbers(prev.upstream, upstream)) {
      prev.verifiedEpoch = this.#epoch;
      this.stats.reused++;
      return;
    }

    let draft: Draft;
    if (cyclic) draft = errorDraft('E_CYCLE', 'This node is part of a cycle', id);
    else if (!def) draft = errorDraft('E_UNKNOWN_NODE_TYPE', `Unknown node type "${node.type}"`, id);
    else draft = this.#run(node, def, edges);

    // Early cutoff: keep the old result object (and version) when nothing changed.
    const same = prev !== undefined && draftsEqual(prev.result, draft);
    const result: NodeResult = same ? prev.result : { ...draft, version: ++this.#versionCounter };
    this.#entries.set(id, { result, rev, timeKey, upstream, verifiedEpoch: this.#epoch });
  }

  #run(node: NodeData, def: NodeTypeDef, edges: readonly EdgeData[]): Draft {
    for (const edge of edges) {
      const upstream = this.#entries.get(edge.from.node)?.result;
      if (upstream?.status === 'error') {
        return errorDraft('E_UPSTREAM', `Blocked by an error in "${edge.from.node}": ${upstream.error.message}`, node.id);
      }
    }

    let inputs: Record<string, unknown>;
    try {
      inputs = this.#gatherInputs(node, def, edges);
    } catch (error) {
      const code = error instanceof MekdeckError ? error.code : 'E_INPUT_INVALID';
      return errorDraft(code, errorMessage(error), node.id);
    }

    this.stats.evaluations++;
    let outputs: unknown;
    try {
      outputs = def.evaluate({
        inputs,
        params: resolveParams(def, node.params),
        ctx: { time: this.#time, frame: this.#frame, nodeId: node.id },
      });
    } catch (error) {
      return errorDraft('E_EVAL_FAILED', errorMessage(error), node.id);
    }
    if (typeof outputs !== 'object' || outputs === null || Array.isArray(outputs)) {
      return errorDraft('E_EVAL_FAILED', `${def.label} must return an object of outputs`, node.id);
    }
    for (const name of Object.keys(def.outputs)) {
      if (!Object.hasOwn(outputs, name)) {
        return errorDraft('E_OUTPUT_MISSING', `${def.label} did not produce output "${name}"`, node.id);
      }
    }
    return { status: 'ok', outputs: Object.freeze({ ...(outputs as Record<string, unknown>) }) };
  }

  #gatherInputs(node: NodeData, def: NodeTypeDef, edges: readonly EdgeData[]): Record<string, unknown> {
    const byPort = new Map<string, EdgeData[]>();
    for (const edge of edges) {
      const list = byPort.get(edge.to.port);
      if (list) list.push(edge);
      else byPort.set(edge.to.port, [edge]);
    }
    const types = this.#registry.types;
    const inputs: Record<string, unknown> = {};

    for (const [name, port] of Object.entries(def.inputs)) {
      const connected = byPort.get(name);
      if (connected && connected.length > 0) {
        const values = connected.map((edge) => {
          const upstream = this.#entries.get(edge.from.node)!.result;
          if (!Object.hasOwn(upstream.outputs, edge.from.port)) {
            throw new MekdeckError('E_OUTPUT_MISSING', `Node "${edge.from.node}" has no output "${edge.from.port}"`);
          }
          const upstreamType = this.#registry.get(this.doc.node(edge.from.node)!.type)?.outputs[edge.from.port]?.type ?? 'any';
          return types.convert(upstreamType, port.type, upstream.outputs[edge.from.port]);
        });
        inputs[name] = port.multi ? values : values[0];
        continue;
      }
      const inline = Object.hasOwn(node.values, name) ? node.values[name] : undefined;
      const fallback = inline !== undefined ? inline : port.default;
      if (fallback !== undefined) {
        if (!types.check(port.type, fallback)) {
          throw new MekdeckError('E_INPUT_INVALID', `Value of "${name}" is not a valid ${port.type}`);
        }
        inputs[name] = fallback;
      } else if (port.multi) {
        inputs[name] = [];
      } else if (port.optional) {
        inputs[name] = undefined;
      } else {
        throw new MekdeckError('E_INPUT_MISSING', `Input "${name}" is not connected and has no value`);
      }
    }
    return inputs;
  }
}
