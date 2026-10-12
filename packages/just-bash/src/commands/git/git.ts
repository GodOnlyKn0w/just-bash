/**
 * git - the built-in git command, implemented with isomorphic-git on the
 * command's file system.
 *
 * This file holds init, add, commit, status, diff, log, and stash; the
 * subcommands of TREE_COMMANDS are the others. A subcommand or an option
 * outside the ones their argument loops accept ends with exit code 129 and
 * changes nothing.
 */
import { bytesOutput, unsafeBytesFromLatin1 } from "../../encoding.js";
import { sanitizeErrorMessage } from "../../fs/sanitize-error.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import {
  type Change,
  commitFiles,
  compareFiles,
  detectRenames,
  type FileMap,
  indexFiles,
  matchesPaths,
  scanWorktree,
  type WorktreeScan,
} from "./changes.js";
import {
  fileDiffs,
  nameOnly,
  nameStatus,
  patch,
  quotePath,
  shortStat,
  stat,
  summary,
  utf8,
} from "./diff-output.js";
import type { IndexEntry } from "./index-file.js";
import { comparePaths } from "./index-file.js";
import {
  type Commit,
  formatDate,
  GitError,
  Repository,
  type TreeFile,
} from "./repository.js";
import {
  abbreviate,
  branchLabel,
  checkoutFile,
  entryOf,
  hasGlob,
  mediumFormat,
  type Outcome,
  refreshEntries,
  relativePath,
  removeFile,
  repositoryPath,
  type Scope,
  sameFile,
  stageFile,
  subjectOf,
  tracking,
  trackingLines,
  Unsupported,
  unsupportedOption,
} from "./shared.js";
import { TREE_COMMANDS } from "./tree-commands.js";
import { IgnoreRules, untrackedFiles } from "./worktree.js";

// ---- Paths ----

// ---- Status ----

interface Status {
  readonly head: { branch?: string; oid?: string };
  readonly entries: IndexEntry[];
  readonly scan: WorktreeScan;
  /** Changes from HEAD to the index, with renames. */
  readonly staged: Change[];
  /** Changes from the index to the working tree. */
  readonly unstaged: Change[];
  readonly untracked: string[];
}

async function readStatus(repository: Repository): Promise<Status> {
  const head = await repository.head();
  const entries = await repository.readIndex();
  const index = indexFiles(entries);
  const staged = await detectRenames(
    repository,
    compareFiles(await commitFiles(repository, head.oid), index),
  );
  const scan = await scanWorktree(repository, entries);
  const unstaged = compareFiles(index, scan.files);
  const untracked = await untrackedFiles(
    repository,
    new Set(index.keys()),
    new IgnoreRules(repository),
    true,
  );
  return { head, entries, scan, staged, unstaged, untracked };
}

const STAGED_LABELS = {
  A: "new file:",
  D: "deleted:",
  M: "modified:",
  T: "typechange:",
  R: "renamed:",
};

/** The long format of `git status`. `initial` is the line for a repository without commits. */
async function longStatus(
  scope: Scope,
  status: Status,
  initial = "No commits yet",
): Promise<string> {
  const { head, staged, unstaged, untracked } = status;
  const name = (path: string) => quotePath(relativePath(path, scope.prefix));
  let out =
    head.branch !== undefined
      ? `On branch ${utf8(head.branch)}\n`
      : `HEAD detached at ${abbreviate(head.oid ?? "")}\n`;
  const upstream = await tracking(scope.repository, head);
  if (upstream !== undefined) out += `${trackingLines(upstream)}\n`;
  if (head.oid === undefined) out += `\n${initial}\n\n`;
  if (staged.length > 0) {
    out += `Changes to be committed:\n  (use "${
      head.oid === undefined ? "git rm --cached" : "git restore --staged"
    } <file>..." to unstage)\n`;
    for (const change of staged) {
      out += `\t${STAGED_LABELS[change.status].padEnd(12)}${
        change.status === "R"
          ? `${name(change.oldPath ?? "")} -> ${name(change.path)}`
          : name(change.path)
      }\n`;
    }
    out += "\n";
  }
  if (unstaged.length > 0) {
    const deleted = unstaged.some((change) => change.status === "D");
    out += `Changes not staged for commit:\n  (use "git add${
      deleted ? "/rm" : ""
    } <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)\n`;
    for (const change of unstaged) {
      out += `\t${STAGED_LABELS[change.status].padEnd(12)}${name(change.path)}\n`;
    }
    out += "\n";
  }
  if (untracked.length > 0) {
    out += `Untracked files:\n  (use "git add <file>..." to include in what will be committed)\n`;
    for (const path of untracked) out += `\t${name(path)}\n`;
    out += "\n";
  }
  if (staged.length === 0) {
    if (unstaged.length > 0) {
      out += `no changes added to commit (use "git add" and/or "git commit -a")\n`;
    } else if (untracked.length > 0) {
      out += `nothing added to commit but untracked files present (use "git add" to track)\n`;
    } else if (head.oid === undefined) {
      out += `nothing to commit (create/copy files and use "git add" to track)\n`;
    } else {
      out += "nothing to commit, working tree clean\n";
    }
  }
  return out;
}

