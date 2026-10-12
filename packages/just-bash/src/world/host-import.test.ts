import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  contentVersion,
  type JsonValue,
  type WorldBackend,
  type WorldObserver,
  type WorldVersionEntry,
} from "./interface.js";
import { createWorldBackend } from "./virtual-world.js";

const observer: WorldObserver = {
  changed: () => undefined,
  read: () => undefined,
  invoked: () => undefined,
};

const opened: WorldBackend[] = [];
const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "host-import-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const backend of opened.splice(0)) await backend.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function world(
  options: JsonValue,
  hostCwd = "/work",
): Promise<WorldBackend> {
  const backend = await createWorldBackend({ hostCwd, options });
  opened.push(backend);
  await backend.bind(observer, undefined);
  return backend;
}

async function entriesBelow(
  backend: WorldBackend,
  directory: string,
): Promise<WorldVersionEntry[]> {
  const versions = backend.versions;
  if (versions === undefined) throw new Error("the world has no versions");
  const entries = await versions.entries(await versions.current());
  return (entries ?? []).filter((entry) =>
    entry.path.startsWith(`${directory}/`),
  );
}

async function output(backend: WorldBackend, command: string): Promise<string> {
  const chunks: Buffer[] = [];
  await backend.exec(command, {
    execution: { driver: "tool" },
    signal: new AbortController().signal,
    onOutput: (chunk) => chunks.push(chunk),
  });
  return Buffer.concat(chunks).toString();
}

const SCRIPT = "#!/bin/sh\necho run\n";
const NOTE = Buffer.from([0x6e, 0x6f, 0x74, 0x65, 0xff, 0x00, 0x0a]);

/** A host directory with every kind of entry the import takes, and a node_modules directory. */
function hostDirectory(): string {
  const host = temporaryDirectory();
  mkdirSync(join(host, "src/deep"), { recursive: true });
  writeFileSync(join(host, "src/deep/note.bin"), NOTE);
  chmodSync(join(host, "src/deep/note.bin"), 0o640);
  chmodSync(join(host, "src/deep"), 0o750);
  chmodSync(join(host, "src"), 0o755);
  writeFileSync(join(host, "run.sh"), SCRIPT);
  chmodSync(join(host, "run.sh"), 0o755);
  symlinkSync("src/deep/note.bin", join(host, "link"));
  symlinkSync("missing/target", join(host, "dangling"));
  mkdirSync(join(host, "empty"));
  chmodSync(join(host, "empty"), 0o700);
  mkdirSync(join(host, ".git"));
  chmodSync(join(host, ".git"), 0o755);
  writeFileSync(join(host, ".git/HEAD"), "ref: refs/heads/main\n");
  chmodSync(join(host, ".git/HEAD"), 0o644);
  mkdirSync(join(host, "node_modules/dependency"), { recursive: true });
  writeFileSync(join(host, "node_modules/dependency/index.js"), "x");
  return host;
}

function imported(root: string): WorldVersionEntry[] {
  return [
    { path: `${root}/.git`, kind: "directory", mode: 0o755 },
    {
      path: `${root}/.git/HEAD`,
      kind: "file",
      mode: 0o644,
      version: contentVersion("ref: refs/heads/main\n"),
    },
    {
      path: `${root}/dangling`,
      kind: "symlink",
      mode: 0o777,
      target: "missing/target",
    },
    { path: `${root}/empty`, kind: "directory", mode: 0o700 },
    {
      path: `${root}/link`,
      kind: "symlink",
      mode: 0o777,
      target: "src/deep/note.bin",
    },
    {
      path: `${root}/run.sh`,
      kind: "file",
      mode: 0o755,
      version: contentVersion(SCRIPT),
    },
    { path: `${root}/src`, kind: "directory", mode: 0o755 },
    { path: `${root}/src/deep`, kind: "directory", mode: 0o750 },
    {
      path: `${root}/src/deep/note.bin`,
      kind: "file",
      mode: 0o640,
      version: contentVersion(NOTE),
    },
  ];
}

