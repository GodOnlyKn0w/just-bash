/**
 * What the subcommands of git share: how a subcommand is called and what it
 * gives back, paths of arguments, and the steps that move files between the
 * object database, the index, and the working tree.
 */
import type { RuntimeCommandContext } from "../../types.js";
import type { WorktreeScan } from "./changes.js";
import { utf8 } from "./diff-output.js";
import type { IndexEntry } from "./index-file.js";
import {
  type Commit,
  formatDate,
  GitError,
  MODE_SYMLINK,
  type Repository,
  type TreeFile,
} from "./repository.js";

/** A subcommand or an option that this git does not implement. */
export class Unsupported extends Error {}

/** What a subcommand gives back: stdout as bytes (one character for each byte), stderr as text. */
export interface Outcome {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

/** The repository a subcommand runs in, and the caller's directory relative to its root ("" at the root). */
export interface Scope {
  readonly repository: Repository;
  readonly prefix: string;
  readonly ctx: RuntimeCommandContext;
}

const ABBREVIATION = 7;

export function abbreviate(oid: string): string {
  return oid.slice(0, ABBREVIATION);
}

export function unsupportedOption(
  subcommand: string,
  option: string,
): Unsupported {
  return new Unsupported(`git ${subcommand}: option '${option}'`);
}

/** The path of an argument relative to the root of the working tree; "" for the root itself. */
export function repositoryPath(scope: Scope, argument: string): string {
  const { repository, ctx } = scope;
  const absolute = ctx.fs.resolvePath(ctx.cwd, argument);
  if (absolute === repository.root) return "";
  const base = repository.root === "/" ? "/" : `${repository.root}/`;
  if (!absolute.startsWith(base)) {
    throw new GitError(
      `fatal: ${argument}: '${argument}' is outside repository at '${repository.root}'`,
    );
  }
  return absolute.slice(base.length);
}

/** A path of the working tree relative to the caller's directory, as status prints it; a directory keeps its trailing slash. */
export function relativePath(path: string, prefix: string): string {
  if (prefix === "") return path;
  const directory = path.endsWith("/");
  const from = prefix.split("/");
  const to = (directory ? path.slice(0, -1) : path).split("/");
  let shared = 0;
  while (
    shared < from.length &&
    shared < to.length &&
    from[shared] === to[shared]
  ) {
    shared++;
  }
  const relative = [
    ...new Array<string>(from.length - shared).fill(".."),
    ...to.slice(shared),
  ].join("/");
  return (relative === "" ? "." : relative) + (directory ? "/" : "");
}

export function hasGlob(path: string): boolean {
  return /[*?[]/.test(path);
}

export interface Tracking {
  readonly upstream: string;
  readonly ahead: number;
  readonly behind: number;
}

/** The upstream branch that the config names for branch, with the commits each side has that the other lacks. */
export async function tracking(
  repository: Repository,
  head: { branch?: string; oid?: string },
): Promise<Tracking | undefined> {
  if (head.branch === undefined || head.oid === undefined) return undefined;
  const remote = await repository.config(`branch.${head.branch}.remote`);
  const merge = await repository.config(`branch.${head.branch}.merge`);
  if (remote === undefined || merge === undefined) return undefined;
  const name = merge.replace(/^refs\/heads\//, "");
  const ref = remote === "." ? merge : `refs/remotes/${remote}/${name}`;
  const upstream = await repository.resolveRefName(ref);
  if (upstream === undefined) return undefined;
  const ancestors = async (start: string): Promise<Set<string>> => {
    const seen = new Set<string>([start]);
    const queue = [start];
    for (let oid = queue.pop(); oid !== undefined; oid = queue.pop()) {
      for (const parent of (await repository.readCommit(oid)).parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return seen;
  };
  const mine = await ancestors(head.oid);
  const theirs = await ancestors(upstream);
  let ahead = 0;
  let behind = 0;
  for (const oid of mine) if (!theirs.has(oid)) ahead++;
  for (const oid of theirs) if (!mine.has(oid)) behind++;
  return {
    upstream: remote === "." ? name : `${remote}/${name}`,
    ahead,
    behind,
  };
}

function splitTime(milliseconds: number): {
  mtimeSeconds: number;
  mtimeNanoseconds: number;
} {
  return {
    mtimeSeconds: Math.floor(milliseconds / 1000),
    mtimeNanoseconds: (milliseconds % 1000) * 1e6,
  };
}

/** The entries with the size and time of the files that a scan read and found unchanged. */
export function refreshEntries(
  entries: readonly IndexEntry[],
  scan: WorktreeScan,
): IndexEntry[] {
  return entries.map((entry) => {
    const fresh =
      entry.stage === 0 ? scan.refreshed.get(entry.path) : undefined;
    return fresh === undefined
      ? entry
      : { ...entry, size: fresh.size, ...splitTime(fresh.mtime) };
  });
}

/** Stores the working tree file at path as a blob and returns its index entry; undefined when there is no file. */
export async function stageFile(
  repository: Repository,
  path: string,
): Promise<IndexEntry | undefined> {
  const file = await repository.worktreeFile(path);
  if (file === undefined) return undefined;
  const content = await repository.worktreeContent(path, file.mode);
  return {
    path,
    oid: await repository.writeBlob(content),
    mode: file.mode,
    size: file.mode === MODE_SYMLINK ? content.length : file.size,
    ...splitTime(file.mtime),
    stage: 0,
  };
}

/** The index entry of a file that a checkout wrote to the working tree. */
export async function entryOf(
  repository: Repository,
  path: string,
  file: TreeFile,
): Promise<IndexEntry> {
  const written = await repository.worktreeFile(path);
  return {
    path,
    oid: file.oid,
    mode: file.mode,
    size: written?.size ?? 0,
    ...splitTime(written?.mtime ?? 0),
    stage: 0,
  };
}

/** The subject of a commit: the lines of its first paragraph joined by spaces. */
export function subjectOf(message: string): string {
  return message
    .replace(/^\n+|\n+$/g, "")
    .split("\n\n")[0]
    .split("\n")
    .join(" ");
}

export function branchLabel(head: { branch?: string }): string {
  return head.branch ?? "(no branch)";
}

export function mediumFormat(commit: Commit): string {
  let out = `commit ${commit.oid}\n`;
  if (commit.parents.length > 1) {
    out += `Merge: ${commit.parents.map(abbreviate).join(" ")}\n`;
  }
  out += `Author: ${utf8(commit.author.name)} <${utf8(commit.author.email)}>\nDate:   ${formatDate(commit.author)}\n\n`;
  for (const line of commit.message.replace(/\n+$/, "").split("\n")) {
    out += `    ${utf8(line)}\n`;
  }
  return out;
}

/** Writes the content of a tree file to the working tree. */
export async function checkoutFile(
  repository: Repository,
  path: string,
  file: TreeFile,
): Promise<void> {
  const fs = repository.fs;
  const absolute = repository.worktreePath(path);
  const content = await repository.readBlob(file.oid);
  const slash = absolute.lastIndexOf("/");
  if (slash > 0) await fs.mkdir(absolute.slice(0, slash), { recursive: true });
  await fs.rm(absolute, { force: true });
  if (file.mode === MODE_SYMLINK) {
    await fs.symlink(new TextDecoder().decode(content), absolute);
  } else {
    await fs.writeFile(absolute, content);
    await fs.chmod(absolute, file.mode & 0o777);
  }
}

/** Removes a file of the working tree and the directories this leaves empty. */
export async function removeFile(
  repository: Repository,
  path: string,
): Promise<void> {
  const fs = repository.fs;
  await fs.rm(repository.worktreePath(path), { force: true });
  for (
    let slash = path.lastIndexOf("/");
    slash > 0;
    slash = path.lastIndexOf("/", slash - 1)
  ) {
    const directory = repository.worktreePath(path.slice(0, slash));
    try {
      if ((await fs.readdir(directory)).length > 0) return;
      await fs.rm(directory, { recursive: true });
    } catch {
      return;
    }
  }
}

export function sameFile(
  a: TreeFile | undefined,
  b: TreeFile | undefined,
): boolean {
  return a?.oid === b?.oid && a?.mode === b?.mode;
}

/** The lines of `git status` about the upstream branch. */
export function trackingLines(upstream: Tracking): string {
  const { ahead, behind } = upstream;
  const branch = utf8(upstream.upstream);
  const plural = (count: number) => (count === 1 ? "" : "s");
  if (ahead === 0 && behind === 0) {
    return `Your branch is up to date with '${branch}'.\n`;
  }
  if (behind === 0) {
    return `Your branch is ahead of '${branch}' by ${ahead} commit${plural(ahead)}.\n  (use "git push" to publish your local commits)\n`;
  }
  if (ahead === 0) {
    return `Your branch is behind '${branch}' by ${behind} commit${plural(behind)}, and can be fast-forwarded.\n  (use "git pull" to update your local branch)\n`;
  }
  return `Your branch and '${branch}' have diverged,\nand have ${ahead} and ${behind} different commits each, respectively.\n  (use "git pull" if you want to integrate the remote branch with yours)\n`;
}