/** The short format: `XY path` lines. Paths are relative to the caller's directory, or to the root with fromRoot. */
async function shortStatus(
  scope: Scope,
  status: Status,
  branch: boolean,
  fromRoot: boolean,
): Promise<string> {
  const { head } = status;
  const name = (path: string) =>
    quotePath(fromRoot ? path : relativePath(path, scope.prefix), true);
  let out = "";
  if (branch) {
    if (head.branch === undefined) out += "## HEAD (no branch)\n";
    else if (head.oid === undefined) {
      out += `## No commits yet on ${utf8(head.branch)}\n`;
    } else {
      const upstream = await tracking(scope.repository, head);
      out += `## ${utf8(head.branch)}`;
      if (upstream !== undefined) {
        out += `...${utf8(upstream.upstream)}`;
        const parts: string[] = [];
        if (upstream.ahead > 0) parts.push(`ahead ${upstream.ahead}`);
        if (upstream.behind > 0) parts.push(`behind ${upstream.behind}`);
        if (parts.length > 0) out += ` [${parts.join(", ")}]`;
      }
      out += "\n";
    }
  }
  const lines = new Map<string, { x: string; y: string; from?: string }>();
  for (const change of status.staged) {
    lines.set(change.path, { x: change.status, y: " ", from: change.oldPath });
  }
  for (const change of status.unstaged) {
    const line = lines.get(change.path);
    if (line === undefined)
      lines.set(change.path, { x: " ", y: change.status });
    else line.y = change.status;
  }
  for (const path of [...lines.keys()].sort(comparePaths)) {
    const line = lines.get(path);
    if (line === undefined) continue;
    out += `${line.x}${line.y} ${
      line.from === undefined ? "" : `${name(line.from)} -> `
    }${name(path)}\n`;
  }
  for (const path of status.untracked) out += `?? ${name(path)}\n`;
  return out;
}

async function statusCommand(scope: Scope, args: string[]): Promise<Outcome> {
  let short = false;
  let porcelain = false;
  let branch = false;
  for (const arg of args) {
    if (arg === "--short") short = true;
    else if (arg === "--long") short = false;
    else if (arg === "--porcelain" || arg === "--porcelain=v1")
      porcelain = true;
    else if (arg === "--branch") branch = true;
    else if (/^-[sb]+$/.test(arg)) {
      if (arg.includes("s")) short = true;
      if (arg.includes("b")) branch = true;
    } else if (arg.startsWith("-")) throw unsupportedOption("status", arg);
    else throw new Unsupported(`git status: path argument '${arg}'`);
  }
  const status = await readStatus(scope.repository);
  return {
    stdout:
      short || porcelain
        ? await shortStatus(scope, status, branch, porcelain)
        : await longStatus(scope, status),
  };
}

// ---- Index updates ----

/** Stages what the working tree holds for every tracked path that matches: the changed content, or the removal of a deleted file. */
async function stageTracked(
  repository: Repository,
  entries: readonly IndexEntry[],
  prefixes: readonly string[],
): Promise<IndexEntry[]> {
  const scan = await scanWorktree(repository, entries);
  const result: IndexEntry[] = [];
  for (const entry of refreshEntries(entries, scan)) {
    if (entry.stage !== 0 || !matchesPaths(entry.path, prefixes)) {
      result.push(entry);
      continue;
    }
    const file = scan.files.get(entry.path);
    if (file === undefined) continue;
    if (!file.inWorktree) {
      result.push(entry);
      continue;
    }
    const staged = await stageFile(repository, entry.path);
    if (staged !== undefined) result.push(staged);
  }
  return result;
}

