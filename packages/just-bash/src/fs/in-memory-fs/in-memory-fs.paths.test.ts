import { describe, expect, it } from "vitest";
import { InMemoryFs } from "./in-memory-fs.js";

describe("InMemoryFs path failures", () => {
  it("carries the errno name as code", async () => {
    const fs = new InMemoryFs({ "/dir/file": "x" });
    await expect(fs.readFile("/missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile("/dir")).rejects.toMatchObject({
      code: "EISDIR",
    });
    await expect(fs.mkdir("/dir")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fs.rm("/dir")).rejects.toMatchObject({ code: "ENOTEMPTY" });
  });

  it("refuses to create entries under a file", async () => {
    const fs = new InMemoryFs({ "/file": "x" });
    await expect(fs.writeFile("/file/child", "y")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    await expect(fs.mkdir("/file/sub")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    await expect(
      fs.mkdir("/file/sub/deeper", { recursive: true }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(fs.symlink("/x", "/file/link")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    expect(fs.getAllPaths().filter((p) => p.startsWith("/file/"))).toEqual([]);
  });
});

describe("InMemoryFs writes through symlinks", () => {
  it("writes through a symlinked directory land in the target", async () => {
    const fs = new InMemoryFs({ "/real/a": "A" });
    await fs.symlink("/real", "/link");
    await fs.writeFile("/link/b", "B");
    await fs.mkdir("/link/sub");
    await fs.cp("/real/a", "/link/c");
    await fs.mv("/link/c", "/link/d");
    expect((await fs.readdir("/real")).sort()).toEqual(["a", "b", "d", "sub"]);
    await fs.rm("/link/d");
    expect((await fs.readdir("/real")).sort()).toEqual(["a", "b", "sub"]);
    expect(fs.getAllPaths().filter((p) => p.startsWith("/link/"))).toEqual([]);
  });

  it("writes to a symlinked file change the target and keep the link", async () => {
    const fs = new InMemoryFs({ "/target": "old" });
    await fs.symlink("/target", "/link");
    await fs.writeFile("/link", "new");
    await fs.appendFile("/link", "er");
    expect(await fs.readFile("/target")).toBe("newer");
    expect(await fs.readlink("/link")).toBe("/target");
  });
});

describe("InMemoryFs links whose targets pass through links", () => {
  it("reads, lists, and stats through a chain of links", async () => {
    const fs = new InMemoryFs({ "/work/real/sub/f": "x" });
    await fs.symlink("real", "/work/dir");
    await fs.symlink("dir/sub/f", "/work/link");
    await fs.symlink("dir/sub", "/work/sublink");
    expect(await fs.readFile("/work/link")).toBe("x");
    expect(await fs.readdir("/work/sublink")).toEqual(["f"]);
    expect(await fs.readdir("/work/dir/sub")).toEqual(["f"]);
    expect((await fs.stat("/work/link")).isFile).toBe(true);
    expect(await fs.realpath("/work/link")).toBe("/work/real/sub/f");
    expect((await fs.lstat("/work/link")).isSymbolicLink).toBe(true);
  });

  it("fails with ELOOP on a cycle of links", async () => {
    const fs = new InMemoryFs();
    await fs.symlink("/b", "/a");
    await fs.symlink("/a", "/b");
    await expect(fs.readFile("/a")).rejects.toMatchObject({ code: "ELOOP" });
    await expect(fs.readdir("/a")).rejects.toMatchObject({ code: "ELOOP" });
  });
});
