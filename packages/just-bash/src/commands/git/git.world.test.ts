import { afterEach, describe, expect, it } from "vitest";
import type {
  CommandInvocation,
  WorldBackend,
  WorldChange,
  WorldExecution,
  WorldRead,
} from "../../world/interface.js";
import { createWorldBackend } from "../../world/virtual-world.js";

const tool: WorldExecution = { driver: "tool", invocation: { callId: "c1" } };

const IDENTITY =
  "export GIT_AUTHOR_NAME=A GIT_AUTHOR_EMAIL=a@example.com GIT_COMMITTER_NAME=C GIT_COMMITTER_EMAIL=c@example.com";

const opened: WorldBackend[] = [];
afterEach(async () => {
  for (const backend of opened.splice(0)) await backend.close();
});

async function world(files: Record<string, string>) {
  const backend = await createWorldBackend({
    hostCwd: "/work",
    options: { files },
  });
  opened.push(backend);
  const changes: WorldChange[] = [];
  const reads: WorldRead[] = [];
  const invoked: CommandInvocation[] = [];
  await backend.bind(
    {
      changed: (change) => changes.push(change),
      read: (read) => reads.push(read),
      invoked: (command) => invoked.push(command),
    },
    undefined,
  );
  const run = async (command: string) => {
    const chunks: Buffer[] = [];
    const { exit } = await backend.exec(command, {
      execution: tool,
      signal: new AbortController().signal,
      onOutput: (chunk) => chunks.push(chunk),
    });
    return { exit, output: Buffer.concat(chunks).toString() };
  };
  return { backend, changes, reads, invoked, run };
}

describe("git in the virtual world", () => {
  it("reports the files git reads and changes for the git command invocation", async () => {
    const { changes, reads, invoked, run } = await world({ f: "content\n" });
    const { exit, output } = await run(
      `${IDENTITY}; git init && git add f && git commit -m x`,
    );
    expect(exit).toEqual({ code: 0 });
    expect(output).toContain("Initialized empty Git repository in /work/.git/");
    expect(output).toMatch(/\[master \(root-commit\) [0-9a-f]{7}\] x\n/);

    const gits = invoked.filter((command) => command.name === "git");
    expect(gits.map((command) => command.args)).toEqual([
      ["init"],
      ["add", "f"],
      ["commit", "-m", "x"],
    ]);
    const [init, add, commit] = gits.map(
      (command) => command.execution.commandId,
    );

    // `git add f` reads the content of f.
    expect(
      reads
        .filter((read) => read.path === "/work/f" && read.kind === "content")
        .map((read) => read.execution.commandId),
    ).toContain(add);

    // Every change is below .git, and belongs to the git command that made it.
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change.path.startsWith("/work/.git")).toBe(true);
      expect([init, add, commit]).toContain(change.execution.commandId);
    }
    const changedBy = (commandId: string) =>
      changes
        .filter((change) => change.execution.commandId === commandId)
        .map((change) => change.path);
    expect(changedBy(init)).toContain("/work/.git/HEAD");
    expect(changedBy(add)).toContain("/work/.git/index");
    expect(changedBy(add).some((path) => path.includes("/objects/"))).toBe(
      true,
    );
    expect(changedBy(commit)).toContain("/work/.git/refs/heads/master");
  });

  it("fails every subcommand for a config file setting it does not honour, and runs again without it", async () => {
    const { backend, run } = await world({ f: "content\n" });
    await run(`${IDENTITY}; git init -q && git add f && git commit -qm x`);
    await run("printf '[diff]\\n\\talgorithm = histogram\\n' >> .git/config");
    const version = await backend.versions?.current();
    for (const command of ["git status", "git diff", "git log", "git add f"]) {
      const { exit, output } = await run(command);
      expect(exit).toEqual({ code: 129 });
      expect(output).toBe(
        "git: the config setting 'diff.algorithm=histogram' is not supported in this environment\n",
      );
    }
    expect(await backend.versions?.current()).toBe(version);
    await run(
      "printf '[core]\\n\\tbare = false\\n[diff]\\n\\talgorithm = myers\\n[alias]\\n\\tst = status\\n' > .git/config",
    );
    expect((await run("git status --short")).exit).toEqual({ code: 0 });
  });

  it.each([
    ["git push", "git push"],
    ["git rebase", "git rebase"],
    ["git log --graph", "'--graph'"],
    ["git status --ignored", "'--ignored'"],
    ["git commit --no-verify -m x", "'--no-verify'"],
    ["git stash -u", "'-u'"],
    ["git diff --word-diff", "'--word-diff'"],
    ["git add -p", "'-p'"],
    ["git -c diff.algorithm=histogram diff", "'diff.algorithm=histogram'"],
    ["git -c color.ui=always status", "'color.ui=always'"],
    ["git -c core.autocrlf=true add f", "'core.autocrlf=true'"],
    ["git commit -qxm message", "'-qxm'"],
  ])("fails %s with exit code 129 and leaves the world unchanged", async (command, named) => {
    const { backend, changes, run } = await world({ f: "content\n" });
    await run(
      `${IDENTITY}; git init && git add f && git commit -m x; echo more >> f`,
    );
    const version = await backend.versions?.current();
    const reported = changes.length;
    const { exit, output } = await run(command);
    expect(exit).toEqual({ code: 129 });
    expect(output).toContain(named);
    expect(output).toContain("not supported in this environment");
    expect(changes.length).toBe(reported);
    expect(await backend.versions?.current()).toBe(version);
  });
});