async function addCommand(scope: Scope, args: string[]): Promise<Outcome> {
  const { repository } = scope;
  let all = false;
  let update = false;
  const pathArguments: string[] = [];
  let onlyPaths = false;
  for (const arg of args) {
    if (onlyPaths || !arg.startsWith("-")) pathArguments.push(arg);
    else if (arg === "--") onlyPaths = true;
    else if (arg === "-A" || arg === "--all") all = true;
    else if (arg === "-u" || arg === "--update") update = true;
    else throw unsupportedOption("add", arg);
  }
  if (all && update) {
    throw new GitError("fatal: options '-A' and '-u' cannot be used together");
  }
  for (const arg of pathArguments) {
    if (hasGlob(arg)) {
      throw new Unsupported(`git add: pathspec with wildcard '${arg}'`);
    }
  }
  if (pathArguments.length === 0 && !all && !update) {
    return {
      stderr:
        "Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?\n",
    };
  }
  const paths = pathArguments.map((arg) => repositoryPath(scope, arg));
  // -A and -u without a path take the whole working tree.
  const prefixes = paths.length === 0 ? [""] : paths;
  const entries = await repository.readIndex();
  const tracked = new Set(indexFiles(entries).keys());
  const ignore = new IgnoreRules(repository);
  const additions: string[] = [];
  const ignored: string[] = [];
  for (let i = 0; i < prefixes.length; i++) {
    const prefix = prefixes[i];
    const matchesTracked = [...tracked].some((path) =>
      matchesPaths(path, [prefix]),
    );
    let found: string[] = [];
    if (!update) {
      const file =
        prefix === "" ? undefined : await repository.worktreeFile(prefix);
      if (file !== undefined) {
        if (!tracked.has(prefix)) {
          if (await ignore.ignoresWithParents(prefix, false)) {
            ignored.push(pathArguments[i]);
          } else {
            found = [prefix];
          }
        }
      } else if (
        prefix !== "" &&
        (await ignore.ignoresWithParents(prefix, true)) &&
        !matchesTracked
      ) {
        const exists = await repository.fs
          .stat(repository.worktreePath(prefix))
          .then(
            () => true,
            () => false,
          );
        if (exists) ignored.push(pathArguments[i]);
      } else {
        found = await untrackedFiles(
          repository,
          tracked,
          ignore,
          false,
          prefix,
        );
      }
    }
    if (
      pathArguments.length > 0 &&
      !matchesTracked &&
      found.length === 0 &&
      !ignored.includes(pathArguments[i])
    ) {
      const exists =
        prefix === "" ||
        (await repository.fs.stat(repository.worktreePath(prefix)).then(
          () => true,
          () => false,
        ));
      if (!exists || update) {
        throw new GitError(
          `fatal: pathspec '${pathArguments[i]}' did not match any files`,
        );
      }
    }
    additions.push(...found);
  }
  if (ignored.length > 0) {
    return {
      stderr: `The following paths are ignored by one of your .gitignore files:\n${ignored.join("\n")}\nhint: Use -f if you really want to add them.\n`,
      exitCode: 1,
    };
  }
  const result = await stageTracked(repository, entries, prefixes);
  for (const path of new Set(additions)) {
    const staged = await stageFile(repository, path);
    if (staged !== undefined) result.push(staged);
  }
  await repository.writeIndex(result);
  return { stdout: "" };
}

// ---- Commit ----

/** A commit message as `git commit -m` stores it: no white space at line ends, no blank lines at its start and end, single blank lines inside, one line feed at the end. */
function cleanMessage(text: string): string {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line === "" && (lines.length === 0 || lines[lines.length - 1] === "")) {
      continue;
    }
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

async function commitCommand(scope: Scope, args: string[]): Promise<Outcome> {
  const { repository } = scope;
  const messages: string[] = [];
  let all = false;
  let amend = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--amend") amend = true;
    else if (arg === "--all") all = true;
    else if (arg === "-m" || arg === "--message" || /^-a*m$/.test(arg)) {
      if (arg.includes("a") && arg.startsWith("-a")) all = true;
      if (i + 1 >= args.length) {
        throw new GitError("error: switch `m' requires a value", 129);
      }
      messages.push(args[++i]);
    } else if (arg.startsWith("--message=")) messages.push(arg.slice(10));
    else if (arg === "-a") all = true;
    else if (arg.startsWith("-")) throw unsupportedOption("commit", arg);
    else throw new Unsupported(`git commit: path argument '${arg}'`);
  }
  if (messages.length === 0) {
    throw new Unsupported(
      "git commit: a commit without -m (it opens an editor)",
    );
  }
  const head = await repository.head();
  if (amend && head.oid === undefined) {
    throw new GitError("fatal: You have nothing to amend.");
  }
  const amended =
    amend && head.oid !== undefined
      ? await repository.readCommit(head.oid)
      : undefined;
  const committer = await repository.identity("COMMITTER");
  const author = amended?.author ?? (await repository.identity("AUTHOR"));
  let entries = await repository.readIndex();
  if (all) entries = await stageTracked(repository, entries, [""]);
  const index = indexFiles(entries);
  const tree = await repository.writeTree(index);
  const parents =
    amended !== undefined
      ? amended.parents
      : head.oid === undefined
        ? []
        : [head.oid];
  const parentFiles = await commitFiles(repository, parents[0]);
  const unchanged =
    amended === undefined &&
    (head.oid === undefined
      ? index.size === 0
      : (await repository.readCommit(head.oid)).tree === tree);
  if (unchanged) {
    // Nothing is staged: git prints the status and fails. Staging by -a
    // found nothing either, so the index on disk is the one read.
    const status = await readStatus(repository);
    return {
      stdout: await longStatus(scope, status, "Initial commit"),
      exitCode: 1,
    };
  }
  const message = cleanMessage(messages.join("\n\n"));
  if (message === "") {
    return {
      stderr: "Aborting commit due to empty commit message.\n",
      exitCode: 1,
    };
  }
  if (all) await repository.writeIndex(entries);
  const oid = await repository.writeCommit({
    tree,
    parents,
    author,
    committer,
    message,
  });
  await repository.setHead(oid);
  const changes = await detectRenames(
    repository,
    compareFiles(parentFiles, index),
  );
  let out = `[${
    head.branch === undefined ? "detached HEAD" : utf8(head.branch)
  }${head.oid === undefined ? " (root-commit)" : ""} ${abbreviate(oid)}] ${utf8(subjectOf(message))}\n`;
  if (author.name !== committer.name || author.email !== committer.email) {
    out += ` Author: ${utf8(author.name)} <${utf8(author.email)}>\n`;
  }
  if (amended !== undefined) out += ` Date: ${formatDate(author)}\n`;
  out += shortStat(await fileDiffs(repository, changes)) + summary(changes);
  return { stdout: out };
}

