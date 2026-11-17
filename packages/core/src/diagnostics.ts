export type Severity = 'error' | 'warning' | 'info';

/** A problem (or note) found while validating a graph, project or file. */
export interface Diagnostic {
  readonly severity: Severity;
  /** Stable kebab-case identifier, e.g. `unknown-node-type`. */
  readonly code: string;
  readonly message: string;
  readonly node?: string;
  readonly edge?: string;
  readonly port?: string;
  /** File path inside a project, when the diagnostic is about a file. */
  readonly path?: string;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}
