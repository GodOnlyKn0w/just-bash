import { afterEach, beforeEach, describe, it } from "vitest";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

/**
 * Every script starts from the same environment: no configuration outside
 * the repository, and a fixed author, committer, and dates, so that commit
 * ids are the same in every run.
 */
const ENVIRONMENT = [
  "export HOME=/nonexistent GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1",
  "export GIT_AUTHOR_NAME='A U Thor' GIT_AUTHOR_EMAIL=author@example.com GIT_AUTHOR_DATE='@1700000000 +0800'",
  "export GIT_COMMITTER_NAME='C O Mitter' GIT_COMMITTER_EMAIL=committer@example.com GIT_COMMITTER_DATE='2023-11-15T10:00:00+01:00'",
].join("\n");

const FILES = {
  "a.txt": "one\ntwo\nthree\n",
  "sub/deep/x.txt": "x\n",
  "sub/y.txt": "y\n",
  ".gitignore": "*.log\nbuild/\n",
  "t.log": "log\n",
  "build/out.js": "out\n",
};

/** The steps that commit FILES and then change the working tree in every way status distinguishes. */
const COMMITTED =
  "git init >/dev/null 2>&1; git add . && git commit -m first >/dev/null";
const CHANGED = [
  COMMITTED,
  "printf 'one\\n2\\nthree\\nfour\\n' > a.txt",
  "rm sub/y.txt",
  "mv sub/deep/x.txt sub/deep/z.txt",
  "printf '\\000\\001bin' > b.bin",
  "echo n > new.txt",
  "mkdir -p other/dir; echo o > other/dir/o.txt",
].join("\n");