// ---- Diff ----

async function diffCommand(
  scope: Scope | undefined,
  args: string[],
): Promise<Outcome> {
  let cached = false;
  let format: "patch" | "stat" | "name-only" | "name-status" = "patch";
  let formats = 0;
  const before: string[] = [];
  const after: string[] = [];
  let separated = false;
  for (const arg of args) {
    if (separated) after.push(arg);
    else if (arg === "--") separated = true;
    else if (arg === "--cached" || arg === "--staged") cached = true;
    else if (arg === "--stat") {
      format = "stat";
      formats++;
    } else if (arg === "--name-only") {
      format = "name-only";
      formats++;
    } else if (arg === "--name-status") {
      format = "name-status";
      formats++;
    } else if (arg === "-p" || arg === "-u" || arg === "--patch") {
      format = "patch";
      formats++;
    } else if (arg.startsWith("-")) throw unsupportedOption("diff", arg);
    else before.push(arg);
  }
  if (formats > 1) {
    throw new Unsupported("git diff: more than one output format");
  }
  if (scope === undefined) {
    return {
      stderr:
        "warning: Not a git repository. Use --no-index to compare two paths outside a working tree\nusage: git diff --no-index [<options>] <path> <path> [<pathspec>...]\n",
      exitCode: 129,
    };
  }
  const { repository } = scope;
  // An argument before `--` is a revision when it names one, else a path.
  const revisions: string[] = [];
  const pathArguments = [...after];
  for (const arg of before) {
    if (arg.includes("..")) {
      throw new Unsupported(`git diff: revision range '${arg}'`);
    }
    if (pathArguments.length === after.length && !separated) {
      try {
        revisions.push(await repository.resolveCommit(arg));
        continue;
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        const exists = await repository.fs
          .lstat(scope.ctx.fs.resolvePath(scope.ctx.cwd, arg))
          .then(
            () => true,
            () => false,
          );
        if (!exists) throw error;
      }
    } else if (separated) {
      revisions.push(await repository.resolveCommit(arg));
      continue;
    }
    pathArguments.push(arg);
  }
  for (const arg of pathArguments) {
    if (hasGlob(arg)) {
      throw new Unsupported(`git diff: pathspec with wildcard '${arg}'`);
    }
  }
  if (revisions.length > 2 || (cached && revisions.length > 1)) {
    throw new GitError(
      "usage: git diff [<options>] [<commit>] [--] [<path>...]",
      129,
    );
  }
  const prefixes = pathArguments.map((arg) => repositoryPath(scope, arg));
  let old: FileMap;
  let fresh: FileMap;
  if (revisions.length === 2) {
    old = await commitFiles(repository, revisions[0]);
    fresh = await commitFiles(repository, revisions[1]);
  } else {
    const entries = await repository.readIndex();
    const index = indexFiles(entries);
    if (cached) {
      old = await commitFiles(
        repository,
        revisions[0] ?? (await repository.head()).oid,
      );
      fresh = index;
    } else {
      fresh = (await scanWorktree(repository, entries)).files;
      old =
        revisions.length === 1
          ? await commitFiles(repository, revisions[0])
          : index;
    }
  }
  const changes = await detectRenames(
    repository,
    compareFiles(old, fresh, prefixes),
  );
  if (format === "name-only") return { stdout: nameOnly(changes) };
  if (format === "name-status") return { stdout: nameStatus(changes) };
  const diffs = await fileDiffs(repository, changes);
  return { stdout: format === "stat" ? stat(diffs) : patch(diffs) };
}

// ---- Log ----

