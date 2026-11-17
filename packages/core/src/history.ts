import { Emitter } from './emitter.ts';
import { MekdeckError } from './errors.ts';
import type { GraphDocument, Op } from './graph.ts';

export interface HistoryEntry {
  readonly label: string;
  redo: Op;
  readonly undo: Op;
  readonly coalesceKey: string | undefined;
  at: number;
}

export interface RunOptions {
  /** Shown in the Edit menu ("Undo Move node"). */
  readonly label?: string;
  /**
   * Consecutive runs with the same key within the coalesce window merge into ONE undo step
   * (slider drags, node dragging). Only use it for operations that overwrite the same target
   * (`setValue` on one port, `moveNode` on one node): the merged step keeps the first undo
   * and the latest redo.
   */
  readonly coalesceKey?: string;
}

export interface HistoryOptions {
  readonly limit?: number;
  readonly coalesceWindowMs?: number;
  readonly now?: () => number;
}

function describe(op: Op): string {
  switch (op.op) {
    case 'addNode':
      return 'Add node';
    case 'removeNode':
      return 'Delete node';
    case 'addEdge':
      return 'Connect';
    case 'removeEdge':
      return 'Disconnect';
    case 'setValue':
    case 'setParam':
      return 'Change value';
    case 'moveNode':
      return 'Move node';
    case 'setLabel':
      return 'Rename node';
    case 'batch':
      return op.ops.length > 0 ? describe(op.ops[op.ops.length - 1]!) : 'Edit';
  }
}

/** Undo/redo for one GraphDocument, with grouping (transactions) and drag coalescing. */
export class History {
  readonly doc: GraphDocument;
  readonly #undo: HistoryEntry[] = [];
  readonly #redo: HistoryEntry[] = [];
  readonly #changed = new Emitter<void>();
  readonly #limit: number;
  readonly #window: number;
  readonly #now: () => number;
  #tx: { redo: Op[]; undo: Op[] } | null = null;

  constructor(doc: GraphDocument, options: HistoryOptions = {}) {
    this.doc = doc;
    this.#limit = options.limit ?? 500;
    this.#window = options.coalesceWindowMs ?? 1000;
    this.#now = options.now ?? (() => Date.now());
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  get undoLabel(): string | undefined {
    return this.#undo.at(-1)?.label;
  }

  get redoLabel(): string | undefined {
    return this.#redo.at(-1)?.label;
  }

  /** Notified whenever the undo/redo stacks change. */
  onChange(listener: () => void): () => void {
    return this.#changed.subscribe(listener);
  }

  /** Apply an operation to the document and record it. */
  run(op: Op, options: RunOptions = {}): void {
    const inverse = this.doc.apply(op, 'local');
    if (this.#tx) {
      this.#tx.redo.push(op);
      this.#tx.undo.push(inverse);
      return;
    }
    this.#record({
      label: options.label ?? describe(op),
      redo: op,
      undo: inverse,
      coalesceKey: options.coalesceKey,
      at: this.#now(),
    });
  }

  /**
   * Group everything `fn` does into one undo step. If `fn` throws, all of its changes are
   * rolled back and the error is rethrown. `fn` must be synchronous.
   */
  transaction<T>(label: string, fn: () => T): T {
    if (this.#tx) return fn(); // nested: the outermost transaction owns rollback and recording
    const tx: { redo: Op[]; undo: Op[] } = { redo: [], undo: [] };
    this.#tx = tx;
    let result: T;
    try {
      result = fn();
    } catch (error) {
      this.#tx = null;
      for (let i = tx.undo.length - 1; i >= 0; i--) this.doc.apply(tx.undo[i]!, 'undo');
      throw error;
    }
    this.#tx = null;
    if (tx.redo.length > 0) {
      this.#record({
        label,
        redo: { op: 'batch', ops: tx.redo },
        undo: { op: 'batch', ops: [...tx.undo].reverse() },
        coalesceKey: undefined,
        at: this.#now(),
      });
    }
    return result;
  }

  undo(): boolean {
    const entry = this.#undo.pop();
    if (!entry) return false;
    this.#replay(entry.undo, 'undo');
    this.#redo.push(entry);
    this.#changed.emit();
    return true;
  }

  redo(): boolean {
    const entry = this.#redo.pop();
    if (!entry) return false;
    this.#replay(entry.redo, 'redo');
    this.#undo.push(entry);
    this.#changed.emit();
    return true;
  }

  clear(): void {
    this.#undo.length = 0;
    this.#redo.length = 0;
    this.#changed.emit();
  }

  #replay(op: Op, origin: 'undo' | 'redo'): void {
    try {
      this.doc.apply(op, origin);
    } catch (error) {
      // The document changed underneath us (for example by a remote edit); history is no longer valid.
      this.clear();
      throw new MekdeckError('E_HISTORY_DIVERGED', 'Undo history no longer matches the document and was cleared', undefined, { cause: error });
    }
  }

  #record(entry: HistoryEntry): void {
    const top = this.#undo.at(-1);
    const mergeable =
      entry.coalesceKey !== undefined &&
      top !== undefined &&
      top.coalesceKey === entry.coalesceKey &&
      this.#redo.length === 0 &&
      entry.at - top.at <= this.#window;
    if (mergeable) {
      top.redo = entry.redo;
      top.at = entry.at;
    } else {
      this.#undo.push(entry);
      if (this.#undo.length > this.#limit) this.#undo.shift();
    }
    this.#redo.length = 0;
    this.#changed.emit();
  }
}
