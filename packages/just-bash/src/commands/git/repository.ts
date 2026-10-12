/**
 * A git repository in the command's file system. Objects, pack files, and
 * refs are read and written by isomorphic-git through an adapter over
 * IFileSystem, so every file the repository touches is a file operation of
 * the git command that runs.
 */
import { createHash } from "node:crypto";
import {
  deleteRef,
  expandOid,
  listBranches,
  type PromiseFsClient,
  readBlob,
  readCommit,
  readObject,
  readTree,
  resolveRef,
  writeBlob,
  writeObject,
  writeRef,
  writeTree,
} from "isomorphic-git";
import type { IFileSystem } from "../../fs/interface.js";
import { type IndexEntry, parseIndex, serializeIndex } from "./index-file.js";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const NULL_OID = "0000000000000000000000000000000000000000";

const MODE_FILE = 0o100644;
const MODE_EXECUTABLE = 0o100755;
export const MODE_SYMLINK = 0o120000;
const MODE_TREE = 0o040000;

/** A failure that ends the git command with an exit code and a message on stderr. */
export class GitError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 128) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** A file at a path of a tree or of the index. */
export interface TreeFile {
  readonly oid: string;
  readonly mode: number;
}

export interface Identity {
  readonly name: string;
  readonly email: string;
  /** Seconds since the epoch. */
  readonly timestamp: number;
  /** Offset from UTC in the form git writes: "+0800". */
  readonly zone: string;
}

export interface Commit {
  readonly oid: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: Identity;
  readonly committer: Identity;
  readonly message: string;
}

/** The code of a file system error: its `code`, else the errno name its message starts with. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string"
    ? /^(E[A-Z]+)\b/.exec(message)?.[1]
    : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Rethrows error with its errno name as `code`, which isomorphic-git reads. */
function withCode(error: unknown): never {
  const code = errorCode(error);
  if (code !== undefined && typeof error === "object" && error !== null) {
    (error as { code?: string }).code = code;
  }
  throw error;
}

/** The `fs` client isomorphic-git takes, over an IFileSystem. */
function isomorphicFs(fs: IFileSystem): PromiseFsClient {
  const stat = (follow: boolean) => async (path: string) => {
    const stats = await (follow ? fs.stat(path) : fs.lstat(path)).catch(
      withCode,
    );
    const time = stats.mtime.getTime();
    return {
      mode: stats.mode,
      size: stats.size,
      ino: 0,
      dev: 0,
      uid: 0,
      gid: 0,
      mtimeMs: time,
      ctimeMs: time,
      isFile: () => stats.isFile,
      isDirectory: () => stats.isDirectory,
      isSymbolicLink: () => stats.isSymbolicLink,
    };
  };
  return {
    promises: {
      readFile: async (
        path: string,
        options?: string | { encoding?: string },
      ) => {
        const bytes = await fs.readFileBuffer(path).catch(withCode);
        const encoding =
          typeof options === "string" ? options : options?.encoding;
        return encoding === "utf8" ? textDecoder.decode(bytes) : bytes;
      },
      writeFile: (path: string, data: string | Uint8Array) =>
        fs.writeFile(path, data).catch(withCode),
      unlink: (path: string) => fs.rm(path).catch(withCode),
      readdir: (path: string) => fs.readdir(path).catch(withCode),
      mkdir: (path: string) => fs.mkdir(path).catch(withCode),
      rmdir: (path: string) => fs.rm(path).catch(withCode),
      stat: stat(true),
      lstat: stat(false),
      readlink: (path: string) => fs.readlink(path).catch(withCode),
      symlink: (target: string, path: string) =>
        fs.symlink(target, path).catch(withCode),
      chmod: (path: string, mode: number) =>
        fs.chmod(path, mode).catch(withCode),
    },
  };
}