const PLACEHOLDERS = new Map<string, (commit: Commit) => string>([
  ["H", (commit) => commit.oid],
  ["h", (commit) => abbreviate(commit.oid)],
  ["s", (commit) => utf8(subjectOf(commit.message))],
  ["an", (commit) => utf8(commit.author.name)],
  ["ae", (commit) => utf8(commit.author.email)],
  ["ad", (commit) => formatDate(commit.author)],
  ["cn", (commit) => utf8(commit.committer.name)],
  ["ce", (commit) => utf8(commit.committer.email)],
  ["cd", (commit) => formatDate(commit.committer)],
  ["n", () => "\n"],
]);

/** The parts of a format string: literal bytes and placeholder functions. Fails on a placeholder outside PLACEHOLDERS. */
function parseFormat(
  format: string,
): (string | ((commit: Commit) => string))[] {
  const parts: (string | ((commit: Commit) => string))[] = [];
  let literal = "";
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== "%") {
      literal += format[i];
      continue;
    }
    if (format[i + 1] === "%") {
      literal += "%";
      i++;
      continue;
    }
    const name = [format.slice(i + 1, i + 3), format.slice(i + 1, i + 2)].find(
      (candidate) => PLACEHOLDERS.has(candidate),
    );
    const placeholder = name === undefined ? undefined : PLACEHOLDERS.get(name);
    if (name === undefined || placeholder === undefined) {
      throw new Unsupported(
        `git log: format placeholder '${format.slice(i, i + 3)}'`,
      );
    }
    parts.push(utf8(literal), placeholder);
    literal = "";
    i += name.length;
  }
  parts.push(utf8(literal));
  return parts;
}

async function logCommand(scope: Scope, args: string[]): Promise<Outcome> {
  const { repository } = scope;
  let limit = Number.POSITIVE_INFINITY;
  let render: (commit: Commit) => string = mediumFormat;
  /** What separates two commits, and what follows the last one. */
  let between = "\n";
  let last = "";
  const revisions: string[] = [];
  const pathArguments: string[] = [];
  let separated = false;
  const count = (text: string, option: string): number => {
    if (!/^\d+$/.test(text)) {
      throw new GitError(`fatal: '${text}': not an integer`, 128);
    }
    void option;
    return Number(text);
  };
  const useFormat = (format: string, terminator: boolean) => {
    const parts = parseFormat(format);
    render = (commit) =>
      parts
        .map((part) => (typeof part === "string" ? part : part(commit)))
        .join("");
    between = "\n";
    last = terminator ? "\n" : "";
  };
  const pretty = (value: string, option: string) => {
    if (value.startsWith("format:")) useFormat(value.slice(7), false);
    else if (value.startsWith("tformat:")) useFormat(value.slice(8), true);
    else if (value === "oneline") useFormat("%H %s", true);
    else if (value === "medium") {
      render = mediumFormat;
      between = "\n";
      last = "";
    } else if (value.includes("%")) useFormat(value, true);
    else throw unsupportedOption("log", option);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (separated) pathArguments.push(arg);
    else if (arg === "--") separated = true;
    else if (arg === "--oneline") useFormat("%h %s", true);
    else if (arg === "-n" || arg === "--max-count") {
      if (i + 1 >= args.length) {
        throw new GitError(`error: option \`${arg}' requires a value`, 129);
      }
      limit = count(args[++i], arg);
    } else if (/^-n\d+$/.test(arg)) limit = Number(arg.slice(2));
    else if (/^-\d+$/.test(arg)) limit = Number(arg.slice(1));
    else if (arg.startsWith("--max-count=")) limit = count(arg.slice(12), arg);
    else if (arg.startsWith("--format=")) pretty(arg.slice(9), arg);
    else if (arg.startsWith("--pretty=")) pretty(arg.slice(9), arg);
    else if (arg.startsWith("-")) throw unsupportedOption("log", arg);
    else revisions.push(arg);
  }
  for (const arg of [...revisions, ...pathArguments]) {
    if (arg.includes("..") && revisions.includes(arg)) {
      throw new Unsupported(`git log: revision range '${arg}'`);
    }
    if (hasGlob(arg) && pathArguments.includes(arg)) {
      throw new Unsupported(`git log: pathspec with wildcard '${arg}'`);
    }
  }
  if (revisions.length > 1) {
    throw new Unsupported("git log: more than one revision");
  }
  const head = await repository.head();
  if (revisions.length === 0 && head.oid === undefined) {
    throw new GitError(
      `fatal: your current branch '${branchLabel(head)}' does not have any commits yet`,
    );
  }
  const start = await repository.resolveCommit(revisions[0] ?? "HEAD");
  const prefixes = pathArguments.map((arg) => repositoryPath(scope, arg));

  // Commits leave the queue newest first by committer time.
  const queue: Commit[] = [await repository.readCommit(start)];
  const seen = new Set<string>([start]);
  const shown: string[] = [];
  const changed = async (commit: Commit, parent: string | undefined) => {
    const old =
      parent === undefined
        ? new Map()
        : await repository.treeFiles(
            (await repository.readCommit(parent)).tree,
          );
    const fresh = await repository.treeFiles(commit.tree);
    return compareFiles(old, fresh, prefixes).length > 0;
  };
  while (queue.length > 0 && shown.length < limit) {
    let newest = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].committer.timestamp > queue[newest].committer.timestamp) {
        newest = i;
      }
    }
    const [commit] = queue.splice(newest, 1);
    let follow = commit.parents;
    let show = true;
    if (prefixes.length > 0) {
      if (commit.parents.length === 0) {
        show = await changed(commit, undefined);
      } else {
        // A commit that equals one parent on the paths is left out, and its
        // history continues through that parent only.
        show = true;
        for (const parent of commit.parents) {
          if (!(await changed(commit, parent))) {
            show = false;
            follow = [parent];
            break;
          }
        }
      }
    }
    if (show) shown.push(render(commit));
    for (const parent of follow) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(await repository.readCommit(parent));
      }
    }
  }
  return {
    stdout: shown.length === 0 ? "" : shown.join(between) + last,
  };
}

