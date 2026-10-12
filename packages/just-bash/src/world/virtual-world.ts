import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { Bash } from "../Bash.js";
import { utf8ByteLength } from "../encoding.js";
import { fsError } from "../fs/fs-error.js";
import { resolvePath } from "../fs/path-utils.js";
import type { CommandHookCall, ExecResult as ShellResult } from "../types.js";
import type {
  ExecOptions,
  ExecResult,
  JsonValue,
  WorldBackend,
  WorldBackendInput,
  WorldBinding,
  WorldCapabilities,
  WorldEntry,
  WorldExecution,
  WorldExit,
  WorldJob,
  WorldObserver,
  WorldOutputFile,
  WorldStat,
  WorldVersions,
} from "./interface.js";
import {
  directoryStore,
  memoryStore,
  type SnapshotStore,
} from "./snapshot-store.js";
import { WorldFiles } from "./world-files.js";
import { versionEntries, WorldState } from "./world-state.js";

const CAPABILITIES: WorldCapabilities = {
  toolObservation: true,
  commandObservation: true,
  commandInvocations: true,
  worldVersion: true,
  fork: true,
  clock: "host",
  commands: "interpreter",
  toolOrigin: false,
};

/** The directory of the harness output files. */
const OUTPUT_DIRECTORY = "/harness";

/** Options of a world that a fork of it keeps. */
interface WorldSettings {
  readonly python?: boolean;
  readonly javascript?: boolean;
}

/** The options of WorldBinding for this module. */
interface VirtualWorldOptions extends WorldSettings {
  /** Working directory in the world; the input's cwd when omitted. */
  readonly cwd?: string;
  /** Initial files: path to UTF-8 content, relative paths against cwd. Ignored with fork. */
  readonly files?: Readonly<Record<string, string>>;
  /** Directory of the snapshot store. */
  readonly snapshots?: string;
  /** Id of an in-memory snapshot store of this process, given by fork. */
  readonly memory?: string;
  /** World version the world starts from, given by fork. */
  readonly fork?: string;
}

/** The execution an exec or job runs for, and the command invocation that is running, if any. */
interface Scope {
  readonly execution: WorldExecution;
  readonly commandId?: string;
}

function parseOptions(value: JsonValue | undefined): VirtualWorldOptions {
  if (value === undefined) return Object.create(null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("world options must be an object");
  }
  const types: Record<keyof VirtualWorldOptions, string> = {
    cwd: "string",
    python: "boolean",
    javascript: "boolean",
    files: "object",
    snapshots: "string",
    memory: "string",
    fork: "string",
  };
  for (const [key, field] of Object.entries(value)) {
    const type = Object.hasOwn(types, key)
      ? types[key as keyof VirtualWorldOptions]
      : undefined;
    if (type === undefined) {
      throw new Error(
        `world options: unknown field ${key}; allowed: ${Object.keys(types).join(", ")}`,
      );
    }
    if (typeof field !== type || field === null || Array.isArray(field)) {
      throw new Error(`world options: ${key} must be a ${type}`);
    }
  }
  for (const [path, content] of Object.entries(
    (value.files ?? Object.create(null)) as Record<string, JsonValue>,
  )) {
    if (typeof content !== "string") {
      throw new Error(`world options: files.${path} must be a string`);
    }
  }
  return value as VirtualWorldOptions;
}

