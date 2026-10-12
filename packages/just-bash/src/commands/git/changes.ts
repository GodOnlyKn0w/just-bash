/**
 * The states git compares (a tree, the index, the working tree) as maps
 * from path to file, and the changes between two of them.
 */
import { comparePaths, type IndexEntry } from "./index-file.js";
import {
  blobOid,
  MODE_SYMLINK,
  type Repository,
  type TreeFile,
} from "./repository.js";

/** A file of one side of a comparison. A file of the working tree has its content there and not in the object database. */
export interface FileSide extends TreeFile {
  readonly inWorktree?: boolean;
}

export type FileMap = Map<string, FileSide>;

/**
 * One changed path. `status` is the letter of `git diff --name-status`: A
 * added, D deleted, M modified, T type changed, R renamed. A rename has
 * `oldPath` and `similarity`, a percentage.
 */
export interface Change {
  readonly status: "A" | "D" | "M" | "T" | "R";
  readonly path: string;
  readonly oldPath?: string;
  readonly similarity?: number;
  readonly before?: FileSide;
  readonly after?: FileSide;
}

/** The entries of the index without conflict stages, by path. */
export function indexFiles(entries: readonly IndexEntry[]): FileMap {
  const files: FileMap = new Map();
  for (const entry of entries) {
    if (entry.stage === 0) {
      files.set(entry.path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return files;
}

/** The files of the tree of a commit; an empty map for undefined. */
export async function commitFiles(
  repository: Repository,
  commit: string | undefined,
): Promise<FileMap> {
  if (commit === undefined) return new Map();
  return repository.treeFiles((await repository.readCommit(commit)).tree);
}

/** The working tree file for each index entry. */
export interface WorktreeScan {
  /** The file at the path of each entry; no element for a path without a file. */
  readonly files: FileMap;
  /** Entries whose file was read and found equal to the entry: their size and time to store in the index. */
  readonly refreshed: Map<string, { size: number; mtime: number }>;
}

/**
 * Compares the working tree with the index entries. A file whose size and
 * modification time equal the entry's, and whose time is before the index
 * file was written, is taken as unchanged without reading it; the content of
 * every other file is read and hashed.
 */
export async function scanWorktree(
  repository: Repository,
  entries: readonly IndexEntry[],
): Promise<WorktreeScan> {
  const indexTime = await repository.indexTime();
  const files: FileMap = new Map();
  const refreshed = new Map<string, { size: number; mtime: number }>();
  for (const entry of entries) {
    if (entry.stage !== 0) continue;
    const file = await repository.worktreeFile(entry.path);
    if (file === undefined) continue;
    const entryTime =
      entry.mtimeSeconds * 1000 + Math.floor(entry.mtimeNanoseconds / 1e6);
    if (
      file.mode === entry.mode &&
      file.size === entry.size &&
      file.mtime === entryTime &&
      indexTime !== undefined &&
      entryTime < indexTime
    ) {
      files.set(entry.path, { oid: entry.oid, mode: entry.mode });
      continue;
    }
    const oid =
      file.mode !== MODE_SYMLINK && file.size !== entry.size
        ? undefined
        : blobOid(await repository.worktreeContent(entry.path, file.mode));
    if (oid === entry.oid) {
      files.set(
        entry.path,
        file.mode === entry.mode
          ? { oid, mode: file.mode }
          : { oid, mode: file.mode, inWorktree: true },
      );
      if (file.mode === entry.mode) {
        refreshed.set(entry.path, { size: file.size, mtime: file.mtime });
      }
    } else {
      files.set(entry.path, {
        oid:
          oid ??
          blobOid(await repository.worktreeContent(entry.path, file.mode)),
        mode: file.mode,
        inWorktree: true,
      });
    }
  }
  return { files, refreshed };
}

/** The content of one side; empty for an absent side. */
export async function sideContent(
  repository: Repository,
  path: string,
  side: FileSide | undefined,
): Promise<Uint8Array> {
  if (side === undefined) return new Uint8Array(0);
  return side.inWorktree
    ? repository.worktreeContent(path, side.mode)
    : repository.readBlob(side.oid);
}

function fileType(mode: number): number {
  return mode & 0o170000;
}

/** A path limit: a path matches when it equals one of the prefixes or lies below one; no prefixes match every path. */
export function matchesPaths(
  path: string,
  prefixes: readonly string[],
): boolean {
  return (
    prefixes.length === 0 ||
    prefixes.some(
      (prefix) =>
        prefix === "" || path === prefix || path.startsWith(`${prefix}/`),
    )
  );
}

/** The changes from before to after, sorted by path, without rename detection. */
export function compareFiles(
  before: FileMap,
  after: FileMap,
  prefixes: readonly string[] = [],
): Change[] {
  const changes: Change[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort(comparePaths)) {
    if (!matchesPaths(path, prefixes)) continue;
    const old = before.get(path);
    const fresh = after.get(path);
    if (old === undefined && fresh !== undefined) {
      changes.push({ status: "A", path, after: fresh });
    } else if (old !== undefined && fresh === undefined) {
      changes.push({ status: "D", path, before: old });
    } else if (old !== undefined && fresh !== undefined) {
      if (old.oid === fresh.oid && old.mode === fresh.mode) continue;
      changes.push({
        status: fileType(old.mode) === fileType(fresh.mode) ? "M" : "T",
        path,
        before: old,
        after: fresh,
      });
    }
  }
  return changes;
}

// ---- Rename detection (git's diffcore-rename and diffcore-delta) ----

const HASH_BASE = 107927;
const FULL_SCORE = 60000;
const MINIMUM_SCORE = 30000;

/** Bytes of content by the hash of the chunk they are in: a chunk ends at a line feed or after 64 bytes. */
function chunkCounts(content: Uint8Array, text: boolean): Map<number, number> {
  const counts = new Map<number, number>();
  let n = 0;
  let accum1 = 0;
  let accum2 = 0;
  for (let i = 0; i < content.length; ) {
    const c = content[i++];
    // A carriage return before a line feed does not count in text.
    if (text && c === 13 && i < content.length && content[i] === 10) continue;
    const old1 = accum1;
    accum1 = ((accum1 << 7) ^ (accum2 >>> 25)) >>> 0;
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0;
    accum1 = (accum1 + c) >>> 0;
    if (++n < 64 && c !== 10) continue;
    const hash = (accum1 + Math.imul(accum2, 0x61)) >>> 0;
    counts.set(hash % HASH_BASE, (counts.get(hash % HASH_BASE) ?? 0) + n);
    n = 0;
    accum1 = 0;
    accum2 = 0;
  }
  if (n > 0) {
    const hash = (accum1 + Math.imul(accum2, 0x61)) >>> 0;
    counts.set(hash % HASH_BASE, (counts.get(hash % HASH_BASE) ?? 0) + n);
  }
  return counts;
}

function looksBinary(content: Uint8Array): boolean {
  const end = Math.min(content.length, 8000);
  for (let i = 0; i < end; i++) if (content[i] === 0) return true;
  return false;
}

/** git's similarity score of two contents, from 0 to FULL_SCORE. */
function similarityScore(source: Uint8Array, target: Uint8Array): number {
  const larger = Math.max(source.length, target.length);
  const smaller = Math.min(source.length, target.length);
  if (larger === 0) return 0;
  if (smaller < (larger * MINIMUM_SCORE) / FULL_SCORE) return 0;
  const sourceCounts = chunkCounts(source, !looksBinary(source));
  const targetCounts = chunkCounts(target, !looksBinary(target));
  let copied = 0;
  for (const [hash, count] of sourceCounts) {
    copied += Math.min(count, targetCounts.get(hash) ?? 0);
  }
  return Math.floor((copied * FULL_SCORE) / larger);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Pairs deleted and added files as renames the way git does by default: a
 * pair with equal content first, then the pairs with a similarity of at
 * least 50 percent, best first. The result is sorted by the new path.
 */
export async function detectRenames(
  repository: Repository,
  changes: readonly Change[],
): Promise<Change[]> {
  const deleted = changes.filter((change) => change.status === "D");
  const added = changes.filter((change) => change.status === "A");
  if (deleted.length === 0 || added.length === 0) return [...changes];
  const sources = new Set(deleted);
  const targets = new Set(added);
  const renames: Change[] = [];
  const pair = (source: Change, target: Change, score: number) => {
    sources.delete(source);
    targets.delete(target);
    renames.push({
      status: "R",
      path: target.path,
      oldPath: source.path,
      similarity: Math.floor((score * 100) / FULL_SCORE),
      before: source.before,
      after: target.after,
    });
  };
  for (const target of added) {
    const same = [...sources].filter(
      (source) =>
        source.before?.oid === target.after?.oid &&
        fileType(source.before?.mode ?? 0) ===
          fileType(target.after?.mode ?? 0),
    );
    const source =
      same.find((source) => baseName(source.path) === baseName(target.path)) ??
      same[0];
    if (source !== undefined) pair(source, target, FULL_SCORE);
  }
  if (sources.size > 0 && targets.size > 0) {
    const content = new Map<Change, Uint8Array>();
    const load = async (change: Change, side: FileSide | undefined) => {
      let bytes = content.get(change);
      if (bytes === undefined) {
        bytes = await sideContent(repository, change.path, side);
        content.set(change, bytes);
      }
      return bytes;
    };
    const candidates: {
      source: Change;
      target: Change;
      score: number;
      nameScore: number;
    }[] = [];
    for (const target of targets) {
      for (const source of sources) {
        if (
          fileType(source.before?.mode ?? 0) !==
          fileType(target.after?.mode ?? 0)
        ) {
          continue;
        }
        const score = similarityScore(
          await load(source, source.before),
          await load(target, target.after),
        );
        if (score >= MINIMUM_SCORE) {
          candidates.push({
            source,
            target,
            score,
            nameScore: baseName(source.path) === baseName(target.path) ? 1 : 0,
          });
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score || b.nameScore - a.nameScore);
    for (const { source, target, score } of candidates) {
      if (sources.has(source) && targets.has(target)) {
        pair(source, target, score);
      }
    }
  }
  const paired = new Set<string>();
  for (const rename of renames) {
    paired.add(rename.path);
    if (rename.oldPath !== undefined) paired.add(rename.oldPath);
  }
  return [
    ...changes.filter(
      (change) =>
        !(
          (change.status === "A" || change.status === "D") &&
          paired.has(change.path)
        ),
    ),
    ...renames,
  ].sort((a, b) => comparePaths(a.path, b.path));
}