// ---- Stash ----

async function stashPush(
  scope: Scope,
  message: string | undefined,
): Promise<Outcome> {
  const { repository } = scope;
  const head = await repository.head();
  if (head.oid === undefined) {
    return {
      stderr: "You do not have the initial commit yet\n",
      exitCode: 1,
    };
  }
  const commit = await repository.readCommit(head.oid);
  const headFiles = await repository.treeFiles(commit.tree);
  const entries = await repository.readIndex();
  const index = indexFiles(entries);
  const scan = await scanWorktree(repository, entries);
  const staged = compareFiles(headFiles, index);
  const unstaged = compareFiles(index, scan.files);
  if (staged.length === 0 && unstaged.length === 0) {
    return { stdout: "No local changes to save\n" };
  }
  const author = await repository.identity("AUTHOR");
  const committer = await repository.identity("COMMITTER");
  const base = `${abbreviate(head.oid)} ${subjectOf(commit.message)}`;
  const branch = branchLabel(head);
  const indexCommit = await repository.writeCommit({
    tree: await repository.writeTree(index),
    parents: [head.oid],
    author,
    committer,
    message: `index on ${branch}: ${base}\n`,
  });
  // The tree of the working tree: the index with every tracked file as the
  // working tree holds it.
  const worktree: Map<string, TreeFile> = new Map(index);
  for (const change of unstaged) {
    const file = scan.files.get(change.path);
    if (file === undefined) worktree.delete(change.path);
    else {
      const content = await repository.worktreeContent(change.path, file.mode);
      worktree.set(change.path, {
        oid: await repository.writeBlob(content),
        mode: file.mode,
      });
    }
  }
  const title =
    message === undefined
      ? `WIP on ${branch}: ${base}`
      : `On ${branch}: ${message}`;
  const stash = await repository.writeCommit({
    tree: await repository.writeTree(worktree),
    parents: [head.oid, indexCommit],
    author,
    committer,
    // git writes the message of this commit without a line feed at its end.
    message: title,
  });
  await repository.writeStashEntries(
    [{ oid: stash, message: title }, ...(await repository.stashEntries())],
    committer,
  );
  // Back to HEAD: every path that the index or the working tree changed.
  const touched = new Set([
    ...staged.map((change) => change.path),
    ...unstaged.map((change) => change.path),
  ]);
  for (const path of touched) {
    const file = headFiles.get(path);
    if (file === undefined) await removeFile(repository, path);
    else await checkoutFile(repository, path, file);
  }
  const kept = new Map(
    refreshEntries(entries, scan).map((entry) => [entry.path, entry]),
  );
  const restored: IndexEntry[] = [];
  for (const [path, file] of headFiles) {
    const entry = kept.get(path);
    restored.push(
      entry !== undefined && !touched.has(path)
        ? entry
        : await entryOf(repository, path, file),
    );
  }
  await repository.writeIndex(restored);
  return {
    stdout: `Saved working directory and index state ${utf8(title)}\n`,
  };
}

/** The stash entry an argument names (`stash@{N}` or `N`; the newest without one) and the name git prints for it. */
async function stashEntry(
  repository: Repository,
  argument: string | undefined,
): Promise<{ position: number; oid: string; name: string } | Outcome> {
  const entries = await repository.stashEntries();
  if (entries.length === 0) {
    return { stderr: "No stash entries found.\n", exitCode: 1 };
  }
  const match = /^(?:stash@\{(\d+)\}|(\d+))$/.exec(argument ?? "stash@{0}");
  if (!match) {
    throw new GitError(`error: ${argument} is not a valid reference`, 1);
  }
  const position = Number(match[1] ?? match[2]);
  if (position >= entries.length) {
    throw new GitError(
      `error: stash@{${position}} is not a valid reference`,
      1,
    );
  }
  return {
    position,
    oid: entries[position].oid,
    name: argument === undefined ? "refs/stash@{0}" : `stash@{${position}}`,
  };
}

