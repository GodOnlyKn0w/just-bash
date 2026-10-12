import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Where a store lives, in the form the options of a world forked from it carry. */
export type StoreLocation =
  | { readonly snapshots: string }
  | { readonly memory: string };

/**
 * `content` objects are file bytes keyed by their content version; `tree`
 * objects are serialized directory listings keyed by the content version of
 * the serialization.
 */
export type ObjectKind = "content" | "tree";

/**
 * Content-addressed storage of world versions. A world version is the id of a
 * root tree recorded with addVersion. Objects and versions never change once
 * stored, so a world version always denotes the same world.
 */
export interface SnapshotStore {
  readonly location: StoreLocation;
  has(kind: ObjectKind, id: string): boolean;
  /** Stores bytes under id unless an object with that id is already stored. */
  put(kind: ObjectKind, id: string, bytes: Uint8Array): void;
  get(kind: ObjectKind, id: string): Uint8Array | undefined;
  addVersion(id: string): void;
  hasVersion(id: string): boolean;
}

/** Ids are lowercase hex; the directory store only uses such text as file names. */
const ID = /^[0-9a-f]+$/;

class MemoryStore implements SnapshotStore {
  readonly location: StoreLocation;
  private readonly objects: Record<ObjectKind, Map<string, Uint8Array>> = {
    content: new Map(),
    tree: new Map(),
  };
  private readonly versions = new Set<string>();

  constructor(id: string) {
    this.location = { memory: id };
  }

  has(kind: ObjectKind, id: string): boolean {
    return this.objects[kind].has(id);
  }

  put(kind: ObjectKind, id: string, bytes: Uint8Array): void {
    // Copies on the way in and out, so no caller can change a stored object.
    if (!this.objects[kind].has(id)) this.objects[kind].set(id, bytes.slice());
  }

  get(kind: ObjectKind, id: string): Uint8Array | undefined {
    return this.objects[kind].get(id)?.slice();
  }

  addVersion(id: string): void {
    this.versions.add(id);
  }

  hasVersion(id: string): boolean {
    return this.versions.has(id);
  }
}

const memoryStores = new Map<string, MemoryStore>();

/** The in-memory store registered under id in this process; a new one when id is omitted or unknown. */
export function memoryStore(id: string = randomUUID()): SnapshotStore {
  let store = memoryStores.get(id);
  if (store === undefined) {
    store = new MemoryStore(id);
    memoryStores.set(id, store);
  }
  return store;
}

const DIRECTORIES: Record<ObjectKind | "version", string> = {
  content: "contents",
  tree: "trees",
  version: "versions",
};

/**
 * A store in a directory: contents/<id>, trees/<id>, and an empty
 * versions/<id> for each world version. Every file is written to a temporary
 * name and renamed, so a file that exists is complete.
 */
class DirectoryStore implements SnapshotStore {
  readonly location: StoreLocation;
  private readonly directory: string;
  /** Ids known to be on disk, so repeated puts skip the existence check. */
  private readonly known = new Set<string>();

  constructor(directory: string) {
    this.directory = directory;
    this.location = { snapshots: directory };
    for (const name of Object.values(DIRECTORIES)) {
      mkdirSync(join(directory, name), { recursive: true });
    }
  }

  private path(kind: ObjectKind | "version", id: string): string | undefined {
    return ID.test(id)
      ? join(this.directory, DIRECTORIES[kind], id)
      : undefined;
  }

  private exists(kind: ObjectKind | "version", id: string): boolean {
    const key = `${kind}/${id}`;
    if (this.known.has(key)) return true;
    const path = this.path(kind, id);
    if (path === undefined || !existsSync(path)) return false;
    this.known.add(key);
    return true;
  }

  private write(kind: ObjectKind | "version", id: string, bytes: Uint8Array) {
    if (this.exists(kind, id)) return;
    const path = this.path(kind, id);
    if (path === undefined) throw new Error(`invalid object id: ${id}`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, bytes);
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    this.known.add(`${kind}/${id}`);
  }

  has(kind: ObjectKind, id: string): boolean {
    return this.exists(kind, id);
  }

  put(kind: ObjectKind, id: string, bytes: Uint8Array): void {
    this.write(kind, id, bytes);
  }

  get(kind: ObjectKind, id: string): Uint8Array | undefined {
    if (!this.exists(kind, id)) return undefined;
    return readFileSync(this.path(kind, id) as string);
  }

  addVersion(id: string): void {
    this.write("version", id, new Uint8Array(0));
  }

  hasVersion(id: string): boolean {
    return this.exists("version", id);
  }
}

export function directoryStore(directory: string): SnapshotStore {
  return new DirectoryStore(directory);
}
