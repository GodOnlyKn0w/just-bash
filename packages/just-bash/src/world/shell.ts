import { Worker } from "node:worker_threads";
import type { WorldExecution } from "./interface.js";
import {
  deserializeError,
  type FromShell,
  type ShellSettings,
  serializeError,
  type ToShell,
} from "./shell-protocol.js";
import type { WorldFiles } from "./world-files.js";

/** How a run ended: the shell's exit code, or the worker was terminated after an abort before the run ended. */
export type RunEnd =
  | { readonly exitCode: number }
  | { readonly terminated: true };

/** How long an aborted run may take to end before its worker is terminated. */
const ABORT_GRACE_MS = 2000;

interface Run {
  readonly execution: WorldExecution;
  readonly worker: Worker;
  readonly onOutput: (chunk: Buffer) => void;
  end(end: RunEnd | Error): void;
}

/**
 * The shell of a world, running in a worker thread so that commands neither
 * block the host's thread nor outlive an abort. The files stay with the
 * world: the worker's file system operations run on WorldFiles, attributed
 * to the run's execution and the command invocation performing them.
 *
 * All runs share one worker. A run that ignores an abort for ABORT_GRACE_MS
 * gets its worker terminated, which ends the other runs on it as well; the
 * next run starts a new worker.
 */
export class Shell {
  private readonly settings: Omit<ShellSettings, "generation">;
  private readonly files: WorldFiles;
  private worker: Worker | undefined;
  private generation = 0;
  private runs = new Map<number, Run>();
  private lastRun = 0;
  /** Workers terminated on purpose, and why the others exited. */
  private readonly terminated = new WeakSet<Worker>();
  private readonly failures = new WeakMap<Worker, Error>();

  constructor(settings: Omit<ShellSettings, "generation">, files: WorldFiles) {
    this.settings = settings;
    this.files = files;
  }

  private spawn(): Worker {
    const fromSource = import.meta.url.endsWith(".ts");
    const worker = new Worker(
      new URL(
        fromSource ? "./shell-worker.ts" : "./shell-worker.js",
        import.meta.url,
      ),
      {
        workerData: {
          ...this.settings,
          generation: ++this.generation,
        } satisfies ShellSettings,
        // Running from TypeScript sources (tests) needs a loader in the
        // worker; otherwise the worker keeps the host's execArgv.
        execArgv: fromSource ? ["--import", "tsx"] : undefined,
      },
    );
    worker.on("message", (message: FromShell) =>
      this.received(worker, message),
    );
    worker.on("error", (error: unknown) =>
      this.failures.set(
        worker,
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
    worker.on("exit", () => this.exited(worker));
    return worker;
  }

  private send(worker: Worker, message: ToShell): void {
    worker.postMessage(message);
  }

  /**
   * Runs command for execution. Each chunk of the command's standard output
   * and standard error goes to onOutput when the shell hands it over, in the
   * order the shell produced them, and before the returned promise settles.
   * Rejects when the worker fails for another reason than an abort.
   */
  run(
    command: string,
    execution: WorldExecution,
    onOutput: (chunk: Buffer) => void,
    signal: AbortSignal,
  ): Promise<RunEnd> {
    this.worker ??= this.spawn();
    const worker = this.worker;
    const id = ++this.lastRun;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        this.send(worker, { type: "abort", run: id });
        timer = setTimeout(() => this.terminate(worker), ABORT_GRACE_MS);
      };
      this.runs.set(id, {
        execution,
        worker,
        onOutput,
        end: (end) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          this.runs.delete(id);
          if (end instanceof Error) reject(end);
          else resolve(end);
        },
      });
      this.send(worker, { type: "exec", run: id, command });
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  private terminate(worker: Worker): void {
    this.terminated.add(worker);
    if (this.worker === worker) this.worker = undefined;
    void worker.terminate();
  }

  private exited(worker: Worker): void {
    if (this.worker === worker) this.worker = undefined;
    const end: RunEnd | Error = this.terminated.has(worker)
      ? { terminated: true }
      : (this.failures.get(worker) ?? new Error("shell worker exited"));
    for (const run of [...this.runs.values()]) {
      if (run.worker === worker) run.end(end);
    }
  }

  private received(worker: Worker, message: FromShell): void {
    const run = this.runs.get(message.run);
    if (message.type === "fs") {
      const reply = (outcome: { value: unknown } | { error: unknown }) => {
        if (this.terminated.has(worker)) return;
        this.send(
          worker,
          "error" in outcome
            ? {
                type: "reply",
                request: message.request,
                error: serializeError(outcome.error),
              }
            : { type: "reply", request: message.request, value: outcome.value },
        );
      };
      if (run === undefined) {
        reply({ error: new Error("the run has ended") });
        return;
      }
      const execution =
        message.commandId === undefined
          ? run.execution
          : { ...run.execution, commandId: message.commandId };
      this.files.call(execution, message.method, message.args).then(
        (value) => reply({ value }),
        (error: unknown) => reply({ error }),
      );
    } else if (message.type === "invoked") {
      if (run === undefined) return;
      const { type: _, run: __, commandId, ...invocation } = message;
      this.files.observer?.invoked({
        ...invocation,
        execution: { ...run.execution, commandId },
      });
    } else if (message.type === "output") {
      run?.onOutput(
        Buffer.from(
          message.bytes.buffer,
          message.bytes.byteOffset,
          message.bytes.byteLength,
        ),
      );
    } else if (message.type === "done") {
      run?.end({ exitCode: message.exitCode });
    } else {
      run?.end(deserializeError(message.error));
    }
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (worker === undefined) return;
    this.terminated.add(worker);
    this.worker = undefined;
    await worker.terminate();
  }
}