/** The object id git gives a blob with these bytes. */
export function blobOid(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/** Values of a git config file by "section.key" or "section.subsection.key"; section and key in lower case. */
function parseConfig(text: string): Map<string, string> {
  const values = new Map<string, string>();
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header =
      /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/.exec(line);
    if (header) {
      const subsection = header[2]?.replace(/\\(.)/g, "$1");
      section =
        header[1].toLowerCase() +
        (subsection === undefined ? "" : `.${subsection}`);
      continue;
    }
    const pair = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!pair || section === "") continue;
    let value = pair[2] ?? "true";
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    if (quoted) value = quoted[1].replace(/\\(.)/g, "$1");
    else value = value.replace(/\s+[#;].*$/, "").trim();
    values.set(`${section}.${pair[1].toLowerCase()}`, value);
  }
  return values;
}

const ZONE = /^[+-]\d{4}$/;

/**
 * A date in one of the forms `@<seconds> <zone>`, `<seconds> <zone>`, or
 * ISO 8601 (`2024-01-02T03:04:05+08:00`, with a space for `T`, and with `Z`,
 * `+0800`, or no zone, which means UTC).
 */
function parseDate(text: string): { timestamp: number; zone: string } {
  const raw = /^@?(\d+)(?:\s+([+-]\d{4}))?$/.exec(text.trim());
  if (raw) return { timestamp: Number(raw[1]), zone: raw[2] ?? "+0000" };
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(
      text.trim(),
    );
  if (!iso) throw new GitError(`fatal: invalid date format: ${text}`);
  const zone =
    iso[7] === undefined || iso[7] === "Z" ? "+0000" : iso[7].replace(":", "");
  const local =
    Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +iso[6]) / 1000;
  return { timestamp: local - zoneSeconds(zone), zone };
}

