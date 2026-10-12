import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

function hostHasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ENV = {
  PATH: process.env.PATH ?? "",
  HOME: "/nonexistent",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
};

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Runs git in directory on the host and returns its stdout with one character for each byte. */
function hostGit(directory: string, args: string[], date?: number): string {
  return execFileSync("git", args, {
    cwd: directory,
    env:
      date === undefined
        ? ENV
        : {
            ...ENV,
            GIT_AUTHOR_DATE: `@${date} +0200`,
            GIT_COMMITTER_DATE: `@${date + 60} -0500`,
          },
    encoding: "latin1",
    maxBuffer: 1 << 26,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * A repository made by the host's git: five commits on two branches with a
 * merge, an annotated tag, everything packed by `git gc`, and then changes
 * of every kind left in the index and the working tree.
 */
function hostRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), "git-real-"));
  directories.push(directory);
  const write = (path: string, content: string | Uint8Array) => {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    writeFileSync(join(directory, path), content);
  };
  let date = 1700000000;
  const git = (...args: string[]) => {
    date += 3600;
    return hostGit(directory, args, date);
  };
  git("init", "--initial-branch=main");
  write("README.md", "# Project\n\nA line.\n");
  write(
    "src/main.c",
    '#include <stdio.h>\n\nint main(void)\n{\n\tprintf("hello\\n");\n\treturn 0;\n}\n',
  );
  write("src/util/helper.c", "int helper(void)\n{\n\treturn 1;\n}\n");
  write("data/blob.bin", new Uint8Array([0, 1, 2, 3, 255, 254]));
  write(".gitignore", "*.o\nbuild/\n");
  write("run.sh", "#!/bin/sh\necho run\n");
  chmodSync(join(directory, "run.sh"), 0o755);
  symlinkSync("README.md", join(directory, "link"));
  git("add", "-A");
  git("commit", "-m", "Initial import\n\nWith a body line.");
  write(
    "src/main.c",
    readFileSync(join(directory, "src/main.c"), "utf8").replace(
      "hello",
      "hello, world",
    ),
  );
  git("commit", "-am", "Greet the world");
  git("switch", "-c", "feature");
  write("docs/guide.md", "Guide\n=====\n\nText.\n");
  git("add", "-A");
  git("commit", "-m", "Add the guide");
  git("switch", "main");
  write("README.md", "# Project\n\nA line.\nAnother line.\n");
  git("commit", "-am", "Extend the readme");
  git("merge", "--no-ff", "-m", "Merge feature", "feature");
  git("tag", "-a", "v1.0", "-m", "Version 1.0");
  git("gc", "--quiet");
  // Uncommitted state: staged, unstaged, deleted, renamed, and untracked.
  write(
    "src/main.c",
    readFileSync(join(directory, "src/main.c"), "utf8").replace(
      "return 0;",
      "return 1;",
    ),
  );
  write("staged.txt", "staged\n");
  hostGit(directory, ["add", "staged.txt"]);
  renameSync(
    join(directory, "src/util/helper.c"),
    join(directory, "src/util/renamed.c"),
  );
  hostGit(directory, ["add", "-A", "src/util"]);
  unlinkSync(join(directory, "data/blob.bin"));
  write("README.md", "# Project\n\nA changed line.\nAnother line.\n");
  write("untracked.txt", "untracked\n");
  write("build/out.o", "ignored\n");
  write("scratch/notes/a.md", "notes\n");
  return directory;
}

/** A Bash whose file system holds a copy of every byte below a host directory, at `/repo`. */
async function loaded(directory: string): Promise<Bash> {
  const bash = new Bash({
    cwd: "/repo",
    env: { ...ENV, PATH: "/usr/bin:/bin" },
  });
  const copy = async (host: string, virtual: string): Promise<void> => {
    await bash.fs.mkdir(virtual, { recursive: true });
    for (const name of readdirSync(host)) {
      const from = join(host, name);
      const to = `${virtual}/${name}`;
      const stats = lstatSync(from);
      if (stats.isSymbolicLink()) await bash.fs.symlink(readlinkSync(from), to);
      else if (stats.isDirectory()) await copy(from, to);
      else {
        await bash.fs.writeFile(to, new Uint8Array(readFileSync(from)));
        await bash.fs.chmod(to, stats.mode & 0o777);
      }
    }
  };
  await copy(directory, "/repo");
  return bash;
}

describe.skipIf(!hostHasGit())(
  "git on a repository made by the host's git (skipped when the host has no git)",
  () => {
    const directory = hostRepository();

    it("stores its history in a pack file and its refs in packed-refs", () => {
      expect(readdirSync(join(directory, ".git/objects/pack")).length).toBe(3);
      expect(
        readFileSync(join(directory, ".git/packed-refs"), "utf8"),
      ).toContain("refs/heads/main");
    });

    it.each([
      ["status"],
      ["status", "--short", "--branch"],
      ["status", "--porcelain"],
      ["log"],
      ["log", "--oneline"],
      ["log", "--format=%H %an %ae %ad %cn %ce %cd %s"],
      ["log", "--oneline", "--", "docs"],
      ["log", "--oneline", "--", "README.md"],
      ["log", "-2", "feature"],
      ["log", "--oneline", "v1.0"],
      ["diff"],
      ["diff", "--stat"],
      ["diff", "--cached"],
      ["diff", "--cached", "--name-status"],
      ["diff", "HEAD"],
      ["diff", "HEAD~1", "HEAD"],
      ["diff", "feature", "main", "--stat"],
      ["diff", "HEAD^2", "--name-only"],
    ])("prints what the host's git prints for git %s %s %s", async (...args) => {
      const words = args.filter((arg) => arg !== undefined);
      const bash = await loaded(directory);
      const result = await bash.exec(
        `git ${words.map((word) => `'${word}'`).join(" ")}`,
      );
      expect(result.stderr).toBe("");
      expect(Buffer.from(result.stdout, "utf8").toString("latin1")).toBe(
        hostGit(directory, words),
      );
      expect(result.exitCode).toBe(0);
    });

    it("commits on top of the packed history with the object ids of the host's git", async () => {
      const bash = await loaded(directory);
      const dates =
        "GIT_AUTHOR_DATE='@1700090000 +0200' GIT_COMMITTER_DATE='@1700090060 -0500'";
      const mine = await bash.exec(
        `${dates} git commit -a -m 'Commit everything tracked' && git log --format=%H -3 && git status --short`,
      );
      const copy = mkdtempSync(join(tmpdir(), "git-real-copy-"));
      directories.push(copy);
      execFileSync("cp", ["-a", `${directory}/.`, copy]);
      const real =
        execFileSync(
          "git",
          ["commit", "-a", "-m", "Commit everything tracked"],
          {
            cwd: copy,
            env: {
              ...ENV,
              GIT_AUTHOR_DATE: "@1700090000 +0200",
              GIT_COMMITTER_DATE: "@1700090060 -0500",
            },
            encoding: "utf8",
          },
        ) +
        hostGit(copy, ["log", "--format=%H", "-3"]) +
        hostGit(copy, ["status", "--short"]);
      expect(mine.stderr).toBe("");
      expect(mine.stdout).toBe(real);
    });
  },
);