async function stashApply(
  scope: Scope,
  argument: string | undefined,
  drop: boolean,
): Promise<Outcome> {
  const { repository } = scope;
  const entry = await stashEntry(repository, argument);
  if (!("oid" in entry)) return entry;
  const stash = await repository.readCommit(entry.oid);
  const baseFiles = await commitFiles(repository, stash.parents[0]);
  const stashFiles = await repository.treeFiles(stash.tree);
  const entries = await repository.readIndex();
  const index = indexFiles(entries);
  const scan = await scanWorktree(repository, entries);
  const changes = compareFiles(baseFiles, stashFiles);
  const dirty: string[] = [];
  const conflicts: string[] = [];
  const writes: Change[] = [];
  for (const change of changes) {
    const current = index.get(change.path);
    if (sameFile(current, change.after)) {
      if (!sameFile(scan.files.get(change.path), current)) {
        writes.push(change);
      }
      continue;
    }
    if (!sameFile(current, change.before)) {
      conflicts.push(change.path);
      continue;
    }
    // The working tree must hold what the index holds: no file for a path
    // the index lacks, else the file of the entry.
    const clean =
      current === undefined
        ? (await repository.worktreeFile(change.path)) === undefined
        : sameFile(scan.files.get(change.path), current);
    if (!clean) {
      dirty.push(change.path);
    } else {
      writes.push(change);
    }
  }
  if (dirty.length > 0 || conflicts.length > 0) {
    const status = await longStatus(scope, await readStatus(repository));
    return {
      stdout: drop
        ? `${status}The stash entry is kept in case you need it again.\n`
        : "",
      stderr:
        dirty.length > 0
          ? `error: Your local changes to the following files would be overwritten by merge:\n${dirty.map((path) => `\t${path}\n`).join("")}Please commit your changes or stash them before you merge.\nAborting\n`
          : `error: the stash and the index both change ${conflicts.join(", ")}; applying it needs a merge\n`,
      exitCode: 1,
    };
  }
  const result = new Map(
    refreshEntries(entries, scan).map((item) => [item.path, item]),
  );
  for (const change of writes) {
    if (change.after === undefined) {
      await removeFile(repository, change.path);
    } else {
      await checkoutFile(repository, change.path, change.after);
      // A file that the stash added is staged; a changed file stays as the
      // index has it.
      if (!index.has(change.path)) {
        result.set(
          change.path,
          await entryOf(repository, change.path, change.after),
        );
      }
    }
  }
  await repository.writeIndex([...result.values()]);
  let out = await longStatus(scope, await readStatus(repository));
  if (drop) {
    const remaining = await repository.stashEntries();
    remaining.splice(entry.position, 1);
    await repository.writeStashEntries(
      remaining,
      await repository.identity("COMMITTER"),
    );
    out += `Dropped ${entry.name} (${entry.oid})\n`;
  }
  return { stdout: out };
}

async function stashCommand(scope: Scope, args: string[]): Promise<Outcome> {
  const { repository } = scope;
  const action =
    args.length === 0 || args[0].startsWith("-") ? "push" : args[0];
  const rest = action === args[0] ? args.slice(1) : args;
  if (action === "push") {
    let message: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "-m" || rest[i] === "--message") {
        if (i + 1 >= rest.length) {
          throw new GitError("error: switch `m' requires a value", 129);
        }
        message = rest[++i];
      } else if (rest[i].startsWith("--message=")) {
        message = rest[i].slice(10);
      } else if (rest[i].startsWith("-")) {
        throw unsupportedOption("stash push", rest[i]);
      } else {
        throw new Unsupported(`git stash push: path argument '${rest[i]}'`);
      }
    }
    return stashPush(scope, message);
  }
  if (
    action !== "pop" &&
    action !== "apply" &&
    action !== "list" &&
    action !== "drop"
  ) {
    throw new Unsupported(`git stash ${action}`);
  }
  for (const arg of rest) {
    if (arg.startsWith("-")) throw unsupportedOption(`stash ${action}`, arg);
  }
  if (rest.length > (action === "list" ? 0 : 1)) {
    throw new Unsupported(
      `git stash ${action}: argument '${rest[rest.length - 1]}'`,
    );
  }
  if (action === "list") {
    const entries = await repository.stashEntries();
    return {
      stdout: entries
        .map((entry, i) => `stash@{${i}}: ${utf8(entry.message)}\n`)
        .join(""),
    };
  }
  if (action === "drop") {
    const entry = await stashEntry(repository, rest[0]);
    if (!("oid" in entry)) return entry;
    const remaining = await repository.stashEntries();
    remaining.splice(entry.position, 1);
    await repository.writeStashEntries(
      remaining,
      await repository.identity("COMMITTER"),
    );
    return { stdout: `Dropped ${entry.name} (${entry.oid})\n` };
  }
  return stashApply(scope, rest[0], action === "pop");
}