function zoneSeconds(zone: string): number {
  if (!ZONE.test(zone)) return 0;
  const sign = zone.startsWith("-") ? -1 : 1;
  return sign * (Number(zone.slice(1, 3)) * 3600 + Number(zone.slice(3)) * 60);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** A date in git's default format: `Wed Nov 15 06:13:20 2023 +0800`. */
export function formatDate(identity: Identity): string {
  const local = new Date(
    (identity.timestamp + zoneSeconds(identity.zone)) * 1000,
  );
  const two = (value: number) => String(value).padStart(2, "0");
  return `${DAYS[local.getUTCDay()]} ${MONTHS[local.getUTCMonth()]} ${local.getUTCDate()} ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}:${two(local.getUTCSeconds())} ${local.getUTCFullYear()} ${identity.zone}`;
}

function parseIdentity(person: {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
}): Identity {
  // isomorphic-git gives the offset in minutes west of UTC.
  const minutes = -person.timezoneOffset;
  const absolute = Math.abs(minutes);
  const zone = `${minutes < 0 ? "-" : "+"}${String(Math.floor(absolute / 60)).padStart(2, "0")}${String(absolute % 60).padStart(2, "0")}`;
  return {
    name: person.name,
    email: person.email,
    timestamp: person.timestamp,
    zone,
  };
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

/** What the working tree holds at the path of a tracked or untracked file. */
export interface WorktreeFile {
  readonly mode: number;
  readonly size: number;
  /** Modification time in milliseconds. */
  readonly mtime: number;
}

export class Repository {
  readonly fs: IFileSystem;
  /** The directory that holds `.git`. */
  readonly root: string;
  readonly gitdir: string;
  private readonly env: Map<string, string>;
  private readonly client: PromiseFsClient;
  private readonly cache: object = Object.create(null);
  private readonly trees = new Map<string, Map<string, TreeFile>>();
  private configValues: Map<string, string> | undefined;

  private constructor(fs: IFileSystem, root: string, env: Map<string, string>) {
    this.fs = fs;
    this.root = root;
    this.gitdir = root === "/" ? "/.git" : `${root}/.git`;
    this.env = env;
    this.client = isomorphicFs(fs);
  }

  /** The repository whose working tree contains directory; undefined when no directory from it up to the root holds `.git/HEAD`. */
  static async find(
    fs: IFileSystem,
    directory: string,
    env: Map<string, string>,
  ): Promise<Repository | undefined> {
    for (let current = directory; ; current = parentDirectory(current)) {
      const repository = new Repository(fs, current, env);
      if (await repository.exists("HEAD")) return repository;
      if (current === "/") return undefined;
    }
  }

  /** A repository rooted at directory, whether or not `.git` exists yet. */
  static at(
    fs: IFileSystem,
    directory: string,
    env: Map<string, string>,
  ): Repository {
    return new Repository(fs, directory, env);
  }

  private path(name: string): string {
    return `${this.gitdir}/${name}`;
  }

  /** The absolute path of a path relative to the root of the working tree. */
  worktreePath(path: string): string {
    return this.root === "/" ? `/${path}` : `${this.root}/${path}`;
  }

  private async exists(name: string): Promise<boolean> {
    try {
      await this.fs.stat(this.path(name));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private async readText(name: string): Promise<string | undefined> {
    try {
      return textDecoder.decode(await this.fs.readFileBuffer(this.path(name)));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  // ---- Configuration and identity ----

  /** A config value: the repository's `.git/config`, else `$HOME/.gitconfig`. */
  async config(key: string): Promise<string | undefined> {
    if (this.configValues === undefined) {
      const values = new Map<string, string>();
      const home = this.env.get("HOME");
      const sources = [
        home === undefined
          ? undefined
          : `${home === "/" ? "" : home}/.gitconfig`,
        this.path("config"),
      ];
      for (const source of sources) {
        if (source === undefined) continue;
        try {
          const text = textDecoder.decode(await this.fs.readFileBuffer(source));
          for (const [name, value] of parseConfig(text)) {
            values.set(name, value);
          }
        } catch (error) {
          if (!isMissing(error) && errorCode(error) !== "EISDIR") throw error;
        }
      }
      this.configValues = values;
    }
    return this.configValues.get(key);
  }

  /** The author or the committer of a commit made now; fails with exit code 128 without a name and an email. */
  async identity(role: "AUTHOR" | "COMMITTER"): Promise<Identity> {
    const name =
      this.env.get(`GIT_${role}_NAME`) ?? (await this.config("user.name"));
    const email =
      this.env.get(`GIT_${role}_EMAIL`) ?? (await this.config("user.email"));
    if (!name || email === undefined) {
      throw new GitError(
        `${role === "AUTHOR" ? "Author" : "Committer"} identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"\n\nto set your account's default identity.\nOmit --global to set the identity only in this repository.\n\nfatal: no ${name ? "email" : "name"} was given and auto-detection is disabled`,
      );
    }
    const date = this.env.get(`GIT_${role}_DATE`);
    const when =
      date === undefined
        ? { timestamp: Math.floor(Date.now() / 1000), zone: "+0000" }
        : parseDate(date);
    return { name, email, ...when };
  }

  // ---- Refs ----

  /** HEAD: the branch it names, or the commit of a detached HEAD. */
  async head(): Promise<{ branch?: string; oid?: string }> {
    const text = (await this.readText("HEAD"))?.trim() ?? "";
    if (text.startsWith("ref: ")) {
      const ref = text.slice(5).trim();
      const oid = await this.resolveRefName(ref);
      const branch = ref.startsWith("refs/heads/") ? ref.slice(11) : ref;
      return oid === undefined ? { branch } : { branch, oid };
    }
    return { oid: text };
  }

  /** The object a ref points to; undefined when the ref does not exist. */
  async resolveRefName(ref: string): Promise<string | undefined> {
    try {
      return await resolveRef({
        fs: this.client,
        gitdir: this.gitdir,
        ref,
      });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "NotFoundError") {
        return undefined;
      }
      throw error;
    }
  }

  async setRef(ref: string, oid: string): Promise<void> {
    await writeRef({
      fs: this.client,
      gitdir: this.gitdir,
      ref,
      value: oid,
      force: true,
    });
  }

  async removeRef(ref: string): Promise<void> {
    await deleteRef({ fs: this.client, gitdir: this.gitdir, ref });
  }

  /** Moves the branch HEAD names, or a detached HEAD itself, to oid. */
  async setHead(oid: string): Promise<void> {
    const text = (await this.readText("HEAD"))?.trim() ?? "";
    if (text.startsWith("ref: ")) await this.setRef(text.slice(5).trim(), oid);
    else await this.fs.writeFile(this.path("HEAD"), `${oid}\n`);
  }

  /** Makes HEAD name a branch, which may have no commit yet. */
  async attachHead(branch: string): Promise<void> {
    await this.fs.writeFile(this.path("HEAD"), `ref: refs/heads/${branch}\n`);
  }

  /** Makes HEAD a detached HEAD at oid. */
  async detachHead(oid: string): Promise<void> {
    await this.fs.writeFile(this.path("HEAD"), `${oid}\n`);
  }

  /** The names of the branches, loose and packed. */
  branches(): Promise<string[]> {
    return listBranches({ fs: this.client, gitdir: this.gitdir });
  }

  /**
   * The commit a revision names: `HEAD`, a branch, a tag, a full or
   * abbreviated object id, or `stash@{N}`, each with suffixes `~N`, `^`, and
   * `^N`. Fails with exit code 128 on a name that resolves to nothing.
   */
  async resolveCommit(revision: string): Promise<string> {
    const unknown = () =>
      new GitError(
        `fatal: ambiguous argument '${revision}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`,
      );
    const parts = /^(.*?)((?:~\d*|\^\d*)*)$/.exec(revision);
    const base = parts?.[1] ?? revision;
    let oid: string | undefined;
    const stash = /^stash@\{(\d+)\}$/.exec(base);
    if (stash) {
      oid = (await this.stashEntries())[Number(stash[1])]?.oid;
    } else if (base === "HEAD" || base === "@") {
      oid = (await this.head()).oid;
    } else {
      oid = await this.resolveRefName(base);
      if (oid === undefined && /^[0-9a-f]{4,40}$/.test(base)) {
        try {
          oid = await expandOid({
            fs: this.client,
            gitdir: this.gitdir,
            oid: base,
            cache: this.cache,
          });
        } catch {
          oid = undefined;
        }
      }
    }
    if (oid === undefined) throw unknown();
    let commit: Commit;
    try {
      commit = await this.readCommit(oid);
    } catch {
      throw unknown();
    }
    for (const step of (parts?.[2] ?? "").match(/~\d*|\^\d*/g) ?? []) {
      const count = step.length > 1 ? Number(step.slice(1)) : 1;
      if (step.startsWith("~")) {
        for (let i = 0; i < count; i++) {
          if (commit.parents.length === 0) throw unknown();
          commit = await this.readCommit(commit.parents[0]);
        }
      } else if (count > 0) {
        if (commit.parents.length < count) throw unknown();
        commit = await this.readCommit(commit.parents[count - 1]);
      }
    }
    return commit.oid;
  }

  // ---- Objects ----

  /** The commit oid names; an annotated tag gives the commit it points to. */
  async readCommit(oid: string): Promise<Commit> {
    const read = await readCommit({
      fs: this.client,
      gitdir: this.gitdir,
      oid,
      cache: this.cache,
    });
    return {
      oid: read.oid,
      tree: read.commit.tree,
      parents: read.commit.parent,
      author: parseIdentity(read.commit.author),
      committer: parseIdentity(read.commit.committer),
      message: read.commit.message,
    };
  }

  async readBlob(oid: string): Promise<Uint8Array> {
    const read = await readBlob({
      fs: this.client,
      gitdir: this.gitdir,
      oid,
      cache: this.cache,
    });
    return read.blob;
  }

  /** Whether the object database holds oid. */
  async hasObject(oid: string): Promise<boolean> {
    try {
      await readObject({
        fs: this.client,
        gitdir: this.gitdir,
        oid,
        format: "deflated",
        cache: this.cache,
      });
      return true;
    } catch {
      return false;
    }
  }

  writeBlob(bytes: Uint8Array): Promise<string> {
    return writeBlob({ fs: this.client, gitdir: this.gitdir, blob: bytes });
  }

  /** Every file below a tree, by its path relative to the tree. */
  async treeFiles(tree: string): Promise<Map<string, TreeFile>> {
    const cached = this.trees.get(tree);
    if (cached !== undefined) return cached;
    const files = new Map<string, TreeFile>();
    const visit = async (oid: string, prefix: string): Promise<void> => {
      if (oid === EMPTY_TREE) return;
      const read = await readTree({
        fs: this.client,
        gitdir: this.gitdir,
        oid,
        cache: this.cache,
      });
      for (const entry of read.tree) {
        const path = prefix + entry.path;
        if (entry.type === "tree") await visit(entry.oid, `${path}/`);
        else {
          files.set(path, {
            oid: entry.oid,
            mode: Number.parseInt(entry.mode, 8),
          });
        }
      }
    };
    await visit(tree, "");
    this.trees.set(tree, files);
    return files;
  }

  /** Writes the tree objects that hold files and returns the id of the root tree. */
  async writeTree(files: Iterable<[string, TreeFile]>): Promise<string> {
    interface Directory {
      readonly files: Map<string, TreeFile>;
      readonly directories: Map<string, Directory>;
    }
    const root: Directory = { files: new Map(), directories: new Map() };
    for (const [path, file] of files) {
      const names = path.split("/");
      let directory = root;
      for (const name of names.slice(0, -1)) {
        let child = directory.directories.get(name);
        if (child === undefined) {
          child = { files: new Map(), directories: new Map() };
          directory.directories.set(name, child);
        }
        directory = child;
      }
      directory.files.set(names[names.length - 1], file);
    }
    const write = async (directory: Directory): Promise<string> => {
      const tree: {
        mode: string;
        path: string;
        oid: string;
        type: "blob" | "tree" | "commit";
      }[] = [];
      for (const [name, child] of directory.directories) {
        tree.push({
          mode: MODE_TREE.toString(8).padStart(6, "0"),
          path: name,
          oid: await write(child),
          type: "tree",
        });
      }
      for (const [name, file] of directory.files) {
        tree.push({
          mode: file.mode.toString(8).padStart(6, "0"),
          path: name,
          oid: file.oid,
          type: file.mode === 0o160000 ? "commit" : "blob",
        });
      }
      return writeTree({ fs: this.client, gitdir: this.gitdir, tree });
    };
    return write(root);
  }

  /** Writes a commit object and returns its id. */
  writeCommit(commit: Omit<Commit, "oid">): Promise<string> {
    const person = (identity: Identity) =>
      `${identity.name} <${identity.email}> ${identity.timestamp} ${identity.zone}`;
    const text = `tree ${commit.tree}\n${commit.parents
      .map((parent) => `parent ${parent}\n`)
      .join(
        "",
      )}author ${person(commit.author)}\ncommitter ${person(commit.committer)}\n\n${commit.message}`;
    return writeObject({
      fs: this.client,
      gitdir: this.gitdir,
      type: "commit",
      object: textEncoder.encode(text),
      format: "content",
    });
  }

  // ---- Index ----

  async readIndex(): Promise<IndexEntry[]> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fs.readFileBuffer(this.path("index"));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    try {
      return parseIndex(bytes);
    } catch (error) {
      throw new GitError(`fatal: ${(error as Error).message}`);
    }
  }

  async writeIndex(entries: readonly IndexEntry[]): Promise<void> {
    await this.fs.writeFile(this.path("index"), serializeIndex(entries));
  }

  /** Modification time of the index file in milliseconds; undefined without an index. */
  async indexTime(): Promise<number | undefined> {
    try {
      return (await this.fs.stat(this.path("index"))).mtime.getTime();
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  // ---- Working tree ----

  /** The file or symbolic link at a path of the working tree; undefined when there is none, also when a directory is there. */
  async worktreeFile(path: string): Promise<WorktreeFile | undefined> {
    try {
      const stats = await this.fs.lstat(this.worktreePath(path));
      if (stats.isDirectory) return undefined;
      return {
        mode: stats.isSymbolicLink
          ? MODE_SYMLINK
          : (stats.mode & 0o111) !== 0
            ? MODE_EXECUTABLE
            : MODE_FILE,
        size: stats.size,
        mtime: stats.mtime.getTime(),
      };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /** The bytes git stores for a working tree file: its content, or the target of a symbolic link. */
  async worktreeContent(path: string, mode: number): Promise<Uint8Array> {
    const absolute = this.worktreePath(path);
    return mode === MODE_SYMLINK
      ? textEncoder.encode(await this.fs.readlink(absolute))
      : this.fs.readFileBuffer(absolute);
  }

  // ---- Stash ----

  /** The stash entries, newest first: the lines of the reflog of refs/stash. */
  async stashEntries(): Promise<{ oid: string; message: string }[]> {
    const log = await this.readText("logs/refs/stash");
    if (log === undefined) return [];
    const entries: { oid: string; message: string }[] = [];
    for (const line of log.split("\n")) {
      const match = /^[0-9a-f]{40} ([0-9a-f]{40}) [^\t]*\t(.*)$/.exec(line);
      if (match) entries.unshift({ oid: match[1], message: match[2] });
    }
    return entries;
  }

  /** Replaces the stash entries, given newest first, and points refs/stash at the newest. */
  async writeStashEntries(
    entries: readonly { oid: string; message: string }[],
    committer: Identity,
  ): Promise<void> {
    if (entries.length === 0) {
      await this.fs.rm(this.path("logs/refs/stash"), { force: true });
      if ((await this.resolveRefName("refs/stash")) !== undefined) {
        await this.removeRef("refs/stash");
      }
      return;
    }
    const oldest = [...entries].reverse();
    const lines = oldest.map(
      (entry, i) =>
        `${i === 0 ? NULL_OID : oldest[i - 1].oid} ${entry.oid} ${committer.name} <${committer.email}> ${committer.timestamp} ${committer.zone}\t${entry.message}\n`,
    );
    await this.fs.mkdir(this.path("logs/refs"), { recursive: true });
    await this.fs.writeFile(this.path("logs/refs/stash"), lines.join(""));
    await this.setRef("refs/stash", entries[0].oid);
  }
}
