/**
 * Top-level output handed over while a script runs.
 *
 * The top-level output of an execution is what it writes to its own standard
 * output and standard error. InterpreterState.liveOutput names the streams
 * whose bytes, at the current point of the script, are top-level output. A
 * place that takes a stream over (a pipe, a substitution, an output
 * redirection) switches the stream off for the code it runs.
 */
import {
  encodeUtf8ToBytes,
  stdoutAsBytes,
  uint8ArrayFromBytes,
} from "../encoding.js";
import type { ExecResult, StreamedBytes } from "../types.js";
import { ControlFlowError } from "./errors.js";
import type { InterpreterContext, InterpreterState } from "./types.js";

/** The receiver of the top-level output of one execution. */
export interface OutputTarget {
  emit(stream: "stdout" | "stderr", bytes: Uint8Array): void;
  /** Bytes handed to `emit` so far. */
  readonly emitted: { stdout: number; stderr: number };
}

/** The streams that are top-level output at one point of a script. */
export interface LiveOutput {
  readonly target: OutputTarget;
  readonly stdout: boolean;
  readonly stderr: boolean;
}

export function outputTarget(
  emit: (stream: "stdout" | "stderr", bytes: Uint8Array) => void,
): OutputTarget {
  const emitted = { stdout: 0, stderr: 0 };
  return {
    emitted,
    emit: (stream, bytes) => {
      if (bytes.length === 0) return;
      emitted[stream] += bytes.length;
      emit(stream, bytes);
    },
  };
}

/**
 * Hands the live streams of result to the output target, standard output
 * first, and returns result without them. The bytes count against the output
 * limit of the execution before they are handed over.
 */
export function emitLive(
  ctx: InterpreterContext,
  result: ExecResult,
): ExecResult {
  const live = ctx.state.liveOutput;
  if (live === undefined) return result;
  const stdout = live.stdout && result.stdout !== "";
  const stderr = live.stderr && result.stderr !== "";
  if (!stdout && !stderr) return result;
  const accounted = ctx.executionScope.accountResult({ ...result }, "output");
  if (stdout) {
    live.target.emit("stdout", uint8ArrayFromBytes(stdoutAsBytes(result)));
  }
  if (stderr) {
    live.target.emit(
      "stderr",
      uint8ArrayFromBytes(encodeUtf8ToBytes(result.stderr)),
    );
  }
  return {
    ...accounted,
    stdout: stdout ? "" : result.stdout,
    stderr: stderr ? "" : result.stderr,
    internalOutputAccounting: {
      stdout: stdout ? 0 : (accounted.internalOutputAccounting?.stdout ?? 0),
      stderr: stderr ? 0 : (accounted.internalOutputAccounting?.stderr ?? 0),
    },
  };
}

/** emitLive for the output that a control flow error carries. */
export function emitLiveError(ctx: InterpreterContext, error: unknown): void {
  if (!(error instanceof ControlFlowError)) return;
  const live = ctx.state.liveOutput;
  if (live === undefined) return;
  for (const stream of ["stdout", "stderr"] as const) {
    const text = error[stream];
    if (!live[stream] || text === "") continue;
    const bytes = uint8ArrayFromBytes(encodeUtf8ToBytes(text));
    try {
      ctx.executionScope.appendOutput(
        stream,
        text,
        "output",
        Math.min(error.internalOutputAccounting[stream], bytes.length),
      );
    } catch {
      // The execution is over its limits or already closed: the text stays
      // on the error, which ends the execution.
      continue;
    }
    live.target.emit(stream, bytes);
    error[stream] = "";
    error.internalOutputAccounting[stream] = 0;
  }
}

/**
 * Switches the given streams off in state and returns the function that
 * restores them. The two calls enclose the code whose output on these
 * streams something else than the top level receives.
 */
export function captureOutput(
  state: InterpreterState,
  streams: { readonly stdout: boolean; readonly stderr: boolean },
): () => void {
  const live = state.liveOutput;
  if (live === undefined) return () => undefined;
  const stdout = live.stdout && !streams.stdout;
  const stderr = live.stderr && !streams.stderr;
  state.liveOutput =
    stdout || stderr ? { target: live.target, stdout, stderr } : undefined;
  return () => {
    state.liveOutput = live;
  };
}

const BOTH = { stdout: true, stderr: true };

/** Runs run with both streams switched off. */
export async function withCapturedOutput<T>(
  ctx: InterpreterContext,
  run: () => Promise<T>,
): Promise<T> {
  const restore = captureOutput(ctx.state, BOTH);
  try {
    return await run();
  } finally {
    restore();
  }
}

/** The bytes handed to the output target of state since `before`, a value of emittedBytes. */
export function streamedSince(
  state: InterpreterState,
  before: { readonly stdout: number; readonly stderr: number },
): StreamedBytes {
  const now = emittedBytes(state);
  return {
    stdoutBytes: now.stdout - before.stdout,
    stderrBytes: now.stderr - before.stderr,
  };
}

/** The bytes handed to the output target of state so far; zero without a live stream. */
export function emittedBytes(state: InterpreterState): {
  stdout: number;
  stderr: number;
} {
  const emitted = state.liveOutput?.target.emitted;
  return { stdout: emitted?.stdout ?? 0, stderr: emitted?.stderr ?? 0 };
}
