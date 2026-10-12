import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "./interpreter/errors.js";

/**
 * Rethrow errors that command-level recovery must never turn into ordinary
 * command failures. Call this first in broad catch blocks.
 */
export function rethrowFatalExecutionError(error: unknown): void {
  if (
    error instanceof ExecutionLimitError ||
    error instanceof ExecutionAbortedError
  ) {
    throw error;
  }
}
