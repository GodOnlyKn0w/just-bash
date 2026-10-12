import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommandInvocation,
  contentVersion,
  type WorldBackend,
  type WorldChange,
  type WorldExecution,
  type WorldObserver,
  type WorldRead,
} from "./interface.js";
import { createWorldBackend } from "./virtual-world.js";

type Report =
  | ({ type: "changed" } & WorldChange)
  | ({ type: "read" } & WorldRead)
  | ({ type: "invoked" } & CommandInvocation);

function recorder(): { observer: WorldObserver; reports: Report[] } {
  const reports: Report[] = [];
  return {
    reports,
    observer: {
      changed: (change) => reports.push({ type: "changed", ...change }),
      read: (read) => reports.push({ type: "read", ...read }),
      invoked: (command) => reports.push({ type: "invoked", ...command }),
    },
  };
}

const tool: WorldExecution = { driver: "tool", invocation: { callId: "c1" } };
const human: WorldExecution = { driver: "human" };

const opened: WorldBackend[] = [];

async function world(
  options: Record<string, unknown> = {},
  snapshots?: string,
): Promise<{ backend: WorldBackend; reports: Report[] }> {
  const backend = await createWorldBackend({
    hostCwd: "/work",
    options: options as never,
    ...(snapshots === undefined ? {} : { snapshots }),
  });
  opened.push(backend);
  const { observer, reports } = recorder();
  await backend.bind(observer, undefined);
  return { backend, reports };
}

async function run(
  backend: WorldBackend,
  command: string,
  execution: WorldExecution = tool,
): Promise<{ output: string; exit: unknown }> {
  const chunks: Buffer[] = [];
  const { exit } = await backend.exec(command, {
    execution,
    signal: new AbortController().signal,
    onOutput: (chunk) => chunks.push(chunk),
  });
  return { output: Buffer.concat(chunks).toString(), exit };
}

