/**
 * Messages between a world and the worker its shell runs in. The world holds
 * the files; the worker asks for every file system operation, reports each
 * command invocation when it ends, and sends each chunk of a run's output
 * when the shell hands it over. A run is one exec or job.
 */
import type { FsMethod } from "./world-files.js";

/** The worker's workerData. */
export interface ShellSettings {
  readonly cwd: string;
  readonly python?: boolean;
  readonly javascript?: boolean;
  /** Distinguishes the command ids of successive workers of one world. */
  readonly generation: number;
}

export interface SerializedError {
  readonly message: string;
  readonly code?: string;
}

export type ToShell =
  | { readonly type: "exec"; readonly run: number; readonly command: string }
  | { readonly type: "abort"; readonly run: number }
  | {
      readonly type: "reply";
      readonly request: number;
      readonly value?: unknown;
      readonly error?: SerializedError;
    };

export type FromShell =
  | {
      readonly type: "fs";
      readonly request: number;
      readonly run: number;
      readonly commandId?: string;
      readonly method: FsMethod;
      readonly args: readonly unknown[];
    }
  | {
      readonly type: "invoked";
      readonly run: number;
      readonly commandId: string;
      readonly parentCommandId?: string;
      readonly name: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly exitCode: number;
      readonly stdoutBytes: number;
      readonly stderrBytes: number;
    }
  | {
      /** One chunk of the run's standard output or standard error, in the order the shell produced them. */
      readonly type: "output";
      readonly run: number;
      readonly bytes: Uint8Array;
    }
  | {
      /** The run ended; every `output` message of the run was sent before it. */
      readonly type: "done";
      readonly run: number;
      readonly exitCode: number;
    }
  | {
      readonly type: "failed";
      readonly run: number;
      readonly error: SerializedError;
    };

export function serializeError(error: unknown): SerializedError {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return typeof code === "string" ? { message, code } : { message };
}

export function deserializeError(error: SerializedError): Error {
  return Object.assign(
    new Error(error.message),
    error.code === undefined ? {} : { code: error.code },
  );
}