function outputBytes(result: ShellResult): {
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

/** A new world: the layout a shell creates, then the initial files. */
async function initialState(
  store: SnapshotStore,
  cwd: string,
  options: VirtualWorldOptions,
): Promise<WorldState> {
  const state = new WorldState(store);
  // Constructing a shell on the world's files lays out /bin, /dev, /proc,
  // the command stubs, and the working directory.
  new Bash({
    fs: state.fs,
    cwd,
    python: options.python,
    javascript: options.javascript,
  });
  for (const [path, content] of Object.entries(options.files ?? {})) {
    state.fs.writeFileSync(resolvePath(cwd, path), content);
  }
  for (const path of state.fs.getAllPaths()) {
    const entry = state.entryAt(path);
    if (entry?.type === "file" && "lazy" in entry) {
      await state.fs.readFileBuffer(path);
    }
  }
  return state;
}

/**
 * The virtual world backend: the world is a WorldState and commands run in a
 * just-bash shell on it. Every command the shell runs is a command
 * invocation, and every file system operation it performs is reported for
 * the invocation running it.
 */
class VirtualWorld implements WorldBackend {
  readonly capabilities: WorldCapabilities = CAPABILITIES;
  readonly cwd: string;
  private readonly files: WorldFiles;
  private readonly store: SnapshotStore;
  private readonly settings: WorldSettings;
  private readonly forkedFrom: string | undefined;
  private readonly scopes = new AsyncLocalStorage<Scope>();
  private shell: Bash | undefined;
  private commands = 0;
  private jobs = 0;

  constructor(
    state: WorldState,
    store: SnapshotStore,
    cwd: string,
    settings: WorldSettings,
    forkedFrom: string | undefined,
  ) {
    this.files = new WorldFiles(state);
    this.store = store;
    this.cwd = cwd;
    this.settings = settings;
    this.forkedFrom = forkedFrom;
  }

  async bind(
    observer: WorldObserver,
    restore: string | undefined,
  ): Promise<void> {
    if (restore !== undefined) {
      this.files.state = await WorldState.load(this.store, restore);
    }
    this.files.observer = observer;
  }

  readEntry(
    path: string,
    execution: WorldExecution,
  ): Promise<WorldEntry | undefined> {
    return this.files.readEntry(path, execution);
  }

  stat(
    path: string,
    execution: WorldExecution,
  ): Promise<WorldStat | undefined> {
    return this.files.stat(path, execution);
  }

  writeFile(
    path: string,
    content: Buffer,
    execution: WorldExecution,
    options: { readonly exclusive?: boolean } = {},
  ): Promise<void> {
    return this.files.writeFile(
      path,
      content,
      execution,
      options.exclusive === true,
    );
  }

  makeDirectory(path: string, execution: WorldExecution): Promise<void> {
    return this.files.makeDirectory(path, execution);
  }

  remove(path: string, execution: WorldExecution): Promise<void> {
    return this.files.remove(path, execution);
  }

  outputPath(name: string): string {
    return `${OUTPUT_DIRECTORY}/${name}`;
  }

  createOutput(path: string, execution: WorldExecution): WorldOutputFile {
    return this.files.createOutput(path, execution);
  }

  /** The execution of the current scope, with the running command invocation. */
  private current(): WorldExecution {
    const scope = this.scopes.getStore();
    if (scope === undefined) {
      throw new Error("world file access outside an exec or job");
    }
    return scope.commandId === undefined
      ? scope.execution
      : { ...scope.execution, commandId: scope.commandId };
  }

  /** Runs command as a command invocation of the current scope and reports it when it ends. */
  private invoke(
    command: CommandHookCall,
    run: () => Promise<ShellResult>,
  ): Promise<ShellResult> {
    const scope = this.scopes.getStore();
    if (scope === undefined) return run();
    const commandId = `command-${++this.commands}`;
    return this.scopes.run(
      { execution: scope.execution, commandId },
      async () => {
        let exitCode = 1;
        let bytes = { stdoutBytes: 0, stderrBytes: 0 };
        try {
          const result = await run();
          exitCode = result.exitCode;
          bytes = outputBytes(result);
          return result;
        } catch (error) {
          const code = (error as { exitCode?: unknown } | null)?.exitCode;
          if (typeof code === "number") exitCode = code;
          throw error;
        } finally {
          this.files.observer?.invoked({
            execution: { ...scope.execution, commandId },
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
      },
    );
  }

  private bash(): Bash {
    this.shell ??= new Bash({
      fs: this.files.fileSystem(() => this.current()),
      cwd: this.cwd,
      python: this.settings.python,
      javascript: this.settings.javascript,
      commandHook: (command, run) => this.invoke(command, run),
    });
    return this.shell;
  }

  private async run(
    command: string,
    execution: WorldExecution,
    onOutput: (chunk: Buffer) => void,
    signal: AbortSignal,
  ): Promise<WorldExit> {
    const result = await this.scopes.run({ execution }, () =>
      this.bash().exec(command, { signal }),
    );
    if (result.stdout.length > 0) onOutput(Buffer.from(result.stdout, "utf8"));
    if (result.stderr.length > 0) onOutput(Buffer.from(result.stderr, "utf8"));
    return signal.aborted ? { signal: "SIGTERM" } : { code: result.exitCode };
  }

  async exec(command: string, options: ExecOptions): Promise<ExecResult> {
    return {
      exit: await this.run(
        command,
        options.execution,
        (chunk) => options.onOutput(chunk),
        options.signal,
      ),
    };
  }

  async startJob(
    command: string,
    options: Omit<ExecOptions, "signal">,
  ): Promise<WorldJob> {
    const stop = new AbortController();
    const ended = this.run(
      command,
      options.execution,
      (chunk) => options.onOutput(chunk),
      stop.signal,
    ).then(
      (exit) => ({ exit, residualKilled: false }),
      () => ({ exit: null, residualKilled: false }),
    );
    return {
      handle: `job-${++this.jobs}`,
      ended,
      kill: async () => {
        stop.abort();
        await ended;
      },
    };
  }

  reapJob(): void {
    // Jobs end with the host process; nothing of them stays in the world.
  }

  get versions(): WorldVersions {
    return {
      current: () => this.files.version(),
      forkedFrom: this.forkedFrom,
      entries: async (version) => versionEntries(this.store, version),
      content: async (version) => {
        const bytes = this.store.get("content", version);
        return bytes === undefined ? undefined : Buffer.from(bytes);
      },
    };
  }

  async fork(version: string): Promise<WorldBinding> {
    if (!this.store.hasVersion(version)) {
      throw fsError("ENOENT", `ENOENT: world version ${version}`);
    }
    return {
      module: fileURLToPath(import.meta.url),
      options: {
        ...this.settings,
        cwd: this.cwd,
        ...this.store.location,
        fork: version,
      } as JsonValue,
    };
  }

  async close(): Promise<void> {
    // The state lives in memory and in the snapshot store; nothing to release.
  }
}

/**
 * Creates the virtual world bound by a WorldBinding. The snapshot store is
 * options.snapshots, else input.snapshots, else the in-memory store
 * options.memory, else a new in-memory store. A world with options.fork
 * starts from that version and rejects with ENOENT when the store lacks it.
 */
export async function createWorldBackend(
  input: WorldBackendInput,
): Promise<WorldBackend> {
  const options = parseOptions(input.options);
  const directory = options.snapshots ?? input.snapshots;
  const store =
    directory !== undefined
      ? directoryStore(directory)
      : memoryStore(options.memory);
  const cwd = options.cwd ?? input.cwd;
  const state =
    options.fork !== undefined
      ? await WorldState.load(store, options.fork)
      : await initialState(store, cwd, options);
  const settings: WorldSettings = {
    ...(options.python === undefined ? {} : { python: options.python }),
    ...(options.javascript === undefined
      ? {}
      : { javascript: options.javascript }),
  };
  return new VirtualWorld(state, store, cwd, settings, options.fork);
}
