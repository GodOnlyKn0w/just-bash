/**
 * The worker a world's shell runs in. It holds no files: every file system
 * operation goes to the world as an `fs` message, tagged with the run and
 * the command invocation that performs it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { parentPort, workerData } from "node:worker_threads";
import { Bash } from "../Bash.js";
import { utf8ByteLength } from "../encoding.js";
import type { ExecResult, StreamedBytes } from "../types.js";
import {
  deserializeError,
  type FromShell,
  type ShellSettings,
  serializeError,
  type ToShell,
} from "./shell-protocol.js";
import { forwardingFileSystem } from "./world-files.js";

const port = parentPort;
if (port === null) throw new Error("shell-worker runs as a worker thread");
const settings = workerData as ShellSettings;

/** The run and the command invocation the current code belongs to. */
interface Scope {
  readonly run: number;
  readonly commandId?: string;
}

const scopes = new AsyncLocalStorage<Scope>();
const replies = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const runs = new Map<number, AbortController>();
let requests = 0;
let commands = 0;

function post(message: FromShell): void {
  port?.postMessage(message);
}

function outputBytes(result: ExecResult): {
  stdoutBytes: number;
  stderrBytes: number;
} {
  const bytes =
    result.stdoutKind === "bytes" || result.stdoutEncoding === "binary";
  return {
    stdoutBytes: bytes ? result.stdout.length : utf8ByteLength(result.stdout),
    stderrBytes: utf8ByteLength(result.stderr),
  };
}

const fs = forwardingFileSystem((method, args) => {
  const scope = scopes.getStore();
  if (scope === undefined) {
    return Promise.reject(new Error(`${method} outside a run of the world`));
  }
  const request = ++requests;
  return new Promise((resolve, reject) => {
    replies.set(request, { resolve, reject });
    post({
      type: "fs",
      request,
      run: scope.run,
      ...(scope.commandId === undefined ? {} : { commandId: scope.commandId }),
      method,
      args,
    });
  });
});

const bash = new Bash({
  fs,
  cwd: settings.cwd,
  python: settings.python,
  javascript: settings.javascript,
  commandHook: (command, run) => {
    const scope = scopes.getStore();
    if (scope === undefined) return run(() => undefined);
    const commandId = `command-${settings.generation}-${++commands}`;
    return scopes.run({ run: scope.run, commandId }, async () => {
      let exitCode = 1;
      let bytes = { stdoutBytes: 0, stderrBytes: 0 };
      try {
        // The command's own result counts; without one (its redirections
        // failed) the shell's result does.
        let own: ExecResult | undefined;
        let streamed: StreamedBytes = { stdoutBytes: 0, stderrBytes: 0 };
        const result = await run((ran, ranStreamed) => {
          own = ran;
          streamed = ranStreamed;
        });
        exitCode = (own ?? result).exitCode;
        if (own !== undefined) {
          const returned = outputBytes(own);
          bytes = {
            stdoutBytes: returned.stdoutBytes + streamed.stdoutBytes,
            stderrBytes: returned.stderrBytes + streamed.stderrBytes,
          };
        }
        return result;
      } catch (error) {
        const code = (error as { exitCode?: unknown } | null)?.exitCode;
        if (typeof code === "number") exitCode = code;
        throw error;
      } finally {
        post({
          type: "invoked",
          run: scope.run,
          commandId,
          ...(scope.commandId === undefined
            ? {}
            : { parentCommandId: scope.commandId }),
          name: command.name,
          args: command.args,
          cwd: command.cwd,
          exitCode,
          ...bytes,
        });
      }
    });
  },
});

async function execute(run: number, command: string): Promise<void> {
  const stop = new AbortController();
  runs.set(run, stop);
  try {
    const result = await scopes.run({ run }, () =>
      bash.exec(command, {
        signal: stop.signal,
        onOutput: (_stream, bytes) => post({ type: "output", run, bytes }),
      }),
    );
    post({ type: "done", run, exitCode: result.exitCode });
  } catch (error) {
    post({ type: "failed", run, error: serializeError(error) });
  } finally {
    runs.delete(run);
  }
}

port.on("message", (message: ToShell) => {
  if (message.type === "exec") {
    void execute(message.run, message.command);
  } else if (message.type === "abort") {
    runs.get(message.run)?.abort();
  } else {
    const reply = replies.get(message.request);
    replies.delete(message.request);
    if (message.error === undefined) reply?.resolve(message.value);
    else reply?.reject(deserializeError(message.error));
  }
});