// ---- Init ----

async function initCommand(
  ctx: RuntimeCommandContext,
  args: string[],
): Promise<Outcome> {
  if (args.length > 0) {
    throw args[0].startsWith("-")
      ? unsupportedOption("init", args[0])
      : new Unsupported(`git init: directory argument '${args[0]}'`);
  }
  const fs = ctx.fs;
  const repository = Repository.at(fs, ctx.cwd, ctx.env);
  const gitdir = repository.gitdir;
  const existed = await fs.exists(`${gitdir}/HEAD`);
  if (!existed) {
    const branch = (await repository.config("init.defaultbranch")) ?? "master";
    for (const directory of [
      "hooks",
      "info",
      "objects/info",
      "objects/pack",
      "refs/heads",
      "refs/tags",
    ]) {
      await fs.mkdir(`${gitdir}/${directory}`, { recursive: true });
    }
    await fs.writeFile(`${gitdir}/HEAD`, `ref: refs/heads/${branch}\n`);
    await fs.writeFile(
      `${gitdir}/config`,
      "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n",
    );
    await fs.writeFile(
      `${gitdir}/description`,
      "Unnamed repository; edit this file 'description' to name the repository.\n",
    );
    await fs.writeFile(
      `${gitdir}/info/exclude`,
      "# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n",
    );
  }
  return {
    stdout: utf8(
      `${existed ? "Reinitialized existing" : "Initialized empty"} Git repository in ${gitdir}/\n`,
    ),
  };
}

// ---- Entry ----

type Subcommand = (scope: Scope, args: string[]) => Promise<Outcome>;

const SUBCOMMANDS = new Map<string, Subcommand>([
  ["add", addCommand],
  ["commit", commitCommand],
  ["status", statusCommand],
  ["log", logCommand],
  ["stash", stashCommand],
]);

async function run(
  args: string[],
  ctx: RuntimeCommandContext,
): Promise<Outcome> {
  let cwd = ctx.cwd;
  let first = 0;
  for (; first < args.length && args[first].startsWith("-"); first++) {
    if (args[first] === "--no-pager") continue;
    if (args[first] === "-C" && first + 1 < args.length) {
      cwd = ctx.fs.resolvePath(cwd, args[++first]);
      continue;
    }
    throw new Unsupported(`git: option '${args[first]}'`);
  }
  const name = args[first];
  if (name === undefined) throw new Unsupported("git without a subcommand");
  const rest = args.slice(first + 1);
  const scoped: RuntimeCommandContext = cwd === ctx.cwd ? ctx : { ...ctx, cwd };
  if (name === "init") return initCommand(scoped, rest);
  const subcommand = SUBCOMMANDS.get(name) ?? TREE_COMMANDS.get(name);
  if (name !== "diff" && subcommand === undefined) {
    throw new Unsupported(`git ${name}`);
  }
  const repository = await Repository.find(ctx.fs, cwd, ctx.env);
  if (repository === undefined) {
    if (name === "diff") return diffCommand(undefined, rest);
    throw new GitError(
      "fatal: not a git repository (or any of the parent directories): .git",
    );
  }
  const scope: Scope = {
    repository,
    prefix:
      cwd === repository.root
        ? ""
        : cwd.slice(repository.root === "/" ? 1 : repository.root.length + 1),
    ctx: scoped,
  };
  return subcommand === undefined
    ? diffCommand(scope, rest)
    : subcommand(scope, rest);
}

export const gitCommand: RuntimeCommand = {
  name: "git",
  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    try {
      const outcome = await run(args, ctx);
      return {
        ...bytesOutput(unsafeBytesFromLatin1(outcome.stdout ?? "")),
        stderr: outcome.stderr ?? "",
        exitCode: outcome.exitCode ?? 0,
      };
    } catch (error) {
      if (error instanceof Unsupported) {
        return {
          stdout: "",
          stderr: `${sanitizeErrorMessage(error.message)} is not supported in this environment\n`,
          exitCode: 129,
        };
      }
      if (error instanceof GitError) {
        return {
          stdout: "",
          stderr: `${sanitizeErrorMessage(error.message)}\n`,
          exitCode: error.exitCode,
        };
      }
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "ExecutionLimitError" || name === "ExecutionAbortedError") {
        throw error;
      }
      return {
        stdout: "",
        stderr: `fatal: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}\n`,
        exitCode: 128,
      };
    }
  },
};
