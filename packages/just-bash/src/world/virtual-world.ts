import { fileURLToPath } from "node:url";
import { Bash } from "../Bash.js";
import { fsError } from "../fs/fs-error.js";
import { resolvePath } from "../fs/path-utils.js";
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
import { Shell } from "./shell.js";
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
 * just-bash shell on it, in a worker thread. Every command the shell runs is
 * a command invocation, and every file system operation it performs is
 * reported for the invocation running it.
 */
class VirtualWorld implements WorldBackend {
  readonly capabilities: WorldCapabilities = CAPABILITIES;
  readonly cwd: string;
  private readonly files: WorldFiles;
  private readonly store: SnapshotStore;
  private readonly settings: WorldSettings;
  private readonly forkedFrom: string | undefined;
  private readonly shell: Shell;
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
    this.shell = new Shell({ cwd, ...settings }, this.files);
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

  private async run(
    command: string,
    execution: WorldExecution,
    onOutput: (chunk: Buffer) => void,
    signal: AbortSignal,
  ): Promise<WorldExit> {
    const result = await this.shell.run(command, execution, signal);
    if ("terminated" in result) return { signal: "SIGKILL" };
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

  close(): Promise<void> {
    return this.shell.close();
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
