import { describe, expect, it } from "vitest";
import {
  createExclusiveOn,
  ExclusiveCreateUnsupportedError,
} from "./create-exclusive.js";
import { InMemoryFs } from "./in-memory-fs/in-memory-fs.js";
import type { IFileSystem } from "./interface.js";
import { MountableFs } from "./mountable-fs/mountable-fs.js";

describe("createExclusiveOn", () => {
  it("uses the filesystem's own exclusive create when available", async () => {
    const fs = new InMemoryFs();
    await createExclusiveOn(fs, "/file.txt", { mode: 0o600 });
    expect((await fs.stat("/file.txt")).mode & 0o777).toBe(0o600);
  });

  it("fails loudly when the filesystem cannot create atomically", async () => {
    // No fallback: a caller that asked for an exclusive private entry must
    // not silently receive a racy one.
    const backing = new InMemoryFs();
    const legacy = Object.create(backing) as IFileSystem;
    legacy.createExclusive = undefined;

    await expect(
      createExclusiveOn(legacy, "/legacy.txt", { mode: 0o600 }),
    ).rejects.toThrow(ExclusiveCreateUnsupportedError);
    expect(await backing.exists("/legacy.txt")).toBe(false);
  });

  it("reports the same for a mount routed to such a filesystem", async () => {
    const backing = new InMemoryFs();
    const legacy = Object.create(backing) as IFileSystem;
    legacy.createExclusive = undefined;
    const mounted = new MountableFs({ base: legacy, mounts: [] });

    await expect(
      createExclusiveOn(mounted, "/mounted.txt", { mode: 0o600 }),
    ).rejects.toThrow(ExclusiveCreateUnsupportedError);
  });

  it("creates through a directory that exists only as a mount parent", async () => {
    // stat('/mnt') reports a directory because /mnt/data is mounted, and
    // writeFile creates through it, so an exclusive create must too.
    const mounted = new MountableFs({
      base: new InMemoryFs(),
      mounts: [{ mountPoint: "/mnt/data", filesystem: new InMemoryFs() }],
    });
    expect((await mounted.stat("/mnt")).isDirectory).toBe(true);

    await createExclusiveOn(mounted, "/mnt/file.txt", { mode: 0o600 });

    expect(await mounted.exists("/mnt/file.txt")).toBe(true);
    expect((await mounted.stat("/mnt/file.txt")).mode & 0o777).toBe(0o600);
  });
});
