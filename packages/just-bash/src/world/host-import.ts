import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { fsError } from "../fs/fs-error.js";

/** An entry below an imported host directory. `path` is relative to the directory, its segments joined by "/". */
export type HostEntry =
  | {
      readonly path: string;
      readonly kind: "file";
      readonly mode: number;
      readonly content: Uint8Array;
    }
  | { readonly path: string; readonly kind: "directory"; readonly mode: number }
  | {
      readonly path: string;
      readonly kind: "symlink";
      readonly target: string;
    };

/** The permission bits of a host mode: its low 12 bits. */
const PERMISSIONS = 0o7777;

/**
 * The entries below the host directory `from`. A directory comes before the
 * entries in it, and the entries of one directory come in the code unit order
 * of their names. A path in `exclude`, relative to `from`, leaves out its
 * entry and all entries below it. A symbolic link below `from` is given with
 * its target text; a `from` that is a link to a directory names that
 * directory.
 *
 * Fails with code ENOENT when `from` does not exist, with code ENOTDIR when
 * it is not a directory, and with an error naming the host path of an entry
 * that is a FIFO, a socket, or a device file.
 */
export function* hostEntries(
  from: string,
  exclude: readonly string[],
): Generator<HostEntry> {
  let names: string[];
  try {
    names = readdirSync(from);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") {
      throw fsError("ENOENT", `ENOENT: no such directory, import '${from}'`);
    }
    if (code === "ENOTDIR") {
      throw fsError("ENOTDIR", `ENOTDIR: not a directory, import '${from}'`);
    }
    throw error;
  }
  const excluded = new Set(
    exclude.map((path) => path.split("/").filter(Boolean).join("/")),
  );
  yield* entriesIn(from, "", names, excluded);
}

function* entriesIn(
  directory: string,
  prefix: string,
  names: string[],
  excluded: ReadonlySet<string>,
): Generator<HostEntry> {
  for (const name of names.sort()) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (excluded.has(path)) continue;
    const hostPath = join(directory, name);
    const stat = lstatSync(hostPath);
    if (stat.isSymbolicLink()) {
      yield { path, kind: "symlink", target: readlinkSync(hostPath) };
    } else if (stat.isDirectory()) {
      yield { path, kind: "directory", mode: stat.mode & PERMISSIONS };
      yield* entriesIn(hostPath, path, readdirSync(hostPath), excluded);
    } else if (stat.isFile()) {
      yield {
        path,
        kind: "file",
        mode: stat.mode & PERMISSIONS,
        content: readFileSync(hostPath),
      };
    } else {
      throw new Error(
        `import: ${hostPath} is not a regular file, a directory, or a symbolic link`,
      );
    }
  }
}
