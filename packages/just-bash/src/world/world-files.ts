import { fsError } from "../fs/fs-error.js";
import type {
  FsEntry,
  FsStat,
  IFileSystem,
  RmOptions,
} from "../fs/interface.js";
import { normalizePath, resolvePath } from "../fs/path-utils.js";
import type {
  WorldChange,
  WorldEntry,
  WorldExecution,
  WorldObserver,
  WorldOutputFile,
  WorldReadKind,
  WorldStat,
} from "./interface.js";
import type { PriorEntries, WorldState } from "./world-state.js";

type ReadMethod =
  | "readFile"
  | "readFileBuffer"
  | "readFileBytes"
  | "readdir"
  | "readdirWithFileTypes"
  | "exists"
  | "stat"
  | "lstat"
  | "realpath"
  | "readlink";

type ChangeMethod =
  | "writeFile"
  | "appendFile"
  | "mkdir"
  | "createExclusive"
  | "rm"
  | "cp"
  | "mv"
  | "chmod"
  | "symlink"
  | "link"
  | "utimes";

/** The IFileSystem methods a world file system forwards. */
export type FsMethod = ReadMethod | ChangeMethod;

/** IFileSystem methods that read the world, by the kind of read they report. */
const READS: Record<ReadMethod, WorldReadKind> = {
  readFile: "content",
  readFileBuffer: "content",
  readFileBytes: "content",
  readdir: "list",
  readdirWithFileTypes: "list",
  exists: "stat",
  stat: "stat",
  lstat: "stat",
  realpath: "stat",
  readlink: "stat",
};

/** IFileSystem methods that may change the world. */
const CHANGES: readonly ChangeMethod[] = [
  "writeFile",
  "appendFile",
  "mkdir",
  "createExclusive",
  "rm",
  "cp",
  "mv",
  "chmod",
  "symlink",
  "link",
  "utimes",
];

/**
 * An IFileSystem that hands every operation on the world to forward. Paths
 * resolve locally; getAllPaths, which only in-memory file systems answer,
 * gives nothing.
 */
export function forwardingFileSystem(
  forward: (method: FsMethod, args: unknown[]) => Promise<unknown>,
): IFileSystem {
  const fs: Record<string, unknown> = Object.create(null);
  for (const method of [...Object.keys(READS), ...CHANGES]) {
    fs[method] = (...args: unknown[]) => forward(method as FsMethod, args);
  }
  fs.resolvePath = (base: string, path: string) => resolvePath(base, path);
  fs.getAllPaths = () => [];
  return fs as unknown as IFileSystem;
}

function isInside(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path.startsWith(root === "/" ? "/" : `${root}/`));
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The files of a world and the reports about them. Every operation names the
 * execution it belongs to; reads are reported once they succeed (a failed
 * read reports a stat), and changes are reported after the operation, also
 * when it fails partway, each with the world version saved after it.
 *
 * Changes are derived from the entries an operation touched: one report per
 * created, modified, or removed path, with the paths inside a removed
 * directory folded into its removal. mv reports one move and folds the paths
 * under its source and target.
 */
export class WorldFiles {
  state: WorldState;
  observer: WorldObserver | undefined;
  /** Settles when the operation started last has settled. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(state: WorldState) {
    this.state = state;
  }

  /** Runs operations that await one at a time, in the order they arrive. */
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private report(
    execution: WorldExecution,
    prior: PriorEntries,
    move?: { readonly from: string; readonly to: string },
  ): void {
    const observer = this.observer;
    if (observer === undefined) return;
    const changes: Omit<WorldChange, "worldVersion">[] = [];
    const folded: string[] = [];
    if (move !== undefined && prior.has(move.from)) {
      const moved = this.state.entryAt(move.to);
      const version = this.state.versionOfEntry(moved);
      changes.push({
        execution,
        path: move.from,
        kind: "move",
        to: move.to,
        ...(version === undefined ? {} : { before: version, after: version }),
      });
      folded.push(move.from, move.to);
    }
    for (const path of [...prior.keys()].sort()) {
      if (folded.includes(path) || isInside(path, folded)) continue;
      const before = prior.get(path);
      const after = this.state.entryAt(path);
      changes.push(...this.difference(execution, path, before, after));
      if (before?.type === "directory" && after?.type !== "directory") {
        folded.push(path);
      }
    }
    if (changes.length === 0) return;
    const worldVersion = this.state.save();
    for (const change of changes) observer.changed({ ...change, worldVersion });
  }

