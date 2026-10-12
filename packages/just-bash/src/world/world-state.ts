import { fsError } from "../fs/fs-error.js";
import { InMemoryFs } from "../fs/in-memory-fs/in-memory-fs.js";
import type { FsEntry } from "../fs/interface.js";
import { contentVersion, type WorldVersionEntry } from "./interface.js";
import type { SnapshotStore } from "./snapshot-store.js";

/** The entry each changed path had before the changes; undefined when it had none. */
export type PriorEntries = Map<string, FsEntry | undefined>;

/** One row of a tree object: name, kind (f file, d directory, l symlink), mode, and the content version, tree id, or link target. */
type TreeRow = [name: string, kind: "f" | "d" | "l", mode: number, ref: string];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function childPath(directory: string, name: string): string {
  return directory === "/" ? `/${name}` : `${directory}/${name}`;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function contentBytes(entry: FsEntry & { type: "file" }): Uint8Array {
  if (!("content" in entry)) {
    throw new Error("lazy files cannot be part of a world version");
  }
  return typeof entry.content === "string"
    ? textEncoder.encode(entry.content)
    : entry.content;
}

function readTree(store: SnapshotStore, id: string): TreeRow[] | undefined {
  const bytes = store.get("tree", id);
  return bytes === undefined
    ? undefined
    : (JSON.parse(textDecoder.decode(bytes)) as TreeRow[]);
}

/**
 * The state of a world: an InMemoryFs whose every entry change is mirrored
 * here, so the world version can be recomputed by visiting only the
 * directories on the paths that changed.
 *
 * A directory's tree object lists its children sorted by name; a world
 * version is the id of the root tree. Modification times are not part of the
 * state: the same files, directories, links, and modes give the same version.
 */
export class WorldState {
  readonly fs: InMemoryFs;
  private readonly store: SnapshotStore;
  private readonly entries = new Map<string, FsEntry>();
  private readonly children = new Map<string, Set<string>>();
  /** Tree ids of directories unchanged since their tree was computed. */
  private readonly trees = new Map<string, string>();
  private readonly contentVersions = new WeakMap<Uint8Array, string>();
  private tracking: PriorEntries | undefined;

  constructor(store: SnapshotStore, maxTotalBytes?: number) {
    this.store = store;
    this.fs = new InMemoryFs(undefined, {
      maxTotalBytes,
      onEntryChange: (path, entry) => this.entryChanged(path, entry),
    });
  }

  private entryChanged(path: string, entry: FsEntry | undefined): void {
    if (this.tracking !== undefined && !this.tracking.has(path)) {
      this.tracking.set(path, this.entries.get(path));
    }
    if (entry === undefined) {
      this.entries.delete(path);
      this.children.delete(path);
      this.children
        .get(parentOf(path))
        ?.delete(path.slice(path.lastIndexOf("/") + 1));
    } else {
      this.entries.set(path, entry);
      if (path !== "/") {
        this.children
          .get(parentOf(path))
          ?.add(path.slice(path.lastIndexOf("/") + 1));
      }
      if (entry.type === "directory") {
        if (!this.children.has(path)) this.children.set(path, new Set());
      } else {
        this.children.delete(path);
      }
    }
    for (let directory = path; ; directory = parentOf(directory)) {
      this.trees.delete(directory);
      if (directory === "/") break;
    }
  }

  /** The content version of a file entry, storing its bytes. */
  private fileVersion(entry: FsEntry & { type: "file" }): string {
    const bytes = contentBytes(entry);
    const version = this.versionOf(bytes);
    this.store.put("content", version, bytes);
    return version;
  }

  /**
   * Runs operation and gives the prior entries of the paths it changed to
   * done, also when it throws. Tracking nests: an operation that starts while
   * another is suspended at an await is tracked on its own, provided it does
   * not await itself.
   */
  track<T>(operation: () => T, done: (prior: PriorEntries) => void): T {
    const outer = this.tracking;
    const prior: PriorEntries = new Map();
    this.tracking = prior;
    try {
      return operation();
    } finally {
      this.tracking = outer;
      done(prior);
    }
  }

  /**
   * track for an operation that awaits. The caller runs one such operation at
   * a time; synchronous operations may run while it is suspended.
   */
  async trackAsync<T>(
    operation: () => Promise<T>,
    done: (prior: PriorEntries) => void,
  ): Promise<T> {
    const prior: PriorEntries = new Map();
    this.tracking = prior;
    try {
      return await operation();
    } finally {
      this.tracking = undefined;
      done(prior);
    }
  }

  /** Content version of bytes, remembered for the same array. */
  versionOf(bytes: Uint8Array): string {
    let version = this.contentVersions.get(bytes);
    if (version === undefined) {
      version = contentVersion(bytes);
      this.contentVersions.set(bytes, version);
    }
    return version;
  }

  /** Content version of a file entry, storing its bytes; undefined for other entries. */
  versionOfEntry(entry: FsEntry | undefined): string | undefined {
    return entry?.type === "file" ? this.fileVersion(entry) : undefined;
  }

  entryAt(path: string): FsEntry | undefined {
    return this.entries.get(path);
  }

  private treeId(directory: string): string {
    const cached = this.trees.get(directory);
    if (cached !== undefined) return cached;
    const rows: TreeRow[] = [];
    for (const name of [...(this.children.get(directory) ?? [])].sort()) {
      const path = childPath(directory, name);
      const entry = this.entries.get(path) as FsEntry;
      if (entry.type === "directory") {
        rows.push([name, "d", entry.mode, this.treeId(path)]);
      } else if (entry.type === "symlink") {
        rows.push([name, "l", entry.mode, entry.target]);
      } else {
        rows.push([name, "f", entry.mode, this.fileVersion(entry)]);
      }
    }
    const bytes = textEncoder.encode(JSON.stringify(rows));
    const id = contentVersion(bytes);
    this.store.put("tree", id, bytes);
    this.trees.set(directory, id);
    return id;
  }

  /** Saves the current state to the store and returns its world version. */
  save(): string {
    const version = this.treeId("/");
    this.store.addVersion(version);
    return version;
  }

  /**
   * The state saved as version, with every directory's tree id already known.
   * Fails with ENOENT when the store does not hold the version or an object it
   * refers to.
   */
  static async load(
    store: SnapshotStore,
    version: string,
    maxTotalBytes?: number,
  ): Promise<WorldState> {
    const missing = () =>
      fsError(
        "ENOENT",
        `ENOENT: world version ${version} is not in the snapshot store`,
      );
    if (!store.hasVersion(version)) throw missing();
    const state = new WorldState(store, maxTotalBytes);
    const trees = new Map<string, string>();
    const visit = async (directory: string, id: string): Promise<void> => {
      const rows = readTree(store, id);
      if (rows === undefined) throw missing();
      trees.set(directory, id);
      for (const [name, kind, mode, ref] of rows) {
        const path = childPath(directory, name);
        if (kind === "d") {
          state.fs.mkdirSync(path);
          await state.fs.chmod(path, mode);
          await visit(path, ref);
        } else if (kind === "l") {
          await state.fs.symlink(ref, path);
        } else {
          const bytes = store.get("content", ref);
          if (bytes === undefined) throw missing();
          state.contentVersions.set(bytes, ref);
          state.fs.writeFileSync(path, bytes, undefined, { mode });
        }
      }
    };
    await visit("/", version);
    for (const [directory, id] of trees) state.trees.set(directory, id);
    return state;
  }
}

/** Every path of version sorted by path, the root included; undefined when the store does not hold it. */
export function versionEntries(
  store: SnapshotStore,
  version: string,
): WorldVersionEntry[] | undefined {
  if (!store.hasVersion(version)) return undefined;
  const entries: WorldVersionEntry[] = [{ path: "/", kind: "directory" }];
  const visit = (directory: string, id: string): boolean => {
    const rows = readTree(store, id);
    if (rows === undefined) return false;
    for (const [name, kind, , ref] of rows) {
      const path = childPath(directory, name);
      if (kind === "d") {
        entries.push({ path, kind: "directory" });
        if (!visit(path, ref)) return false;
      } else if (kind === "l") {
        entries.push({ path, kind: "symlink", target: ref });
      } else {
        entries.push({ path, kind: "file", version: ref });
      }
    }
    return true;
  };
  if (!visit("/", version)) return undefined;
  return entries.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