describe("git command - Real Bash Comparison", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  const cases: [name: string, script: string][] = [
    // init
    [
      "init in an empty directory, and again",
      `git init 2>/dev/null | sed "s|$PWD|DIR|"; git init 2>/dev/null | sed "s|$PWD|DIR|"; cat .git/HEAD`,
    ],
    // status
    ["status before the first commit", "git init >/dev/null 2>&1; git status"],
    [
      "status with untracked files and a .gitignore",
      "git init >/dev/null 2>&1; git status; git status -s; git status --porcelain; git status -b --short",
    ],
    [
      "status with a staged file before the first commit",
      "git init >/dev/null 2>&1; git add a.txt; git status; git status --porcelain -b",
    ],
    ["status of a clean tree", `${COMMITTED}; git status; git status -sb`],
    [
      "status with modified, deleted, and untracked files",
      `${CHANGED}; git status; git status --short; git status --porcelain; git status -s -b`,
    ],
    [
      "status with staged changes, a rename, and a binary file",
      `${CHANGED}; git add -A; git status; git status -s`,
    ],
    [
      "status with a file both staged and changed again",
      `${CHANGED}; git add a.txt; echo five >> a.txt; git status; git status -s`,
    ],
    [
      "status from a subdirectory",
      `${CHANGED}; cd sub; git status; git status -s; git status --porcelain`,
    ],
    // add
    [
      "add of paths, a directory, and the current directory",
      `${CHANGED}; git add a.txt; git status -s; git add sub; git status -s; git add .; git status -s`,
    ],
    ["add -A", `${CHANGED}; git add -A; git status -s`],
    [
      "add --all in a subdirectory",
      `${CHANGED}; cd sub; git add --all; git status -s`,
    ],
    ["add -u", `${CHANGED}; git add -u; git status -s`],
    ["add -u with a path", `${CHANGED}; git add -u sub/deep; git status -s`],
    [
      "add of a path that does not exist",
      `${COMMITTED}; git add nosuch.txt 2>/dev/null; echo $?; git status -s`,
    ],
    [
      "add of an ignored file",
      `${COMMITTED}; git add t.log 2>/dev/null; echo $?; git add build 2>/dev/null; echo $?; git status -s`,
    ],
    // commit
    [
      "commit -m, with the object id of the root commit",
      "git init >/dev/null 2>&1; git add .; git commit -m first; git log --format=%H",
    ],
    [
      "commit with two -m and a message that needs cleanup",
      "git init >/dev/null 2>&1; git add .; git commit -m '  subject  ' -m 'body line  \n\n\nlast'; git log",
    ],
    [
      "commit with nothing staged",
      `git init >/dev/null 2>&1; git commit -m none; echo $?; ${COMMITTED.slice(COMMITTED.indexOf(";") + 2)}; git commit -m none; echo $?; echo x >> a.txt; git commit -m none; echo $?`,
    ],
    [
      "commit -a",
      `${CHANGED}; git commit -a -m 'all tracked'; git status -s; git log --format='%H %s'`,
    ],
    [
      "commit -am with a mode change, a rename, a new file, and a deletion",
      `${CHANGED}; chmod +x a.txt; git add -A; git commit -am second; git log --format=%H`,
    ],
    [
      "commit --amend -m",
      `${COMMITTED}; echo more >> a.txt; git add a.txt; git commit --amend -m 'first, amended'; git log --format='%H %s'; git status`,
    ],
    [
      "commit without an identity",
      "unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL; export EMAIL=; git init >/dev/null 2>&1; git add .; git -c user.useConfigOnly=true commit -m first >/dev/null 2>&1 || git commit -m first >/dev/null 2>&1; echo $?",
    ],
    [
      "commit with the identity of the repository config",
      "unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL; git init >/dev/null 2>&1; printf '[user]\\n\\tname = Config Name\\n\\temail = config@example.com\\n' >> .git/config; git add .; git commit -m first; git log --format='%H %an %ae %cn %ce'",
    ],
    // diff
    ["diff of the working tree", `${CHANGED}; git diff`],
    [
      "diff --stat, --name-only, --name-status",
      `${CHANGED}; git diff --stat; git diff --name-only; git diff --name-status`,
    ],
    [
      "diff --cached and --staged with a rename and a binary file",
      `${CHANGED}; git add -A; git diff --cached; git diff --staged --stat; git diff --cached --name-status; git diff --cached --name-only`,
    ],
    [
      "diff --cached before the first commit",
      "git init >/dev/null 2>&1; git add a.txt sub; git diff --cached; git diff --cached --stat",
    ],
    [
      "diff against a commit",
      `${CHANGED}; git add a.txt; echo five >> a.txt; git diff HEAD; git diff HEAD --stat; git diff --cached HEAD --name-status`,
    ],
    [
      "diff between two commits",
      `${CHANGED}; git add -A; git commit -m second >/dev/null; git diff HEAD~1 HEAD; git diff HEAD~1 HEAD --stat; git diff HEAD HEAD^ --name-status`,
    ],
    [
      "diff limited to paths",
      `${CHANGED}; git diff -- a.txt; git diff --stat -- sub; git diff --name-only -- sub/deep a.txt; git diff HEAD -- sub/y.txt; git diff a.txt`,
    ],
    [
      "diff with several hunks, function lines, and a file without a final line feed",
      "git init >/dev/null 2>&1; seq 1 40 > n.txt; printf 'function alpha() {\\n  return 1;\\n}\\n\\nfunction beta() {\\n  return 2;\\n}\\n\\nfunction gamma() {\\n  return 3;\\n}\\n' > code.js; printf 'no newline' > nonl.txt; git add .; git commit -m base >/dev/null; sed -i 's/^3$/three/; s/^20$/twenty/; s/^38$/thirty-eight/' n.txt; sed -i 's/return 3;/return 33;/' code.js; printf 'changed' > nonl.txt; git diff; git diff --stat",
    ],
    [
      "diff of a mode change, a symbolic link, and a file that becomes a link",
      `${COMMITTED}; chmod +x a.txt; ln -s a.txt link; git add -A; git diff --cached; git commit -m links >/dev/null; rm sub/y.txt; ln -s ../a.txt sub/y.txt; git diff; git status -s`,
    ],
    [
      "diff of a rename with a change",
      "git init >/dev/null 2>&1; seq 1 30 > old.txt; git add .; git commit -m base >/dev/null; mv old.txt new.txt; sed -i 's/^7$/seven/' new.txt; git add -A; git diff --cached; git diff --cached --stat; git diff --cached --name-status; git status -s; git commit -m renamed",
    ],
    [
      "diff of paths with a space and with characters outside ASCII",
      "git init >/dev/null 2>&1; mkdir 'sp ace'; echo 1 > 'sp ace/fi le.txt'; echo 1 > 'ünï.txt'; git add .; git status -s; git commit -m base; echo 2 >> 'sp ace/fi le.txt'; echo 2 >> 'ünï.txt'; git diff; git diff --stat; git status; git status -s",
    ],
    // log
    [
      "log in the default format and --oneline",
      `${CHANGED}; git add -A; git commit -m second -m 'A body.' >/dev/null; git log; git log --oneline`,
    ],
    [
      "log -n, -<number>, and --max-count",
      `${CHANGED}; git add -A; git commit -m second >/dev/null; echo 3 >> a.txt; git commit -am third >/dev/null; git log -n 2 --oneline; git log -1 --oneline; git log -n1 --oneline; git log --max-count=2 --oneline`,
    ],
    [
      "log --format and --pretty=format with every placeholder",
      `${CHANGED}; git add -A; git commit -m second >/dev/null; git log --format='%H %h %s|%an|%ae|%ad|%cn|%ce|%cd%nnext %%'; git log --pretty=format:'%h %s'; echo; git log --pretty=tformat:'%s'; git log --format=format:'%an'`,
    ],
    [
      "log limited to paths",
      `${CHANGED}; git add -A; git commit -m second >/dev/null; echo 3 >> new.txt; git commit -am third >/dev/null; git log --oneline -- a.txt; git log --oneline -- sub; git log --oneline -- new.txt nosuch; git log --format=%s -- sub/deep/x.txt`,
    ],
    [
      "log before the first commit",
      "git init >/dev/null 2>&1; git log 2>/dev/null; echo $?",
    ],
    // stash
    [
      "stash, list, and pop",
      `${COMMITTED}; echo more >> a.txt; echo n > new.txt; git add new.txt; rm sub/y.txt; git stash; git status; git stash list; git stash pop; git stash list; git status -s`,
    ],
    [
      "stash push -m, apply, and drop",
      `${COMMITTED}; echo more >> a.txt; git stash push -m 'named entry'; git stash list; git stash apply; git stash list; git stash drop; git stash list; git diff`,
    ],
    [
      "two stash entries, dropped and popped by position",
      `${COMMITTED}; echo 1 >> a.txt; git stash; echo 2 >> sub/y.txt; git stash -m second; git stash list; git stash drop stash@{1}; git stash list; git stash pop stash@{0}; git status -s`,
    ],
    [
      "stash without changes, without entries, and before the first commit",
      `git init >/dev/null 2>&1; git stash 2>/dev/null; echo $?; ${COMMITTED.slice(COMMITTED.indexOf(";") + 2)}; git stash; echo $?; git stash pop 2>/dev/null; echo $?; git stash drop 2>/dev/null; echo $?; git stash list`,
    ],
    [
      "stash pop onto a changed file",
      `${COMMITTED}; echo 1 >> a.txt; git stash; echo 2 >> a.txt; git stash pop 2>/dev/null; echo $?; git stash list`,
    ],
    // rev-parse
    [
      "rev-parse of HEAD, --short, --show-toplevel, and --abbrev-ref",
      `${COMMITTED}; git rev-parse HEAD; git rev-parse --short HEAD; git rev-parse --short=10 HEAD; git rev-parse --show-toplevel | sed "s|$PWD|DIR|"; git rev-parse --abbrev-ref HEAD; cd sub; git rev-parse --show-toplevel | sed "s|\${PWD%/sub}|DIR|"; git rev-parse nosuch 2>/dev/null; echo $?`,
    ],
    [
      "rev-parse before the first commit",
      "git init >/dev/null 2>&1; git rev-parse HEAD 2>/dev/null; echo $?; git rev-parse --abbrev-ref HEAD 2>/dev/null; echo $?",
    ],
    // branch, switch, checkout
    [
      "branch list, create, and delete",
      `git init >/dev/null 2>&1; git branch; git branch early 2>/dev/null; echo $?; git add . && git commit -m first >/dev/null; git branch; git branch feature; git branch zeta HEAD; git branch; git branch feature 2>/dev/null; echo $?; git branch -d feature; git branch -d nosuch 2>/dev/null; echo $?; git branch -d master 2>/dev/null; echo $?; git branch`,
    ],
    [
      "branch -d of a branch that is not merged, and -D",
      `${COMMITTED}; git switch -c feature 2>/dev/null; echo f > f.txt; git add f.txt; git commit -m feature >/dev/null; git switch master 2>/dev/null; git branch -d feature 2>/dev/null; echo $?; git branch -D feature; git branch`,
    ],
    [
      "switch between branches with a local change carried along",
      `${COMMITTED}; git switch -c feature 2>/dev/null; echo f > f.txt; git add f.txt; git commit -m feature >/dev/null; git switch master 2>/dev/null; ls; echo local >> a.txt; git switch feature; ls; git status -s; git switch feature; git switch nosuch 2>/dev/null; echo $?; git branch`,
    ],
    [
      "switch refused for a file with local changes and for an untracked file in the way",
      `${COMMITTED}; git switch -c feature 2>/dev/null; echo changed >> a.txt; echo f > f.txt; git add .; git commit -m feature >/dev/null; git switch master 2>/dev/null; echo local >> a.txt; git switch feature 2>/dev/null; echo $?; git checkout -- a.txt; echo mine > f.txt; git switch feature 2>/dev/null; echo $?; git status -s; git branch`,
    ],
    [
      "checkout of a branch, -b, a commit, and paths",
      `${COMMITTED}; git checkout -b feature 2>/dev/null; echo f > f.txt; git add f.txt; git commit -m feature >/dev/null; git checkout master 2>/dev/null; git branch; git checkout -b other feature 2>/dev/null; git log --oneline; echo local >> a.txt; rm sub/y.txt; git checkout -- a.txt sub; git status -s; echo local >> a.txt; git checkout a.txt 2>/dev/null; git status -s; git checkout HEAD~1 2>/dev/null; git status; git branch; git rev-parse --abbrev-ref HEAD; git checkout nosuch 2>/dev/null; echo $?`,
    ],
    // restore
    [
      "restore of the working tree and of the index",
      `${CHANGED}; git restore a.txt; git status -s; git restore sub; git status -s; git add -A; git restore --staged new.txt; git status -s; git restore --staged .; git status -s; git add a.txt 2>/dev/null; echo more >> sub/y.txt; git add -A; echo again >> sub/y.txt; git restore --staged --worktree sub/y.txt; git status -s; git restore nosuch 2>/dev/null; echo $?; git restore 2>/dev/null; echo $?`,
    ],
    // reset
    [
      "reset --soft, --mixed, and --hard",
      `${CHANGED}; git add -A; git commit -m second >/dev/null; echo more >> a.txt; git reset --soft HEAD~1; git status -s; git log --oneline; git reset --mixed; git status -s; git reset --hard; git status -s; git reset --hard HEAD; ls sub sub/deep`,
    ],
    [
      "reset to an earlier commit and reset of paths",
      `${CHANGED}; git add -A; git commit -m second >/dev/null; echo three >> new.txt; git commit -am third >/dev/null; git reset HEAD~1; git log --oneline; git status -s; git add -A; git reset new.txt; git status -s; git reset -- a.txt; git reset HEAD~1 -- a.txt; git status -s; git reset --hard HEAD~1; git log --oneline; git status -s; git reset nosuch 2>/dev/null; echo $?`,
    ],
    // rm and mv
    [
      "rm of a file, of a directory, and --cached",
      `${COMMITTED}; git rm sub/y.txt; git status -s; ls sub; git rm sub 2>/dev/null; echo $?; git rm -r sub; git status -s; ls; git rm --cached a.txt; git status -s; git rm nosuch 2>/dev/null; echo $?; git commit -m removed`,
    ],
    [
      "rm refused for changed files, and -f",
      `${COMMITTED}; echo local >> a.txt; git rm a.txt 2>/dev/null; echo $?; echo n > n.txt; git add n.txt; git rm n.txt 2>/dev/null; echo $?; git rm --cached n.txt; echo staged >> sub/y.txt; git add sub/y.txt; echo local >> sub/y.txt; git rm --cached sub/y.txt 2>/dev/null; echo $?; git rm -f a.txt sub/y.txt; git status -s; (cd sub; git rm deep/x.txt; git status -s)`,
    ],
    [
      "mv of a file, into a directory, and of a directory",
      `${COMMITTED}; git mv a.txt b.txt; git status -s; mkdir dir; git mv b.txt dir; git status -s; git mv sub moved; git status -s; ls moved moved/deep; git mv nosuch x 2>/dev/null; echo $?; git mv dir/b.txt moved/y.txt 2>/dev/null; echo $?; echo u > untracked.txt; git mv untracked.txt other.txt 2>/dev/null; echo $?; git commit -m moved`,
    ],
    // show
    [
      "show of a commit, with --stat, and of a root commit",
      `${CHANGED}; git add -A; git commit -m second -m 'Body text.' >/dev/null; git show; git show --stat; git show HEAD~1 --stat; git show HEAD~1; git show HEAD~5 2>/dev/null; echo $?`,
    ],
    [
      "show of <commit>:<path> for a file and for a directory",
      `${CHANGED}; git add -A; git commit -m second >/dev/null; git show HEAD:a.txt; git show HEAD~1:a.txt; git show HEAD:sub; git show HEAD:; git show HEAD~1:sub/y.txt HEAD:new.txt; git show HEAD:nosuch 2>/dev/null; echo $?`,
    ],
    // outside a repository
    [
      "status, log, and add outside a repository",
      "git status 2>/dev/null; echo $?; git log 2>/dev/null; echo $?; git add . 2>/dev/null; echo $?",
    ],
  ];

  for (const [name, script] of cases) {
    it(`should match ${name}`, async () => {
      const env = await setupFiles(testDir, FILES);
      await compareOutputs(env, testDir, `${ENVIRONMENT}\n${script}`);
    });
  }
});