const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "virtual-world-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const backend of opened.splice(0)) await backend.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("command observation", () => {
  it("reports each pipeline stage with the reads and changes inside it", async () => {
    const { backend, reports } = await world({
      files: { "in.txt": "hello\n" },
    });
    const { output, exit } = await run(backend, "cat in.txt | tee out.txt");
    expect(output).toBe("hello\n");
    expect(exit).toEqual({ code: 0 });

    const invoked = reports.filter((r) => r.type === "invoked");
    expect(invoked.map((r) => [r.name, r.args, r.cwd, r.exitCode])).toEqual([
      ["cat", ["in.txt"], "/work", 0],
      ["tee", ["out.txt"], "/work", 0],
    ]);
    expect(invoked.map((r) => [r.stdoutBytes, r.stderrBytes])).toEqual([
      [6, 0],
      [6, 0],
    ]);
    const [cat, tee] = invoked;
    expect(cat.execution).toEqual({
      ...tool,
      commandId: cat.execution.commandId,
    });

    expect(
      reports.filter((r) => r.type === "read" && r.kind === "content"),
    ).toEqual([
      {
        type: "read",
        execution: cat.execution,
        path: "/work/in.txt",
        kind: "content",
        version: contentVersion("hello\n"),
      },
    ]);
    const changes = reports.filter((r) => r.type === "changed");
    expect(changes).toEqual([
      {
        type: "changed",
        execution: tee.execution,
        path: "/work/out.txt",
        kind: "create",
        after: contentVersion("hello\n"),
        worldVersion: await backend.versions?.current(),
      },
    ]);
  });

  it("attributes a command's redirections to it and nested commands to their parent", async () => {
    const { backend, reports } = await world({ files: { x: "1" } });
    await run(backend, "f() { cat x; }; f > y; { cat x; } > z");
    const invoked = reports.filter((r) => r.type === "invoked");
    expect(invoked.map((r) => r.name)).toEqual(["cat", "f", "cat"]);
    const [cat, f] = invoked;
    expect(cat.parentCommandId).toBe(f.execution.commandId);
    expect(f.parentCommandId).toBeUndefined();
    // f wrote 1 byte to its standard output, which the redirection sent to y.
    expect(f.stdoutBytes).toBe(1);
    const changes = reports.filter((r) => r.type === "changed");
    expect(changes.map((r) => [r.path, r.execution])).toEqual([
      ["/work/y", f.execution],
      ["/work/y", f.execution],
      // A redirection on a compound command is outside every invocation.
      ["/work/z", tool],
      ["/work/z", tool],
    ]);
  });

  it("reports a failed read as a stat and the exit code of the command", async () => {
    const { backend, reports } = await world();
    const { exit } = await run(backend, "cat missing");
    expect(exit).toEqual({ code: 1 });
    // The shell's PATH lookup stats /usr/bin/cat as well.
    expect(
      reports.filter((r) => r.type !== "invoked" && r.path.startsWith("/work")),
    ).toEqual([
      expect.objectContaining({
        type: "read",
        path: "/work/missing",
        kind: "stat",
      }),
    ]);
    expect(reports.at(-1)).toMatchObject({ name: "cat", exitCode: 1 });
  });

  it("reports one move for mv and one removal for a removed directory", async () => {
    const { backend, reports } = await world({
      files: { "d/a": "a", "d/e/b": "b" },
    });
    await run(backend, "mv d/a d/c && chmod 600 d/c && rm -r d/e");
    const changes = reports
      .filter((r) => r.type === "changed")
      .map(({ path, kind, to, before, after }) => ({
        path,
        kind,
        to,
        before,
        after,
      }));
    expect(changes).toEqual([
      {
        path: "/work/d/a",
        kind: "move",
        to: "/work/d/c",
        before: contentVersion("a"),
        after: contentVersion("a"),
      },
      {
        path: "/work/d/c",
        kind: "metadata",
        to: undefined,
        before: contentVersion("a"),
        after: contentVersion("a"),
      },
      {
        path: "/work/d/e",
        kind: "remove",
        to: undefined,
        before: undefined,
        after: undefined,
      },
    ]);
  });

  it("reports reads through links at the final target and reads of a link at the link", async () => {
    const { backend, reports } = await world({ files: { "real/f": "x" } });
    await run(backend, "ln -s real dir; ln -s dir/f link");
    reports.length = 0;
    await run(backend, "cat link; readlink link; cat dir/f");
    const reads = reports
      .filter((r) => r.type === "read" && r.path.startsWith("/work"))
      .map((r) => (r.type === "read" ? [r.kind, r.path] : []));
    expect(reads).toContainEqual(["content", "/work/real/f"]);
    expect(reads).toContainEqual(["stat", "/work/link"]);
    expect(reads.filter(([, path]) => path === "/work/dir/f")).toEqual([]);
    expect(await backend.readEntry("/work/link", tool)).toEqual({
      kind: "file",
      content: Buffer.from("x"),
    });
    expect(reports.at(-1)).toMatchObject({
      path: "/work/real/f",
      kind: "content",
    });
  });

  it("keeps concurrent executions apart", async () => {
    const { backend, reports } = await world({
      files: { left: "l", right: "r" },
    });
    const other: WorldExecution = {
      driver: "tool",
      invocation: { callId: "c2" },
    };
    await Promise.all([
      run(backend, "cat left; cat left; cp left left2"),
      run(backend, "cat right; cat right; cp right right2", other),
    ]);
    const worked = reports.filter((r) =>
      r.type === "invoked" ? true : r.path.startsWith("/work"),
    );
    expect(worked.length).toBe(24);
    for (const report of worked) {
      const { commandId: _, ...execution } = report.execution;
      const path = report.type === "invoked" ? report.args[0] : report.path;
      if (path.includes("left")) expect(execution).toEqual(tool);
      else if (path.includes("right")) expect(execution).toEqual(other);
      else expect(path).toBe("/work");
    }
  });
});

