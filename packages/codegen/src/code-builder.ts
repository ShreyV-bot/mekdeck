import { MekdeckError } from '@mekdeck/core';

/** Links a span of generated code back to the graph node that produced it. */
export interface SourceRange {
  /** Id of the graph node. */
  readonly origin: string;
  /** Identifier or display name of the thing the code creates. */
  readonly name: string;
  readonly kind: string;
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  /** Nesting depth (0 = top level); lets the code view build an outline tree. */
  readonly depth: number;
}

/** Builds source text line by line while tracking indentation and node-to-line ranges. */
export class CodeBuilder {
  readonly #lines: string[] = [];
  readonly #ranges: SourceRange[] = [];
  #indent = 0;
  #depth = 0;

  line(text = ''): void {
    this.#lines.push(text === '' ? '' : `${'  '.repeat(this.#indent)}${text}`);
  }

  indented(fn: () => void): void {
    this.#indent++;
    try {
      fn();
    } finally {
      this.#indent--;
    }
  }

  /** Run `fn`, and record the lines it emits as the code for graph node `origin`. */
  mark(info: { origin: string; name: string; kind: string }, fn: () => void): void {
    const startLine = this.#lines.length + 1;
    const depth = this.#depth++;
    try {
      fn();
    } finally {
      this.#depth--;
    }
    this.#ranges.push({ ...info, startLine, endLine: this.#lines.length, depth });
  }

  get ranges(): SourceRange[] {
    // Outer ranges first, as an outline would list them.
    return [...this.#ranges].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  }

  text(): string {
    return `${this.#lines.join('\n')}\n`;
  }
}

const RESERVED = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends false finally for ' +
    'function if import in instanceof new null return super switch this throw true try typeof var void while with yield ' +
    'let static implements interface package private protected public await async of arguments eval ' +
    'undefined NaN Infinity globalThis window document console THREE scene camera renderer srgb'
  ).split(' '),
);

/** Hands out unique, valid JavaScript identifiers derived from human names. */
export class IdentAllocator {
  readonly #used = new Set<string>(RESERVED);

  claim(name: string): string {
    const words = name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
    let base = words
      .map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() : w.charAt(0).toUpperCase()) + w.slice(1))
      .join('');
    if (base === '') base = 'object';
    if (/^[0-9]/.test(base)) base = `_${base}`;
    let candidate = base;
    for (let n = 2; this.#used.has(candidate); n++) candidate = `${base}${n}`;
    this.#used.add(candidate);
    return candidate;
  }
}

/** Format a number for source code: finite only, no -0, no float noise. */
export function num(value: number): string {
  if (!Number.isFinite(value)) {
    throw new MekdeckError('E_CODEGEN_NONFINITE', `Cannot generate code for a non-finite number (${value})`);
  }
  const rounded = Number(value.toFixed(6));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function nums(values: readonly number[]): string {
  return values.map(num).join(', ');
}

/** A JavaScript string literal (JSON is a subset of JS string syntax). */
export function str(value: string): string {
  return JSON.stringify(value);
}
