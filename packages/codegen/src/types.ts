import type { SourceRange } from './code-builder.ts';

export interface GeneratedFile {
  /** Path inside the generated project, forward slashes. */
  readonly path: string;
  readonly language: 'javascript' | 'typescript' | 'json' | 'html' | 'markdown' | 'text';
  readonly content: string;
  /** Which graph node produced which lines (only for files generated from the graph). */
  readonly ranges?: readonly SourceRange[];
}

export interface GeneratedProject {
  readonly target: string;
  readonly files: readonly GeneratedFile[];
}
