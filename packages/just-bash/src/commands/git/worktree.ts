/**
 * The files of the working tree that the index does not hold: the ignore
 * rules of `.gitignore` files and `.git/info/exclude`, and the untracked
 * files that `git status` and `git add` see.
 */
import { createUserRegex, type RegexLike } from "../../regex/index.js";
import { comparePaths } from "./index-file.js";
import type { Repository } from "./repository.js";

interface Rule {
  readonly pattern: RegexLike;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
}

/** A gitignore glob as the source of a regular expression that matches a path of segments joined by "/". */
function globSource(glob: string): string {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const character = glob[i];
    if (character === "*") {
      if (glob[i + 1] === "*") {
        const startsSegment = i === 0 || glob[i - 1] === "/";
        if (startsSegment && glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) {
        source += "\\[";
      } else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        source += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (character === "\\" && i + 1 < glob.length) {
      source += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return source;
}

/** The rules of one ignore file, in the order of its lines. */
function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.replace(/\r$/, "");
    if (line === "" || line.startsWith("#")) continue;
    // White space at the end counts only after a backslash.
    line = line.replace(/(?<!\\)\s+$/, "");
    if (line === "") continue;
    const negated = line.startsWith("!");
    if (negated) line = line.slice(1);
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    if (line === "") continue;
    // A pattern with a slash matches from the directory of its file; one
    // without matches a name at any depth below it.
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const source = globSource(line);
    rules.push({
      pattern: createUserRegex(
        anchored ? `^${source}$` : `^(?:.*/)?${source}$`,
      ),
      negated,
      directoryOnly,
    });
  }
  return rules;
}

/** The ignore rules of a repository, read from each directory when a path below it is first tested. */
export class IgnoreRules {
  private readonly repository: Repository;
  private readonly byDirectory = new Map<string, Promise<Rule[]>>();

  constructor(repository: Repository) {
    this.repository = repository;
  }

  private async read(path: string): Promise<Rule[]> {
    try {
      return parseRules(await this.repository.fs.readFile(path));
    } catch {
      return [];
    }
  }

  /** The rules of the `.gitignore` in directory; for the root, preceded by those of `.git/info/exclude`. */
  private rules(directory: string): Promise<Rule[]> {
    let rules = this.byDirectory.get(directory);
    if (rules === undefined) {
      const file = this.repository.worktreePath(
        directory === "" ? ".gitignore" : `${directory}/.gitignore`,
      );
      rules =
        directory === ""
          ? Promise.all([
              this.read(`${this.repository.gitdir}/info/exclude`),
              this.read(file),
            ]).then(([exclude, own]) => [...exclude, ...own])
          : this.read(file);
      this.byDirectory.set(directory, rules);
    }
    return rules;
  }

  /** Whether the rules ignore path itself; the directories above it are not tested. */
  async ignores(path: string, isDirectory: boolean): Promise<boolean> {
    const segments = path.split("/");
    for (let depth = segments.length - 1; depth >= 0; depth--) {
      const directory = segments.slice(0, depth).join("/");
      const relative = segments.slice(depth).join("/");
      const rules = await this.rules(directory);
      for (let i = rules.length - 1; i >= 0; i--) {
        const rule = rules[i];
        if (rule.directoryOnly && !isDirectory) continue;
        if (rule.pattern.test(relative)) return !rule.negated;
      }
    }
    return false;
  }

  /** Whether the rules ignore path or a directory above it. */
  async ignoresWithParents(
    path: string,
    isDirectory: boolean,
  ): Promise<boolean> {
    const segments = path.split("/");
    for (let depth = 1; depth <= segments.length; depth++) {
      const part = segments.slice(0, depth).join("/");
      const directory = depth < segments.length || isDirectory;
      if (await this.ignores(part, directory)) return true;
    }
    return false;
  }
}

/** The entries of a directory of the working tree; none when it cannot be listed. A link to a directory is not a directory. */
async function listDirectory(
  repository: Repository,
  directory: string,
): Promise<{ name: string; isDirectory: boolean }[]> {
  const fs = repository.fs;
  const absolute = repository.worktreePath(directory);
  try {
    if (fs.readdirWithFileTypes !== undefined) {
      return await fs.readdirWithFileTypes(absolute);
    }
    const entries: { name: string; isDirectory: boolean }[] = [];
    for (const name of await fs.readdir(absolute)) {
      const stats = await fs.lstat(`${absolute}/${name}`);
      entries.push({ name, isDirectory: stats.isDirectory });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * The untracked files of the working tree below directory ("" for the
 * root), sorted by path. With collapse, a directory that holds no tracked
 * file is one entry with a trailing slash, given when it holds at least one
 * file that is not ignored; without collapse every such file is an entry.
 */
export async function untrackedFiles(
  repository: Repository,
  tracked: ReadonlySet<string>,
  ignore: IgnoreRules,
  collapse: boolean,
  directory = "",
): Promise<string[]> {
  const trackedDirectories = new Set<string>();
  for (const path of tracked) {
    for (
      let slash = path.indexOf("/");
      slash !== -1;
      slash = path.indexOf("/", slash + 1)
    ) {
      trackedDirectories.add(path.slice(0, slash));
    }
  }
  const found: string[] = [];
  /** Lists the entries below directory; with probe, stops at the first one. */
  const visit = async (
    current: string,
    collapsing: boolean,
    probe: boolean,
  ): Promise<boolean> => {
    const names = await listDirectory(repository, current);
    let any = false;
    for (const entry of names) {
      if (current === "" && entry.name === ".git") continue;
      const path = current === "" ? entry.name : `${current}/${entry.name}`;
      if (entry.isDirectory) {
        if (trackedDirectories.has(path)) {
          if (await visit(path, collapsing, probe)) any = true;
        } else if (!(await ignore.ignores(path, true))) {
          if (collapsing) {
            if (await visit(path, false, true)) {
              any = true;
              if (!probe) found.push(`${path}/`);
            }
          } else if (await visit(path, false, probe)) {
            any = true;
          }
        }
      } else if (!tracked.has(path) && !(await ignore.ignores(path, false))) {
        any = true;
        if (!probe) found.push(path);
      }
      if (probe && any) return true;
    }
    return any;
  };
  await visit(directory, collapse, false);
  return found.sort(comparePaths);
}