describe("working directory and snapshot location", () => {
  it("takes the world's cwd from the options or hostCwd, and resolves snapshots against hostCwd", async () => {
    const host = temporaryDirectory();
    const backend = await createWorldBackend({
      hostCwd: host,
      options: { cwd: "/project", snapshots: "store" },
    });
    opened.push(backend);
    expect(backend.cwd).toBe("/project");
    await backend.bind(recorder().observer, undefined);
    await backend.versions?.current();
    expect(readdirSync(join(host, "store")).sort()).toEqual([
      "contents",
      "trees",
      "versions",
    ]);
    const defaulted = await createWorldBackend({
      hostCwd: "/host/dir",
      options: undefined,
    });
    opened.push(defaulted);
    expect(defaulted.cwd).toBe("/host/dir");
    await expect(
      createWorldBackend({ hostCwd: host, options: { cwd: "relative" } }),
    ).rejects.toThrow("absolute");
  });
});

describe("harness operations", () => {
  it("reports writes, reads, and removals with content versions", async () => {
    const { backend, reports } = await world();
    await backend.writeFile("/work/new/f", Buffer.from("one"), human);
    await backend.writeFile("/work/new/f", Buffer.from("two"), human);
    await expect(
      backend.writeFile("/work/new/f", Buffer.from("x"), human, {
        exclusive: true,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      backend.writeFile("/work/new", Buffer.from("x"), human),
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect(await backend.readEntry("/work/new/f", tool)).toEqual({
      kind: "file",
      content: Buffer.from("two"),
    });
    expect(await backend.readEntry("/work/none", tool)).toBeUndefined();
    expect(await backend.stat("/work/new", tool)).toEqual({
      kind: "directory",
      size: 0,
    });
    await backend.remove("/work/new", human);
    await expect(backend.remove("/work/new", human)).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(
      reports.map((r) =>
        r.type === "changed"
          ? [r.kind, r.path, r.before, r.after]
          : r.type === "read"
            ? [r.kind, r.path, r.version]
            : [],
      ),
    ).toEqual([
      ["create", "/work/new", undefined, undefined],
      ["create", "/work/new/f", undefined, contentVersion("one")],
      ["modify", "/work/new/f", contentVersion("one"), contentVersion("two")],
      ["content", "/work/new/f", contentVersion("two")],
      ["stat", "/work/none", undefined],
      ["stat", "/work/new", undefined],
      ["remove", "/work/new", undefined, undefined],
    ]);
  });

  it("reports an output file's creation, its whole content on close, and its discard", async () => {
    const { backend, reports } = await world();
    const runtime: WorldExecution = { driver: "runtime" };
    const path = backend.outputPath("bash-1.log");
    const output = backend.createOutput(path, runtime);
    expect(() => backend.createOutput(path, runtime)).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    output.write(Buffer.from("par"));
    expect((await run(backend, `cat ${path}`)).output).toBe("par");
    output.write(Buffer.from("tial"));
    output.close();
    const discarded = backend.createOutput(backend.outputPath("x"), runtime);
    discarded.discard();
    const changes = reports
      .filter((r) => r.type === "changed")
      .map((r) => [r.kind, r.path, r.before, r.after]);
    expect(changes).toEqual([
      ["create", "/harness", undefined, undefined],
      ["create", path, undefined, contentVersion("")],
      ["modify", path, contentVersion(""), contentVersion("partial")],
      ["create", "/harness/x", undefined, contentVersion("")],
      ["remove", "/harness/x", contentVersion(""), undefined],
    ]);
  });
});

describe("versions", () => {
  it("restores the version a host gives at bind from the snapshot store", async () => {
    const snapshots = temporaryDirectory();
    const first = await world({}, snapshots);
    await run(first.backend, "echo one > f; mkdir -p d; ln -s ../f d/l");
    const changes = first.reports.filter((r) => r.type === "changed");
    const restore = changes.at(-1)?.worldVersion as string;
    await first.backend.writeFile("/work/unrecorded", Buffer.from("x"), human);

    const second = await createWorldBackend({
      hostCwd: "/work",
      options: undefined,
      snapshots,
    });
    opened.push(second);
    await second.bind(recorder().observer, restore);
    expect(await second.versions?.current()).toBe(restore);
    expect((await run(second, "cat d/l; ls")).output).toBe("one\nd\nf\n");
    const entries = await second.versions?.entries(restore);
    expect(entries).toContainEqual({
      path: "/work/f",
      kind: "file",
      mode: 0o644,
      version: contentVersion("one\n"),
    });
    expect(
      (await second.versions?.content(contentVersion("one\n")))?.toString(),
    ).toBe("one\n");
    await expect(
      second.bind(recorder().observer, "0123456789ab"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives every change the world version saved before it is reported", async () => {
    const snapshots = temporaryDirectory();
    const { backend, reports } = await world({}, snapshots);
    await run(backend, "echo a > a; echo b > b; rm a");
    for (const change of reports.filter((r) => r.type === "changed")) {
      expect(
        await backend.versions?.entries(change.worldVersion as string),
      ).toBeDefined();
    }
  });

  it("forks a world that another host can bind", async () => {
    const { backend } = await world({ files: { f: "base" } });
    const version = (await backend.versions?.current()) as string;
    await run(backend, "echo changed > f");
    const binding = await backend.fork?.(version);
    expect(binding?.options).toMatchObject({ cwd: "/work", fork: version });

    const forked = await createWorldBackend({
      hostCwd: "/elsewhere",
      options: binding?.options,
    });
    opened.push(forked);
    await forked.bind(recorder().observer, undefined);
    expect(forked.cwd).toBe("/work");
    expect(forked.versions?.forkedFrom).toBe(version);
    expect((await run(forked, "cat f")).output).toBe("base");
    expect((await run(backend, "cat f")).output).toBe("changed\n");
    await expect(backend.fork?.("0123456789ab")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      createWorldBackend({
        hostCwd: "/",
        options: { ...(binding?.options as object), fork: "0123456789ab" },
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("shell worker", () => {
  it("terminates a run that ignores an abort and keeps the world for the next run", async () => {
    const { backend } = await world();
    await run(backend, "echo kept > f");
    const stop = new AbortController();
    let ticks = 0;
    const tick = setInterval(() => ticks++, 50);
    setTimeout(() => stop.abort(), 200);
    const { exit } = await backend.exec("while true; do :; done", {
      execution: tool,
      signal: stop.signal,
      onOutput: () => undefined,
    });
    clearInterval(tick);
    expect(exit).toEqual({ signal: "SIGKILL" });
    // The host's timers kept firing while the loop ran.
    expect(ticks).toBeGreaterThan(20);
    expect((await run(backend, "cat f")).output).toBe("kept\n");
    await backend.close();
  }, 20000);

  it("ends a cooperative command on abort and kills a job", async () => {
    const { backend, reports } = await world();
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const { exit } = await backend.exec("sleep 100", {
      execution: tool,
      signal: stop.signal,
      onOutput: () => undefined,
    });
    expect(exit).toEqual({ signal: "SIGTERM" });

    const chunks: Buffer[] = [];
    const job = await backend.startJob("echo started > log; sleep 100", {
      execution: { ...tool, jobId: "job-a" },
      onOutput: (chunk) => chunks.push(chunk),
    });
    await expect
      .poll(() => reports.some((r) => r.type === "changed"))
      .toBe(true);
    await job.kill();
    expect(await job.ended).toEqual({
      exit: { signal: "SIGTERM" },
      residualKilled: false,
    });
    const { commandId, ...execution } =
      reports.find((r) => r.type === "changed")?.execution ?? {};
    expect(execution).toEqual({ ...tool, jobId: "job-a" });
    expect(commandId).toBeDefined();
    await backend.close();
  }, 20000);
});
