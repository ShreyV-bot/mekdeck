import { MekdeckError } from './errors.ts';

export const ANY_TYPE = 'any';

export interface DataTypeDef {
  /** Unique id such as `number`, `vec3`, `geometry`. */
  readonly id: string;
  readonly label: string;
  /** Socket colour hint for the editor UI. */
  readonly color?: string;
  /** Optional runtime check used to validate inline values and defaults. */
  readonly check?: (value: unknown) => boolean;
}

export interface ConversionDef {
  readonly from: string;
  readonly to: string;
  readonly convert: (value: any) => unknown;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isTuple = (n: number) => (v: unknown) => Array.isArray(v) && v.length === n && v.every(isNum);

/**
 * Registry of socket data types and the implicit conversions between them.
 * Node libraries add their own types (`geometry`, `material`, ...).
 */
export class TypeRegistry {
  readonly #types = new Map<string, DataTypeDef>();
  readonly #conversions = new Map<string, ConversionDef>();

  constructor() {
    this.register({ id: ANY_TYPE, label: 'Any', color: '#9ca3af' });
    this.register({ id: 'number', label: 'Number', color: '#a1a1aa', check: isNum });
    this.register({ id: 'boolean', label: 'Boolean', color: '#f472b6', check: (v) => typeof v === 'boolean' });
    this.register({ id: 'string', label: 'String', color: '#60a5fa', check: (v) => typeof v === 'string' });
    this.register({ id: 'vec2', label: 'Vector 2', color: '#a78bfa', check: isTuple(2) });
    this.register({ id: 'vec3', label: 'Vector 3', color: '#818cf8', check: isTuple(3) });
    // sRGB, each channel 0..1 (the colours an artist sees in a picker).
    this.register({ id: 'color', label: 'Color', color: '#fbbf24', check: isTuple(3) });

    this.registerConversion({ from: 'number', to: 'vec2', convert: (v: number) => [v, v] });
    this.registerConversion({ from: 'number', to: 'vec3', convert: (v: number) => [v, v, v] });
    this.registerConversion({ from: 'number', to: 'color', convert: (v: number) => [v, v, v] });
    this.registerConversion({ from: 'boolean', to: 'number', convert: (v: boolean) => (v ? 1 : 0) });
    this.registerConversion({ from: 'vec3', to: 'color', convert: (v: number[]) => [...v] });
    this.registerConversion({ from: 'color', to: 'vec3', convert: (v: number[]) => [...v] });
  }

  register(def: DataTypeDef): this {
    if (this.#types.has(def.id)) {
      throw new MekdeckError('E_TYPE_DUPLICATE', `Data type "${def.id}" is already registered`);
    }
    this.#types.set(def.id, def);
    return this;
  }

  registerConversion(def: ConversionDef): this {
    this.#conversions.set(`${def.from}->${def.to}`, def);
    return this;
  }

  has(id: string): boolean {
    return this.#types.has(id);
  }

  get(id: string): DataTypeDef | undefined {
    return this.#types.get(id);
  }

  list(): DataTypeDef[] {
    return [...this.#types.values()];
  }

  /** Can an output of type `from` feed an input of type `to`? */
  canConnect(from: string, to: string): boolean {
    if (!this.#types.has(from) || !this.#types.has(to)) return false;
    if (from === to || from === ANY_TYPE || to === ANY_TYPE) return true;
    return this.#conversions.has(`${from}->${to}`);
  }

  /** Convert a value travelling along an edge. Call only for connections `canConnect` accepts. */
  convert(from: string, to: string, value: unknown): unknown {
    if (from === to || from === ANY_TYPE || to === ANY_TYPE) return value;
    const conversion = this.#conversions.get(`${from}->${to}`);
    if (!conversion) {
      throw new MekdeckError('E_TYPE_MISMATCH', `No conversion from "${from}" to "${to}"`);
    }
    return conversion.convert(value);
  }

  /** True when the value passes the type's check (or the type has no check). */
  check(id: string, value: unknown): boolean {
    const check = this.#types.get(id)?.check;
    return check ? check(value) : true;
  }
}