  /** A change of kind at path, with the content versions of the file entries before and after it. */
  private change(
    execution: WorldExecution,
    path: string,
    kind: WorldChange["kind"],
    before: FsEntry | undefined,
    after: FsEntry | undefined,
  ): Omit<WorldChange, "worldVersion"> {
    const was = this.state.versionOfEntry(before);
    const is = this.state.versionOfEntry(after);
    return {
      execution,
      path,
      kind,
      ...(was === undefined ? {} : { before: was }),
      ...(is === undefined ? {} : { after: is }),
    };
  }

  private difference(
    execution: WorldExecution,
    path: string,
    before: FsEntry | undefined,
    after: FsEntry | undefined,
  ): Omit<WorldChange, "worldVersion">[] {
    if (before === undefined && after === undefined) return [];
    if (before === undefined) {
      return [this.change(execution, path, "create", undefined, after)];
    }
    if (after === undefined) {
      return [this.change(execution, path, "remove", before, undefined)];
    }
    if (before.type !== after.type) {
      return [
        this.change(execution, path, "remove", before, undefined),
        this.change(execution, path, "create", undefined, after),
      ];
    }
    const modified =
      (before.type === "file" &&
        this.state.versionOfEntry(before) !==
          this.state.versionOfEntry(after)) ||
      (before.type === "symlink" &&
        after.type === "symlink" &&
        before.target !== after.target);
    if (modified)
      return [this.change(execution, path, "modify", before, after)];
    if (before.mode !== after.mode) {
      return [this.change(execution, path, "metadata", before, after)];
    }
    return [];
  }

  /**
   * The path of the entry a read acts on: the final target of the links on
   * path when the read follows links, else the link itself.
   */
  private readPath(path: string, follows: boolean): string {
    try {
      return follows
        ? this.state.fs.resolvePathWithSymlinks(path)
        : this.state.fs.resolveIntermediateSymlinks(path);
    } catch {
      // A loop of links has no final target; the read names path itself.
      return normalizePath(path);
    }
  }

  private reportRead(
    execution: WorldExecution,
    path: string,
    kind: WorldReadKind,
    version?: string,
    follows = true,
  ): void {
    this.observer?.read({
      execution,
      path: this.readPath(path, follows),
      kind,
      ...(version === undefined ? {} : { version }),
    });
  }

  /** Saves the current state and gives its world version, after the operations already started. */
  version(): Promise<string> {
    return this.serialized(async () => this.state.save());
  }

  /** Runs an IFileSystem method on the world's files for execution. */
  call(
    execution: WorldExecution,
    method: FsMethod,
    args: readonly unknown[],
  ): Promise<unknown> {
    return this.serialized(async () => {
      const fs = this.state.fs as unknown as Record<
        FsMethod,
        (...args: unknown[]) => Promise<unknown>
      >;
      const path = args[0] as string;
      const read = Object.hasOwn(READS, method)
        ? READS[method as ReadMethod]
        : undefined;
      if (read !== undefined) {
        // lstat and readlink act on a link itself; the other reads follow it.
        const follows = method !== "lstat" && method !== "readlink";
        let result: unknown;
        try {
          result = await fs[method](...args);
        } catch (error) {
          this.reportRead(execution, path, "stat", undefined, follows);
          throw error;
        }
        const version =
          read === "content"
            ? this.state.versionOf(await this.state.fs.readFileBuffer(path))
            : undefined;
        this.reportRead(execution, path, read, version, follows);
        return result;
      }
      const move =
        method === "mv"
          ? {
              from: this.state.fs.resolveIntermediateSymlinks(path),
              to: this.state.fs.resolveIntermediateSymlinks(args[1] as string),
            }
          : undefined;
      return this.state.trackAsync(
        () => fs[method](...args),
        (prior) => this.report(execution, prior, move),
      );
    });
  }