describe("the import option", () => {
  it("gives a new world the files, directories, and links of the host directory", async () => {
    const host = hostDirectory();
    const backend = await world({
      cwd: "/project",
      import: { from: host, exclude: ["node_modules"] },
    });
    expect(await entriesBelow(backend, "/project")).toEqual(
      imported("/project"),
    );
    expect(await output(backend, "cat run.sh")).toBe(SCRIPT);
    expect(await output(backend, "cat link | od -An -b")).toBe(
      " 156 157 164 145 377 000 012\n",
    );
    const listing = await output(backend, "ls -la");
    expect(listing).toMatch(/ 19 .* run\.sh$/m);
    expect(listing).toMatch(/ 7 .* link$/m);
    expect(listing).toMatch(/^d.* empty$/m);
    expect(listing).toMatch(/^d.* \.git$/m);
    expect(listing).not.toContain("node_modules");
    expect(await output(backend, "ls -l src/deep")).toMatch(
      / 7 .* note\.bin$/m,
    );
    expect(
      await output(backend, "stat -c '%a %n' run.sh empty src/deep/note.bin"),
    ).toBe("755 run.sh\n700 empty\n640 src/deep/note.bin\n");
    expect(await output(backend, "readlink link dangling")).toBe(
      "src/deep/note.bin\nmissing/target\n",
    );
  });

  it("leaves out an excluded path that lies below the first level, and only that path", async () => {
    const host = hostDirectory();
    mkdirSync(join(host, "src/node_modules"));
    writeFileSync(join(host, "src/node_modules/kept"), "kept");
    const backend = await world({
      cwd: "/project",
      import: { from: host, exclude: ["node_modules", "src/deep/"] },
    });
    const paths = (await entriesBelow(backend, "/project")).map(
      (entry) => entry.path,
    );
    expect(paths).toContain("/project/src/node_modules/kept");
    expect(paths).toContain("/project/src");
    expect(paths.filter((path) => path.includes("deep"))).toEqual([]);
    expect(paths.filter((path) => path.includes("dependency"))).toEqual([]);
  });

  it("gives the same world version to two worlds that import the same directory", async () => {
    const host = hostDirectory();
    const options = { cwd: "/project", import: { from: host } };
    const first = await world(options);
    utimesSync(join(host, "run.sh"), new Date(0), new Date(0));
    utimesSync(join(host, "src"), new Date(0), new Date(0));
    const second = await world(options);
    expect(await second.versions?.current()).toBe(
      await first.versions?.current(),
    );
  });

  it("puts the content below the working directory, or below `to`", async () => {
    const host = hostDirectory();
    const exclude = ["node_modules"];
    const defaulted = await world({
      cwd: "/project",
      import: { from: host, exclude },
    });
    expect(await output(defaulted, "cat /project/.git/HEAD")).toBe(
      "ref: refs/heads/main\n",
    );
    const placed = await world({
      cwd: "/project",
      import: { from: host, to: "/srv/repo", exclude },
    });
    expect(await entriesBelow(placed, "/srv/repo")).toEqual(
      imported("/srv/repo"),
    );
    expect(await entriesBelow(placed, "/project")).toEqual([]);
  });

  it("resolves a relative `from` against hostCwd", async () => {
    const host = hostDirectory();
    const backend = await world(
      {
        cwd: "/project",
        import: { from: basename(host), exclude: ["node_modules"] },
      },
      dirname(host),
    );
    expect(await entriesBelow(backend, "/project")).toEqual(
      imported("/project"),
    );
  });

  it("writes `files` after the import", async () => {
    const host = hostDirectory();
    const backend = await world({
      cwd: "/project",
      import: { from: host },
      files: { "run.sh": "replaced\n", "added.txt": "added\n" },
    });
    expect(
      await output(backend, "cat run.sh added.txt src/deep/note.bin | wc -c"),
    ).toBe(`${"replaced\n".length + "added\n".length + NOTE.length}\n`);
    expect(await output(backend, "cat run.sh")).toBe("replaced\n");
  });

  it("rejects a `from` that does not exist or is not a directory", async () => {
    const host = hostDirectory();
    await expect(
      createWorldBackend({
        hostCwd: host,
        options: { import: { from: "absent" } },
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      createWorldBackend({
        hostCwd: host,
        options: { import: { from: "run.sh" } },
      }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("rejects a host directory that holds a FIFO, naming its path", async () => {
    const host = hostDirectory();
    const fifo = join(host, "src/pipe");
    execFileSync("mkfifo", [fifo]);
    await expect(
      createWorldBackend({
        hostCwd: host,
        options: { import: { from: host } },
      }),
    ).rejects.toThrow(fifo);
  });

  it("rejects malformed import options", async () => {
    const create = (value: JsonValue) =>
      createWorldBackend({ hostCwd: "/work", options: { import: value } });
    await expect(create({})).rejects.toThrow("import.from");
    await expect(create({ from: "/x", to: "relative" })).rejects.toThrow(
      "import.to",
    );
    await expect(create({ from: "/x", exclude: "a" })).rejects.toThrow(
      "import.exclude",
    );
    await expect(create({ from: "/x", glob: "*" })).rejects.toThrow(
      "import.glob",
    );
  });

  it("starts a world with `fork` from that world version and ignores `import`", async () => {
    const host = hostDirectory();
    const origin = await world({ cwd: "/project", files: { f: "one\n" } });
    const version = await origin.versions?.current();
    if (version === undefined || origin.fork === undefined) {
      throw new Error("the world cannot fork");
    }
    const binding = await origin.fork(version);
    expect(binding.options).not.toHaveProperty("import");
    const forked = await world({
      ...(binding.options as { [key: string]: JsonValue }),
      import: { from: host },
    });
    expect(await forked.versions?.current()).toBe(version);
    expect(await entriesBelow(forked, "/project")).toEqual([
      {
        path: "/project/f",
        kind: "file",
        mode: 0o644,
        version: contentVersion("one\n"),
      },
    ]);
  });

  it("gives a fork of an importing world options without `import`", async () => {
    const host = hostDirectory();
    const origin = await world({ cwd: "/project", import: { from: host } });
    const version = await origin.versions?.current();
    if (version === undefined || origin.fork === undefined) {
      throw new Error("the world cannot fork");
    }
    const binding = await origin.fork(version);
    expect(binding.options).not.toHaveProperty("import");
    rmSync(host, { recursive: true });
    const forked = await world(binding.options as JsonValue);
    expect(await forked.versions?.current()).toBe(version);
  });
});
