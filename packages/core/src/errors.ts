/**
 * Every error MekDeck raises on purpose carries a stable machine-readable `code`
 * (for the UI, the CLI and scripts to branch on) and a human-readable message.
 */
export class MekdeckError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MekdeckError';
    this.code = code;
    this.details = details;
  }
}

export function isMekdeckError(value: unknown): value is MekdeckError {
  return value instanceof MekdeckError;
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
