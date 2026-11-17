import { TypeRegistry } from './datatypes.ts';
import { MekdeckError } from './errors.ts';
import type { JsonValue } from './json.ts';

export interface PortDef {
  /** Id of a data type registered in the TypeRegistry. */
  readonly type: string;
  readonly label?: string;
  readonly description?: string;
  /** Value used when the input is unconnected and the node has no inline value. */
  readonly default?: JsonValue;
  /** Inputs only: accepts many connections; the node receives an array. */
  readonly multi?: boolean;
  /** Inputs only: may stay unconnected without a default (the node receives `undefined`). */
  readonly optional?: boolean;
}

/** Static node settings (dropdowns, toggles). Unlike ports they cannot be wired. */
export type ParamDef =
  | { readonly type: 'number'; readonly default: number; readonly min?: number; readonly max?: number; readonly step?: number; readonly label?: string }
  | { readonly type: 'boolean'; readonly default: boolean; readonly label?: string }
  | { readonly type: 'string'; readonly default: string; readonly multiline?: boolean; readonly label?: string }
  | { readonly type: 'enum'; readonly default: string; readonly options: readonly string[]; readonly label?: string };

export function validateParamValue(def: ParamDef, value: unknown): boolean {
  switch (def.type) {
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (def.min === undefined || value >= def.min) &&
        (def.max === undefined || value <= def.max)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'enum':
      return typeof value === 'string' && def.options.includes(value);
  }
}

export interface EvalContext {
  /** Playback time in seconds. */
  readonly time: number;
  readonly frame: number;
  readonly nodeId: string;
}

export interface NodeTypeDef<TInputs = any, TOutputs = any, TParams = any> {
  /** Unique `namespace.name`, e.g. `math.add` or `scene.mesh`. */
  readonly type: string;
  readonly label: string;
  /** Palette category, e.g. `Math`, `Scene`. */
  readonly category: string;
  readonly description?: string;
  readonly inputs: Readonly<Record<string, PortDef>>;
  readonly outputs: Readonly<Record<string, PortDef>>;
  readonly params?: Readonly<Record<string, ParamDef>>;
  /** The result depends on time: re-evaluated whenever the playhead moves. */
  readonly volatile?: boolean;
  /** Pure function from inputs and params to outputs. Throwing marks the node as failed. */
  evaluate(args: { inputs: TInputs; params: TParams; ctx: EvalContext }): TOutputs;
}

/** Identity helper that gives node definitions full type inference. */
export function defineNode<TInputs, TOutputs, TParams = Record<string, never>>(
  def: NodeTypeDef<TInputs, TOutputs, TParams>,
): NodeTypeDef<TInputs, TOutputs, TParams> {
  return def;
}

const TYPE_NAME = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const PORT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export class NodeRegistry {
  readonly types: TypeRegistry;
  readonly #nodes = new Map<string, NodeTypeDef>();

  constructor(types: TypeRegistry = new TypeRegistry()) {
    this.types = types;
  }

  register(...defs: NodeTypeDef[]): this {
    for (const def of defs) this.#registerOne(def);
    return this;
  }

  #registerOne(def: NodeTypeDef): void {
    const fail = (message: string): never => {
      throw new MekdeckError('E_NODE_TYPE_INVALID', `Node type "${def.type}": ${message}`);
    };
    if (!TYPE_NAME.test(def.type)) fail('name must look like "namespace.name"');
    if (this.#nodes.has(def.type)) fail('is already registered');

    const checkPorts = (kind: 'input' | 'output', ports: Readonly<Record<string, PortDef>>): void => {
      for (const [name, port] of Object.entries(ports)) {
        if (!PORT_NAME.test(name) || FORBIDDEN_NAMES.has(name)) fail(`${kind} name "${name}" is not allowed`);
        if (!this.types.has(port.type)) fail(`${kind} "${name}" uses unknown data type "${port.type}"`);
        if (kind === 'output' && (port.multi || port.optional || port.default !== undefined)) {
          fail(`output "${name}" cannot be multi, optional or have a default`);
        }
        if (port.default !== undefined && !this.types.check(port.type, port.default)) {
          fail(`default of ${kind} "${name}" is not a valid "${port.type}"`);
        }
      }
    };
    checkPorts('input', def.inputs);
    checkPorts('output', def.outputs);

    for (const [name, param] of Object.entries(def.params ?? {})) {
      if (!PORT_NAME.test(name) || FORBIDDEN_NAMES.has(name)) fail(`param name "${name}" is not allowed`);
      if (!validateParamValue(param, param.default)) fail(`default of param "${name}" is invalid`);
    }
    this.#nodes.set(def.type, def);
  }

  has(type: string): boolean {
    return this.#nodes.has(type);
  }

  get(type: string): NodeTypeDef | undefined {
    return this.#nodes.get(type);
  }

  list(): NodeTypeDef[] {
    return [...this.#nodes.values()];
  }

  /** Palette view: category name to its node types, both sorted alphabetically. */
  byCategory(): Map<string, NodeTypeDef[]> {
    const map = new Map<string, NodeTypeDef[]>();
    for (const def of this.list()) {
      const bucket = map.get(def.category) ?? [];
      bucket.push(def);
      map.set(def.category, bucket);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.label.localeCompare(b.label));
    return new Map([...map].sort(([a], [b]) => a.localeCompare(b)));
  }
}

/** Parameter values with defaults filled in for anything the node does not override. */
export function resolveParams(def: NodeTypeDef, overrides: Readonly<Record<string, JsonValue>>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, param] of Object.entries(def.params ?? {})) {
    const value = overrides[name];
    out[name] = value !== undefined && validateParamValue(param, value) ? value : param.default;
  }
  return out;
}
