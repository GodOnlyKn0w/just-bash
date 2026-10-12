import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentVersion } from "./interface.js";
import { directoryStore, memoryStore } from "./snapshot-store.js";
import { versionEntries, WorldState } from "./world-state.js";

const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "world-state-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WorldState versions", () => {
  it("gives the same version to the same state reached in different orders", async () => {
    const first = new WorldState(memoryStore());
    await first.fs.mkdir("/a/b", { recursive: true });
    await first.fs.writeFile("/a/b/x", "1");
    await first.fs.writeFile("/a/y", "2");

    const second = new WorldState(memoryStore());
    await second.fs.writeFile("/a/y", "old");
    await second.fs.writeFile("/a/b/x", "1");
    await second.fs.writeFile("/a/y", "2");
    await second.fs.writeFile("/a/z", "removed");
    await second.fs.rm("/a/z");

    expect(second.save()).toBe(first.save());
  });

  it("changes with content, mode, and links and returns to an earlier version", async () => {
    const state = new WorldState(memoryStore());
    await state.fs.writeFile("/f", "one");
    const one = state.save();
    await state.fs.writeFile("/f", "two");
    const two = state.save();
    await state.fs.chmod("/f", 0o755);
    const executable = state.save();
    await state.fs.chmod("/f", 0o644);
    await state.fs.symlink("/f", "/l");
    const linked = state.save();
    expect(new Set([one, two, executable, linked]).size).toBe(4);
    await state.fs.rm("/l");
    await state.fs.writeFile("/f", "one");
    expect(state.save()).toBe(one);
  });

  it("does not depend on modification times", async () => {
    const state = new WorldState(memoryStore());
    await state.fs.writeFile("/f", "x");
    const before = state.save();
    await state.fs.utimes("/f", new Date(0), new Date(0));
    expect(state.save()).toBe(before);
  });

  it("includes the permission bits of the root", async () => {
    const store = memoryStore();
    const state = new WorldState(store);
    const before = state.save();
    await state.fs.chmod("/", 0o700);
    const after = state.save();
    expect(after).not.toBe(before);
    expect(versionEntries(store, after)?.[0]).toEqual({
      path: "/",
      kind: "directory",
      mode: 0o700,
    });
    const loaded = await WorldState.load(store, after);
    expect(loaded.save()).toBe(after);
  });
});

describe("WorldState load", () => {
  it("restores files, directories, links, and modes of a saved version", async () => {
    const store = memoryStore();
    const state = new WorldState(store);
    await state.fs.mkdir("/d/e", { recursive: true });
    await state.fs.chmod("/d", 0o700);
    await state.fs.writeFile("/d/e/f", new Uint8Array([0, 255, 1]));
    await state.fs.chmod("/d/e/f", 0o600);
    await state.fs.symlink("e/f", "/d/link");
    const version = state.save();
    await state.fs.rm("/d", { recursive: true });

    const loaded = await WorldState.load(store, version);
    expect(loaded.save()).toBe(version);
    expect(await loaded.fs.readFileBuffer("/d/link")).toEqual(
      new Uint8Array([0, 255, 1]),
    );
    expect((await loaded.fs.stat("/d")).mode & 0o777).toBe(0o700);
    expect((await loaded.fs.stat("/d/e/f")).mode & 0o777).toBe(0o600);
    expect(await loaded.fs.readlink("/d/link")).toBe("e/f");
  });

  it("rejects a version the store does not hold with ENOENT", async () => {
    await expect(
      WorldState.load(memoryStore(), "000000000000"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let callers change stored content", async () => {
    const store = memoryStore();
    const state = new WorldState(store);
    await state.fs.writeFile("/f", "abc");
    const version = state.save();
    (await state.fs.readFileBuffer("/f"))[0] = 0x7a;
    const loaded = await WorldState.load(store, version);
    expect(await loaded.fs.readFile("/f")).toBe("abc");
  });
});

describe("directory snapshot store", () => {
  it("serves versions, entries, and contents to a store opened later", async () => {
    const directory = temporaryDirectory();
    const state = new WorldState(directoryStore(directory));
    await state.fs.mkdir("/src");
    await state.fs.writeFile("/src/main.ts", "export {};\n");
    await state.fs.symlink("/src/main.ts", "/main");
    const version = state.save();

    const reopened = directoryStore(directory);
    expect(versionEntries(reopened, version)).toEqual([
      { path: "/", kind: "directory", mode: 0o755 },
      { path: "/main", kind: "symlink", mode: 0o777, target: "/src/main.ts" },
      { path: "/src", kind: "directory", mode: 0o755 },
      {
        path: "/src/main.ts",
        kind: "file",
        mode: 0o644,
        version: contentVersion("export {};\n"),
      },
    ]);
    const content = reopened.get("content", contentVersion("export {};\n"));
    expect(Buffer.from(content ?? []).toString()).toBe("export {};\n");
    const loaded = await WorldState.load(reopened, version);
    expect(await loaded.fs.readFile("/main")).toBe("export {};\n");
  });

  it("writes each object once and leaves saved versions untouched", async () => {
    const directory = temporaryDirectory();
    const state = new WorldState(directoryStore(directory));
    await state.fs.writeFile("/f", "x");
    const version = state.save();
    const saved = statSync(join(directory, "versions", version)).mtimeMs;
    await state.fs.writeFile("/g", "x");
    state.save();
    await state.fs.rm("/g");
    expect(state.save()).toBe(version);
    expect(statSync(join(directory, "versions", version)).mtimeMs).toBe(saved);
    expect(readdirSync(join(directory, "contents"))).toEqual([
      contentVersion("x"),
    ]);
    expect(
      readdirSync(directory, { recursive: true }).filter((name) =>
        String(name).endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  it("does not hold versions it never saved", () => {
    const store = directoryStore(temporaryDirectory());
    expect(versionEntries(store, "../escape")).toBeUndefined();
    expect(store.get("content", "../../etc/passwd")).toBeUndefined();
  });
});