  /** Runs a synchronous change for execution and reports it. */
  private changeNow<T>(execution: WorldExecution, operation: () => T): T {
    return this.state.track(operation, (prior) =>
      this.report(execution, prior),
    );
  }

  async readEntry(
    path: string,
    execution: WorldExecution,
  ): Promise<WorldEntry | undefined> {
    return this.serialized(async () => {
      let stat: FsStat;
      try {
        stat = await this.state.fs.stat(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
        this.reportRead(execution, path, "stat");
        return undefined;
      }
      if (stat.isDirectory) {
        this.reportRead(execution, path, "stat");
        return { kind: "directory" };
      }
      const bytes = await this.state.fs.readFileBuffer(path);
      this.reportRead(execution, path, "content", this.state.versionOf(bytes));
      return { kind: "file", content: Buffer.from(bytes) };
    });
  }

  async stat(
    path: string,
    execution: WorldExecution,
  ): Promise<WorldStat | undefined> {
    return this.serialized(async () => {
      this.reportRead(execution, path, "stat");
      try {
        const stat = await this.state.fs.stat(path);
        return stat.isDirectory
          ? { kind: "directory", size: 0 }
          : { kind: "file", size: stat.size };
      } catch (error) {
        if (!isMissing(error)) throw error;
        return undefined;
      }
    });
  }

  private exists(path: string): boolean {
    return (
      this.state.entryAt(this.state.fs.resolveIntermediateSymlinks(path)) !==
      undefined
    );
  }

  writeFile(
    path: string,
    content: Uint8Array,
    execution: WorldExecution,
    exclusive: boolean,
  ): Promise<void> {
    return this.serialized(async () => {
      if (exclusive && this.exists(path)) {
        throw fsError("EEXIST", `EEXIST: file already exists, open '${path}'`);
      }
      this.changeNow(execution, () =>
        this.state.fs.writeFileSync(path, content.slice()),
      );
    });
  }

  makeDirectory(path: string, execution: WorldExecution): Promise<void> {
    return this.serialized(async () => {
      this.changeNow(execution, () =>
        this.state.fs.mkdirSync(path, { recursive: true }),
      );
    });
  }

  remove(path: string, execution: WorldExecution): Promise<void> {
    return this.serialized(async () => {
      const options: RmOptions = { recursive: true };
      this.changeNow(execution, () => this.state.fs.rmSync(path, options));
    });
  }

  /**
   * An output file at path, written in chunks. The world sees each chunk at
   * once; creating the file, closing it, and discarding it are reported.
   */
  createOutput(path: string, execution: WorldExecution): WorldOutputFile {
    if (this.exists(path)) {
      throw fsError("EEXIST", `EEXIST: file already exists, open '${path}'`);
    }
    this.changeNow(execution, () =>
      this.state.fs.writeFileSync(path, new Uint8Array(0)),
    );
    let buffer = new Uint8Array(0);
    let length = 0;
    let open = true;
    const ended = () => new Error(`output file already ended: ${path}`);
    return {
      write: (chunk) => {
        if (!open) throw ended();
        if (length + chunk.length > buffer.length) {
          const grown = new Uint8Array(
            Math.max(buffer.length * 2, length + chunk.length),
          );
          grown.set(buffer.subarray(0, length));
          buffer = grown;
        }
        buffer.set(chunk, length);
        length += chunk.length;
        // Each write stores a new view, so earlier views never change.
        this.state.track(
          () => this.state.fs.writeFileSync(path, buffer.subarray(0, length)),
          () => undefined,
        );
      },
      close: () => {
        if (!open) return;
        open = false;
        const content = buffer.slice(0, length);
        this.state.track(
          () => this.state.fs.writeFileSync(path, content),
          () => undefined,
        );
        // The writes before were not reported, so the change runs from the
        // empty file createOutput reported to the whole content.
        const worldVersion = this.state.save();
        this.observer?.changed({
          execution,
          path: normalizePath(path),
          kind: "modify",
          before: this.state.versionOf(new Uint8Array(0)),
          after: this.state.versionOf(content),
          worldVersion,
        });
      },
      discard: () => {
        open = false;
        this.changeNow(execution, () => this.state.fs.rmSync(path));
      },
    };
  }
}
