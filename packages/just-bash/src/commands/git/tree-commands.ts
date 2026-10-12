/**
 * The subcommands of git that move HEAD, the index, and the working tree
 * between commits, and the ones that inspect commits: rev-parse, branch,
 * switch, checkout, restore, reset, rm, mv, and show.
 */
import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import {
  type Change,
  commitFiles,
  compareFiles,
  type FileMap,
  indexFiles,
  matchesPaths,
  scanWorktree,
} from "./changes.js";
import { fileDiffs, patch, quotePath, stat, utf8 } from "./diff-output.js";
import { comparePaths, type IndexEntry } from "./index-file.js";
import { GitError, type Repository, type TreeFile } from "./repository.js";
import {
  abbreviate,
  checkoutFile,
  diffSettings,
  entryOf,
  hasGlob,
  mediumFormat,
  type Outcome,
  refreshEntries,
  removeFile,
  repositoryPath,
  type Scope,
  sameFile,
  subjectOf,
  tracking,
  trackingLines,
  Unsupported,
  unsupportedOption,
  withRenames,
} from "./shared.js";
import { byteString } from "./text-diff.js";

/** An index entry for a file whose working tree copy is not known to match it: its size and time are zero, so the next comparison reads the file. */
function unverifiedEntry(path: string, file: TreeFile): IndexEntry {
  return {
    path,
    oid: file.oid,
    mode: file.mode,
    size: 0,
    mtimeSeconds: 0,
    mtimeNanoseconds: 0,
    stage: 0,
  };
}

/** The tracked files that differ from a commit's, as `git diff --name-status <commit>` lists them. */
async function localChanges(
  repository: Repository,
  commit: FileMap,
  prefixes: readonly string[] = [],
): Promise<string> {
  const entries = await repository.readIndex();
  const scan = await scanWorktree(repository, entries);
  return compareFiles(commit, scan.files, prefixes)
    .map((change) => `${change.status}\t${quotePath(change.path)}\n`)
    .join("");
}

/**
 * Makes the index and the working tree hold `target` at every path where
 * `from` and `target` differ, and keeps the other paths as they are. Without
 * force it changes nothing and returns the message of the failure when such
 * a path has a staged or unstaged change, or when an untracked file is at a
 * path that `target` adds. With force every tracked path gets its `target`
 * state.
 */
async function moveWorktree(
  repository: Repository,
  from: FileMap,
  target: FileMap,
  force: boolean,
): Promise<string | undefined> {
  const entries = await repository.readIndex();
  const index = indexFiles(entries);
  const scan = await scanWorktree(repository, entries);
  let changes: Change[];
  if (force) {
    const current: FileMap = new Map();
    for (const [path, file] of index) {
      const inWorktree = scan.files.get(path);
      // A path whose index or file differs from the target counts as changed.
      current.set(
        path,
        inWorktree !== undefined && sameFile(inWorktree, file)
          ? file
          : { oid: "", mode: 0 },
      );
    }
    changes = compareFiles(current, target);
  } else {
    changes = compareFiles(from, target);
    const dirty: string[] = [];
    const untracked: string[] = [];
    for (const change of changes) {
      const staged = index.get(change.path);
      if (sameFile(staged, change.after)) {
        if (
          staged !== undefined &&
          !sameFile(scan.files.get(change.path), staged)
        ) {
          dirty.push(change.path);
        }
      } else if (!sameFile(staged, change.before)) {
        dirty.push(change.path);
      } else if (staged === undefined) {
        if ((await repository.worktreeFile(change.path)) !== undefined) {
          untracked.push(change.path);
        }
      } else if (!sameFile(scan.files.get(change.path), staged)) {
        dirty.push(change.path);
      }
    }
    const list = (paths: string[]) =>
      paths.map((path) => `\t${path}\n`).join("");
    if (dirty.length > 0) {
      return `error: Your local changes to the following files would be overwritten by checkout:\n${list(dirty)}Please commit your changes or stash them before you switch branches.\nAborting`;
    }
    if (untracked.length > 0) {
      return `error: The following untracked working tree files would be overwritten by checkout:\n${list(untracked)}Please move or remove them before you switch branches.\nAborting`;
    }
  }
  const result = new Map(
    refreshEntries(entries, scan)
      .filter((entry) => entry.stage === 0)
      .map((entry) => [entry.path, entry]),
  );
  for (const change of changes) {
    if (change.after === undefined) {
      await removeFile(repository, change.path);
      result.delete(change.path);
    } else {
      await checkoutFile(repository, change.path, change.after);
      result.set(
        change.path,
        await entryOf(repository, change.path, change.after),
      );
    }
  }
  await repository.writeIndex([...result.values()]);
  return undefined;
}

