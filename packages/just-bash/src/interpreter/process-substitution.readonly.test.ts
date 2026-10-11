import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";

/**
 * Process substitution on a read-only filesystem.
 *
 * Real bash runs `<(cmd)` and `>(cmd)` fine on a read-only mount: they are
 * pipes, not file writes. Both directions need writes to land somewhere —
 * `<(cmd)` to materialise the body's output, and `>(cmd)` for the *outer*
 * command to write into — so the interpreter routes `/dev/fd` to a private
 * in-memory filesystem while leaving the supplied one read-only.
 */

/**
 * An InMemoryFs whose asynchronous writes all fail with EROFS. The standard
 * layout is still created, because it is written through the sync methods.
 */
class ReadOnlyFs extends InMemoryFs {
  private refuse(operation: string, path: string): never {
    throw new Error(`EROFS: read-only file system, ${operation} '${path}'`);
  }
  async writeFile(path: string): Promise<void> {
    this.refuse("write", path);
  }
  async appendFile(path: string): Promise<void> {
    this.refuse("append", path);
  }
  async mkdir(path: string): Promise<void> {
    this.refuse("mkdir", path);
  }
  async createExclusive(path: string): Promise<void> {
    this.refuse("open", path);
  }
  async rm(path: string): Promise<void> {
    this.refuse("rm", path);
  }
  async cp(_src: string, dest: string): Promise<void> {
    this.refuse("cp", dest);
  }
  async mv(_src: string, dest: string): Promise<void> {
    this.refuse("mv", dest);
  }
  async chmod(path: string): Promise<void> {
    this.refuse("chmod", path);
  }
  async symlink(_target: string, linkPath: string): Promise<void> {
    this.refuse("symlink", linkPath);
  }
  async link(_existingPath: string, newPath: string): Promise<void> {
    this.refuse("link", newPath);
  }
  async utimes(path: string): Promise<void> {
    this.refuse("utimes", path);
  }
}

function readOnlyBash(): Bash {
  const fs = new ReadOnlyFs({ "/home/user/project/README.md": "# Readme\n" });
  return new Bash({ fs, cwd: "/home/user/project" });
}

describe("process substitution - read-only filesystem", () => {
  it("still refuses ordinary writes", async () => {
    const env = readOnlyBash();
    await expect(env.exec("echo nope > out.txt")).rejects.toThrow(
      "EROFS: read-only file system, write '/home/user/project/out.txt'",
    );
  });

  it("reads from <(cmd)", async () => {
    const env = readOnlyBash();
    const result = await env.exec("cat <(echo hi)");
    expect(result.stdout).toBe("hi\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports the comm idiom", async () => {
    const env = readOnlyBash();
    const result = await env.exec(
      "comm -12 <(printf 'a\\nb\\n') <(printf 'b\\nc\\n')",
    );
    expect(result.stdout).toBe("b\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("writes to >(cmd) through a redirection", async () => {
    const env = readOnlyBash();
    const result = await env.exec("echo hi > >(tr a-z A-Z)");
    expect(result.stdout).toBe("HI\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("writes to >(cmd) through a command argument", async () => {
    const env = readOnlyBash();
    const result = await env.exec("printf 'a\\nb\\n' | tee >(grep -c b)");
    expect(result.stdout).toBe("a\nb\n1\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("feeds a while-read loop", async () => {
    const env = readOnlyBash();
    const result = await env.exec(
      "while read -r l; do echo \"got $l\"; done < <(printf '1\\n2\\n')",
    );
    expect(result.stdout).toBe("got 1\ngot 2\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("leaves no backing file behind", async () => {
    const env = readOnlyBash();
    const result = await env.exec("cat <(echo x); ls /dev/fd | wc -l");
    expect(result.stdout).toBe("x\n0\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("keeps the rest of /dev visible", async () => {
    const env = readOnlyBash();
    const result = await env.exec("cat <(echo x); ls /dev");
    expect(result.stdout).toBe("x\nfd\nnull\nstderr\nstdin\nstdout\nzero\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("still reads the underlying filesystem", async () => {
    const env = readOnlyBash();
    const result = await env.exec("cat <(ls README.md)");
    expect(result.stdout).toBe("README.md\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});

/**
 * The `/dev/fd` mount exists to back descriptors, not to hand scripts a
 * writable scratch directory a read-only sandbox is supposed to deny them.
 * Only descriptors that are live right now accept writes.
 */
describe("process substitution - read-only /dev/fd is not scratch space", () => {
  it("refuses a write to an unallocated descriptor", async () => {
    const env = readOnlyBash();
    await expect(
      env.exec("cat <(true); echo data > /dev/fd/99"),
    ).rejects.toThrow("EROFS: read-only file system, write '/dev/fd/99'");
  });

  it("refuses an append to an unallocated descriptor", async () => {
    const env = readOnlyBash();
    await expect(
      env.exec("cat <(true); echo data >> /dev/fd/99"),
    ).rejects.toThrow("EROFS: read-only file system, append '/dev/fd/99'");
  });

  it("refuses a write even with a descriptor still live", async () => {
    const env = readOnlyBash();
    await expect(
      env.exec("cat <(true) <(echo data > /dev/fd/99)"),
    ).rejects.toThrow("EROFS: read-only file system, write '/dev/fd/99'");
  });

  it("refuses creating a directory under /dev/fd", async () => {
    const env = readOnlyBash();
    const result = await env.exec("cat <(true); mkdir /dev/fd/sub");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "mkdir: cannot create directory '/dev/fd/sub': " +
        "EROFS: read-only file system, mkdir '/dev/fd/sub'\n",
    );
    expect(result.exitCode).toBe(1);
  });

  it("behaves the same whether or not a substitution ran first", async () => {
    const before = readOnlyBash();
    await expect(before.exec("echo data > /dev/fd/99")).rejects.toThrow(
      "EROFS: read-only file system, write '/dev/fd/99'",
    );
    const after = readOnlyBash();
    await expect(
      after.exec("cat <(true); echo data > /dev/fd/99"),
    ).rejects.toThrow("EROFS: read-only file system, write '/dev/fd/99'");
  });

  it("leaves a writable filesystem's /dev/fd alone", async () => {
    // No mount is installed when the supplied filesystem accepts writes, so
    // /dev/fd stays an ordinary writable directory, exactly as before.
    const env = new Bash();
    const result = await env.exec(
      "cat <(true); echo data > /dev/fd/99; cat /dev/fd/99",
    );
    expect(result.stdout).toBe("data\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