async function isAncestor(
  repository: Repository,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  for (let oid = queue.pop(); oid !== undefined; oid = queue.pop()) {
    if (oid === ancestor) return true;
    for (const parent of (await repository.readCommit(oid)).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

// ---- rev-parse ----

async function revParseCommand(scope: Scope, args: string[]): Promise<Outcome> {
  const { repository } = scope;
  let short: number | undefined;
  let abbreviateRef = false;
  let out = "";
  for (const arg of args) {
    if (arg === "--show-toplevel") out += `${utf8(repository.root)}\n`;
    else if (arg === "--short") short = 7;
    else if (/^--short=\d+$/.test(arg))
      short = Math.max(4, Number(arg.slice(8)));
    else if (arg === "--abbrev-ref") abbreviateRef = true;
    else if (arg.startsWith("-")) throw unsupportedOption("rev-parse", arg);
    else {
      let oid: string;
      try {
        oid = await repository.resolveCommit(arg);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        // git prints the argument it cannot resolve before it fails.
        return {
          stdout: `${out}${utf8(arg)}\n`,
          stderr: `${sanitizeErrorMessage(error.message)}\n`,
          exitCode: 128,
        };
      }
      if (abbreviateRef) {
        const head = await repository.head();
        out += `${utf8(
          arg === "HEAD" || arg === "@" ? (head.branch ?? "HEAD") : arg,
        )}\n`;
      } else {
        out += `${short === undefined ? oid : oid.slice(0, short)}\n`;
      }
    }
  }
  return { stdout: out };
}

// ---- branch ----

async function branchCommand(scope: Scope, args: string[]): Promise<Outcome> {
  const { repository } = scope;
  let remove: "merged" | "force" | undefined;
  const names: string[] = [];
  for (const arg of args) {
    if (arg === "-d" || arg === "--delete") remove = "merged";
    else if (arg === "-D") remove = "force";
    else if (arg === "--list" || arg === "-l") continue;
    // Listing and creating print the same with -q.
    else if (arg === "-q" || arg === "--quiet") continue;
    else if (arg.startsWith("-")) throw unsupportedOption("branch", arg);
    else names.push(arg);
  }
  const head = await repository.head();
  if (remove !== undefined) {
    if (names.length === 0) {
      throw new GitError("fatal: branch name required");
    }
    let out = "";
    let stderr = "";
    for (const name of names) {
      const oid = await repository.resolveRefName(`refs/heads/${name}`);
      if (oid === undefined) {
        stderr += `error: branch '${name}' not found\n`;
      } else if (head.branch === name) {
        stderr += `error: cannot delete branch '${name}' used by worktree at '${repository.root}'\n`;
      } else if (
        remove === "merged" &&
        head.oid !== undefined &&
        !(await isAncestor(repository, oid, head.oid))
      ) {
        stderr += `error: the branch '${name}' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D ${name}'\n`;
      } else {
        await repository.removeRef(`refs/heads/${name}`);
        out += `Deleted branch ${utf8(name)} (was ${abbreviate(oid)}).\n`;
      }
    }
    return { stdout: out, stderr, exitCode: stderr === "" ? 0 : 1 };
  }
  if (names.length === 0) {
    const branches = (await repository.branches()).sort(comparePaths);
    let out = "";
    if (head.branch === undefined && head.oid !== undefined) {
      out += `* (HEAD detached at ${abbreviate(head.oid)})\n`;
    }
    for (const name of branches) {
      out += `${name === head.branch ? "*" : " "} ${utf8(name)}\n`;
    }
    return { stdout: out };
  }
  if (names.length > 2) {
    throw new GitError("fatal: cannot create more than one branch", 128);
  }
  const [name, start] = names;
  if ((await repository.resolveRefName(`refs/heads/${name}`)) !== undefined) {
    throw new GitError(`fatal: a branch named '${name}' already exists`);
  }
  if (start === undefined && head.oid === undefined) {
    throw new GitError(
      `fatal: not a valid object name: '${head.branch ?? "HEAD"}'`,
    );
  }
  await repository.setRef(
    `refs/heads/${name}`,
    await repository.resolveCommit(start ?? "HEAD"),
  );
  return { stdout: "" };
}

// ---- switch and checkout ----

/** Restores the working tree files at the paths from the index; fails for a path that names no tracked file. */
async function restoreWorktree(
  scope: Scope,
  pathArguments: string[],
): Promise<Outcome> {
  const { repository } = scope;
  const entries = await repository.readIndex();
  const index = indexFiles(entries);
  const scan = await scanWorktree(repository, entries);
  const prefixes = pathArguments.map((arg) => repositoryPath(scope, arg));
  for (let i = 0; i < prefixes.length; i++) {
    if (![...index.keys()].some((path) => matchesPaths(path, [prefixes[i]]))) {
      return {
        stderr: `error: pathspec '${pathArguments[i]}' did not match any file(s) known to git\n`,
        exitCode: 1,
      };
    }
  }
  const result = new Map(
    refreshEntries(entries, scan).map((entry) => [entry.path, entry]),
  );
  for (const [path, file] of index) {
    if (!matchesPaths(path, prefixes)) continue;
    if (sameFile(scan.files.get(path), file)) continue;
    await checkoutFile(repository, path, file);
    result.set(path, await entryOf(repository, path, file));
  }
  await repository.writeIndex([...result.values()]);
  return { stdout: "" };
}

/** Switches to a branch, to a new branch at a start point, or (detach) to a commit. */
async function switchTo(
  scope: Scope,
  target: { branch: string; create?: string } | { commit: string },
): Promise<Outcome> {
  const { repository } = scope;
  const head = await repository.head();
  let oid: string | undefined;
  if ("commit" in target) {
    oid = await repository.resolveCommit(target.commit);
  } else if (target.create !== undefined || head.oid !== undefined) {
    const existing = await repository.resolveRefName(
      `refs/heads/${target.branch}`,
    );
    if (target.create !== undefined) {
      if (existing !== undefined) {
        throw new GitError(
          `fatal: a branch named '${target.branch}' already exists`,
        );
      }
      oid =
        target.create === "HEAD" && head.oid === undefined
          ? undefined
          : await repository.resolveCommit(target.create);
    } else {
      if (existing === undefined) {
        throw new GitError(`fatal: invalid reference: ${target.branch}`);
      }
      oid = existing;
    }
  }
  if (!("commit" in target) && target.create === undefined) {
    if (head.branch === target.branch) {
      const upstream = await tracking(repository, head);
      return {
        stdout:
          (await localChanges(
            repository,
            await commitFiles(repository, head.oid),
          )) + (upstream === undefined ? "" : trackingLines(upstream)),
        stderr: `Already on '${target.branch}'\n`,
      };
    }
  }
  const from = await commitFiles(repository, head.oid);
  const to = await commitFiles(repository, oid);
  if (oid !== head.oid) {
    const failure = await moveWorktree(repository, from, to, false);
    if (failure !== undefined) return { stderr: `${failure}\n`, exitCode: 1 };
  }
  let stderr: string;
  if ("commit" in target) {
    await repository.detachHead(oid ?? "");
    const commit = await repository.readCommit(oid ?? "");
    const subject = subjectOf(commit.message);
    stderr = `Note: switching to '${target.commit}'.\n\nYou are in 'detached HEAD' state.\n\nHEAD is now at ${abbreviate(commit.oid)} ${subject}\n`;
  } else {
    if (target.create !== undefined && oid !== undefined) {
      await repository.setRef(`refs/heads/${target.branch}`, oid);
    }
    await repository.attachHead(target.branch);
    stderr = `Switched to ${
      target.create === undefined ? "branch" : "a new branch"
    } '${target.branch}'\n`;
  }
  let out = await localChanges(repository, to);
  if (!("commit" in target)) {
    const upstream = await tracking(repository, {
      branch: target.branch,
      oid,
    });
    if (upstream !== undefined) out += trackingLines(upstream);
  }
  return { stdout: out, stderr };
}

async function switchCommand(scope: Scope, args: string[]): Promise<Outcome> {
  let create = false;
  const names: string[] = [];
  for (const arg of args) {
    if (arg === "-c" || arg === "--create") create = true;
    else if (arg.startsWith("-")) throw unsupportedOption("switch", arg);
    else names.push(arg);
  }
  if (names.length === 0)
    throw new GitError("fatal: missing branch or commit argument");
  if (names.length > (create ? 2 : 1)) {
    throw new GitError("fatal: only one reference expected");
  }
  return switchTo(
    scope,
    create
      ? { branch: names[0], create: names[1] ?? "HEAD" }
      : { branch: names[0] },
  );
}

async function checkoutCommand(scope: Scope, args: string[]): Promise<Outcome> {
  const { repository } = scope;
  let create = false;
  const before: string[] = [];
  const paths: string[] = [];
  let separated = false;
  for (const arg of args) {
    if (separated) paths.push(arg);
    else if (arg === "--") separated = true;
    else if (arg === "-b") create = true;
    else if (arg.startsWith("-")) throw unsupportedOption("checkout", arg);
    else before.push(arg);
  }
  if (create) {
    if (before.length === 0 || before.length > 2 || paths.length > 0) {
      throw new GitError("fatal: '-b' takes a branch name and a start point");
    }
    return switchTo(scope, { branch: before[0], create: before[1] ?? "HEAD" });
  }
  if (separated) {
    if (before.length > 0) {
      throw new Unsupported("git checkout: files from a commit");
    }
    return restoreWorktree(scope, paths);
  }
  if (before.length === 0) return { stdout: "" };
  if (before.length === 1) {
    const [name] = before;
    if ((await repository.resolveRefName(`refs/heads/${name}`)) !== undefined) {
      return switchTo(scope, { branch: name });
    }
    try {
      await repository.resolveCommit(name);
      return switchTo(scope, { commit: name });
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
    }
  }
  // Arguments that name no branch and no commit are paths.
  return restoreWorktree(scope, before);
}

// ---- restore ----

/** Makes the index hold what a commit holds at the paths. */
async function restoreIndex(
  repository: Repository,
  source: FileMap,
  prefixes: readonly string[],
): Promise<void> {
  const entries = await repository.readIndex();
  const result = new Map(entries.map((entry) => [entry.path, entry]));
  const index = indexFiles(entries);
  for (const path of new Set([...index.keys(), ...source.keys()])) {
    if (!matchesPaths(path, prefixes)) continue;
    const file = source.get(path);
    if (file === undefined) result.delete(path);
    else if (!sameFile(index.get(path), file)) {
      result.set(path, unverifiedEntry(path, file));
    }
  }
  await repository.writeIndex([...result.values()]);
}

async function restoreCommand(scope: Scope, args: string[]): Promise<Outcome> {
  const { repository } = scope;
  let staged = false;
  let worktree = false;
  const paths: string[] = [];
  let separated = false;
  for (const arg of args) {
    if (separated || !arg.startsWith("-")) paths.push(arg);
    else if (arg === "--") separated = true;
    else if (arg === "--staged" || arg === "-S") staged = true;
    else if (arg === "--worktree" || arg === "-W") worktree = true;
    else throw unsupportedOption("restore", arg);
  }
  for (const arg of paths) {
    if (hasGlob(arg)) {
      throw new Unsupported(`git restore: pathspec with wildcard '${arg}'`);
    }
  }
  if (paths.length === 0) {
    throw new GitError("fatal: you must specify path(s) to restore");
  }
  if (staged) {
    const prefixes = paths.map((arg) => repositoryPath(scope, arg));
    const head = await commitFiles(repository, (await repository.head()).oid);
    const index = indexFiles(await repository.readIndex());
    for (let i = 0; i < prefixes.length; i++) {
      const known = [...index.keys(), ...head.keys()].some((path) =>
        matchesPaths(path, [prefixes[i]]),
      );
      if (!known) {
        return {
          stderr: `error: pathspec '${paths[i]}' did not match any file(s) known to git\n`,
          exitCode: 1,
        };
      }
    }
    await restoreIndex(repository, head, prefixes);
    if (!worktree) return { stdout: "" };
  }
  return restoreWorktree(scope, paths);
}

// ---- reset ----

async function resetCommand(scope: Scope, args: string[]): Promise<Outcome> {
  const { repository } = scope;
  let mode: "soft" | "mixed" | "hard" | undefined;
  const before: string[] = [];
  const paths: string[] = [];
  let separated = false;
  for (const arg of args) {
    if (separated) paths.push(arg);
    else if (arg === "--") separated = true;
    else if (arg === "--soft" || arg === "--mixed" || arg === "--hard") {
      mode = arg.slice(2) as "soft" | "mixed" | "hard";
    } else if (arg.startsWith("-")) throw unsupportedOption("reset", arg);
    else before.push(arg);
  }
  const head = await repository.head();
  // The first argument is the commit when it names one; the rest are paths.
  let target = head.oid;
  if (before.length > 0) {
    try {
      target = await repository.resolveCommit(before[0]);
      paths.unshift(...before.slice(1));
    } catch (error) {
      if (!(error instanceof GitError) || separated) throw error;
      const index = indexFiles(await repository.readIndex());
      const prefix = repositoryPath(scope, before[0]);
      if (![...index.keys()].some((path) => matchesPaths(path, [prefix]))) {
        throw error;
      }
      paths.unshift(...before);
    }
  }
  const files = await commitFiles(repository, target);
  const unstaged = async () => {
    const entries = await repository.readIndex();
    const scan = await scanWorktree(repository, entries);
    const changes = compareFiles(indexFiles(entries), scan.files);
    return changes.length === 0
      ? ""
      : `Unstaged changes after reset:\n${changes
          .map((change) => `${change.status}\t${quotePath(change.path)}\n`)
          .join("")}`;
  };
  if (paths.length > 0) {
    if (mode !== undefined && mode !== "mixed") {
      throw new GitError(`fatal: Cannot do ${mode} reset with paths.`);
    }
    await restoreIndex(
      repository,
      files,
      paths.map((arg) => repositoryPath(scope, arg)),
    );
    return { stdout: await unstaged() };
  }
  if (mode === "soft") {
    if (target !== undefined) await repository.setHead(target);
    return { stdout: "" };
  }
  if (mode === "hard") {
    await moveWorktree(repository, files, files, true);
    if (target === undefined) return { stdout: "" };
    await repository.setHead(target);
    const commit = await repository.readCommit(target);
    return {
      stdout: `HEAD is now at ${abbreviate(target)} ${utf8(subjectOf(commit.message))}\n`,
    };
  }
  await restoreIndex(repository, files, []);
  if (target !== undefined) await repository.setHead(target);
  return { stdout: await unstaged() };
}

// ---- rm ----

async function rmCommand(scope: Scope, args: string[]): Promise<Outcome> {
  const { repository } = scope;
  let recursive = false;
  let cached = false;
  let force = false;
  const paths: string[] = [];
  let separated = false;
  for (const arg of args) {
    if (separated || !arg.startsWith("-")) paths.push(arg);
    else if (arg === "--") separated = true;
    else if (arg === "-r") recursive = true;
    else if (arg === "--cached") cached = true;
    else if (arg === "-f" || arg === "--force") force = true;
    else if (arg === "-rf" || arg === "-fr") {
      recursive = true;
      force = true;
    } else throw unsupportedOption("rm", arg);
  }
  for (const arg of paths) {
    if (hasGlob(arg)) {
      throw new Unsupported(`git rm: pathspec with wildcard '${arg}'`);
    }
  }
  if (paths.length === 0) {
    throw new GitError(
      "fatal: No pathspec was given. Which files should I remove?",
    );
  }
  const entries = await repository.readIndex();
  const index = indexFiles(entries);
  const removed = new Set<string>();
  for (const arg of paths) {
    const prefix = repositoryPath(scope, arg);
    const matched = [...index.keys()].filter((path) =>
      matchesPaths(path, [prefix]),
    );
    if (matched.length === 0) {
      throw new GitError(`fatal: pathspec '${arg}' did not match any files`);
    }
    if (!recursive && !(matched.length === 1 && matched[0] === prefix)) {
      throw new GitError(`fatal: not removing '${arg}' recursively without -r`);
    }
    for (const path of matched) removed.add(path);
  }
  const ordered = [...removed].sort(comparePaths);
  if (!force) {
    const head = await commitFiles(repository, (await repository.head()).oid);
    const scan = await scanWorktree(repository, entries);
    const staged: string[] = [];
    const local: string[] = [];
    const both: string[] = [];
    for (const path of ordered) {
      const file = index.get(path);
      const inWorktree = scan.files.get(path);
      const isStaged = !sameFile(head.get(path), file);
      const isLocal = inWorktree !== undefined && !sameFile(inWorktree, file);
      if (isStaged && isLocal) both.push(path);
      else if (!cached && isStaged) staged.push(path);
      else if (!cached && isLocal) local.push(path);
    }
    const report = (list: string[], one: string, many: string) =>
      list.length === 0
        ? ""
        : `error: the following ${list.length === 1 ? one : many}:\n${list
            .map((path) => `    ${path}\n`)
            .join("")}`;
    const errors =
      report(
        both,
        "file has staged content different from both the\nfile and the HEAD",
        "files have staged content different from both the\nfile and the HEAD",
      ) +
      (both.length > 0 ? "(use -f to force removal)\n" : "") +
      report(
        staged,
        "file has changes staged in the index",
        "files have changes staged in the index",
      ) +
      report(
        local,
        "file has local modifications",
        "files have local modifications",
      ) +
      (staged.length + local.length > 0
        ? "(use --cached to keep the file, or -f to force removal)\n"
        : "");
    if (errors !== "") return { stderr: errors, exitCode: 1 };
  }
  let out = "";
  for (const path of ordered) {
    if (!cached) await removeFile(repository, path);
    out += `rm '${utf8(path)}'\n`;
  }
  await repository.writeIndex(
    entries.filter((entry) => !removed.has(entry.path)),
  );
  return { stdout: out };
}

// ---- mv ----

async function mvCommand(scope: Scope, args: string[]): Promise<Outcome> {
  const { repository } = scope;
  for (const arg of args) {
    if (arg.startsWith("-")) throw unsupportedOption("mv", arg);
  }
  if (args.length < 2) {
    throw new GitError(
      "usage: git mv [-v] [-f] [-n] [-k] <source> <destination>",
      129,
    );
  }
  const destination = args[args.length - 1];
  const destinationPath = repositoryPath(scope, destination);
  const fs = repository.fs;
  const isDirectory = (path: string) =>
    fs.stat(repository.worktreePath(path)).then(
      (stats) => stats.isDirectory,
      () => false,
    );
  const exists = (path: string) =>
    fs.lstat(repository.worktreePath(path)).then(
      () => true,
      () => false,
    );
  const into = destinationPath === "" || (await isDirectory(destinationPath));
  if (args.length > 2 && !into) {
    throw new GitError(
      `fatal: destination '${destination}' is not a directory`,
    );
  }
  const entries = await repository.readIndex();
  const index = indexFiles(entries);
  // Each move: the tracked paths below the source and the path each becomes.
  const moves: { from: string; to: string; renames: [string, string][] }[] = [];
  for (const source of args.slice(0, -1)) {
    const from = repositoryPath(scope, source);
    const name = from.slice(from.lastIndexOf("/") + 1);
    const to = into
      ? destinationPath === ""
        ? name
        : `${destinationPath}/${name}`
      : destinationPath;
    const detail = `source=${source}, destination=${
      into ? `${destination.replace(/\/$/, "")}/${name}` : destination
    }`;
    if (from === "" || !(await exists(from))) {
      throw new GitError(`fatal: bad source, ${detail}`);
    }
    const tracked = [...index.keys()].filter((path) =>
      matchesPaths(path, [from]),
    );
    if (tracked.length === 0) {
      throw new GitError(
        (await isDirectory(from))
          ? `fatal: source directory is empty, ${detail}`
          : `fatal: not under version control, ${detail}`,
      );
    }
    if (await exists(to)) {
      throw new GitError(`fatal: destination exists, ${detail}`);
    }
    moves.push({
      from,
      to,
      renames: tracked.map((path) => [path, to + path.slice(from.length)]),
    });
  }
  const renamed = new Map<string, string>();
  for (const move of moves) {
    const target = repository.worktreePath(move.to);
    const slash = target.lastIndexOf("/");
    if (slash > 0) await fs.mkdir(target.slice(0, slash), { recursive: true });
    await fs.mv(repository.worktreePath(move.from), target);
    for (const [from, to] of move.renames) renamed.set(from, to);
  }
  await repository.writeIndex(
    entries.map((entry) => {
      const to = renamed.get(entry.path);
      return to === undefined ? entry : { ...entry, path: to };
    }),
  );
  return { stdout: "" };
}

// ---- show ----

/** The content of `<commit>:<path>`: the bytes of a file, or the listing of a directory. */
async function showPath(
  repository: Repository,
  argument: string,
): Promise<string> {
  const colon = argument.indexOf(":");
  const revision = argument.slice(0, colon) || "HEAD";
  const path = argument.slice(colon + 1).replace(/\/+$/, "");
  const files = await commitFiles(
    repository,
    await repository.resolveCommit(revision),
  );
  const file = files.get(path);
  if (file !== undefined) {
    return byteString(await repository.readBlob(file.oid));
  }
  const prefix = path === "" ? "" : `${path}/`;
  const names = new Set<string>();
  for (const name of files.keys()) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const slash = rest.indexOf("/");
    names.add(slash === -1 ? rest : rest.slice(0, slash + 1));
  }
  if (names.size === 0) {
    throw new GitError(`fatal: path '${path}' does not exist in '${revision}'`);
  }
  return `tree ${utf8(argument)}\n\n${[...names]
    .sort(comparePaths)
    .map((name) => `${utf8(name)}\n`)
    .join("")}`;
}

async function showCommand(scope: Scope, args: string[]): Promise<Outcome> {
  const { repository } = scope;
  let statFormat = false;
  let noPatch = false;
  const objects: string[] = [];
  for (const arg of args) {
    if (arg === "--stat") statFormat = true;
    else if (arg === "-s" || arg === "-q" || arg === "--no-patch") {
      noPatch = true;
    } else if (arg.startsWith("-")) throw unsupportedOption("show", arg);
    else objects.push(arg);
  }
  if (objects.length === 0) objects.push("HEAD");
  const commits = objects.filter((object) => !object.includes(":"));
  if (commits.length > 1) {
    throw new Unsupported("git show: more than one commit");
  }
  let out = "";
  for (const object of objects) {
    if (object.includes(":")) {
      out += await showPath(repository, object);
      continue;
    }
    const commit = await repository.readCommit(
      await repository.resolveCommit(object),
    );
    out += mediumFormat(commit);
    // --stat takes effect also after -s.
    if (noPatch && !statFormat) continue;
    out += "\n";
    // A merge shows no patch; its diffstat is the one against its first parent.
    if (commit.parents.length > 1 && !statFormat) continue;
    const settings = await diffSettings(repository);
    const changes = await withRenames(
      repository,
      compareFiles(
        await commitFiles(repository, commit.parents[0]),
        await repository.treeFiles(commit.tree),
      ),
      settings.renames,
    );
    const diffs = await fileDiffs(repository, changes, settings.text);
    out += statFormat
      ? stat(diffs)
      : patch(diffs, settings.prefixes("commits"));
  }
  return { stdout: out };
}

export const TREE_COMMANDS: ReadonlyMap<
  string,
  (scope: Scope, args: string[]) => Promise<Outcome>
> = new Map([
  ["rev-parse", revParseCommand],
  ["branch", branchCommand],
  ["switch", switchCommand],
  ["checkout", checkoutCommand],
  ["restore", restoreCommand],
  ["reset", resetCommand],
  ["rm", rmCommand],
  ["mv", mvCommand],
  ["show", showCommand],
]);
