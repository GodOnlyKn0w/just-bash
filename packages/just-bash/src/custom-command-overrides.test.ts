import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";
import { defineCommand } from "./custom-commands.js";

describe("custom command overrides", () => {
  it("provides the shadowed bundled command through the context", async () => {
    const cat = defineCommand("cat", async (args, ctx) => {
      if (!ctx.origCommand) throw new Error("missing original command");
      return ctx.origCommand(args);
    });
    const bash = new Bash({
      files: { "/message.txt": "hello\n" },
      customCommands: [cat],
    });

    expect(await bash.exec("cat /message.txt")).toMatchObject({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("preserves output accounting when delegating to find", async () => {
    const find = defineCommand("find", async (args, ctx) => {
      if (!ctx.origCommand) throw new Error("missing original command");
      return ctx.origCommand(args);
    });
    const bash = new Bash({
      files: {
        "/root/message.txt": "hello\n",
        "/root/nested/another.txt": "world\n",
      },
      customCommands: [find],
    });

    expect(await bash.exec("find /root -type f")).toMatchObject({
      stdout: "/root/message.txt\n/root/nested/another.txt\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("preserves output accounting when delegating to xargs", async () => {
    const xargs = defineCommand("xargs", async (args, ctx) => {
      if (!ctx.origCommand) throw new Error("missing original command");
      return ctx.origCommand(args);
    });
    const bash = new Bash({ customCommands: [xargs] });

    expect(await bash.exec("printf 'one\\ntwo\\n' | xargs echo")).toMatchObject(
      {
        stdout: "one two\n",
        stderr: "",
        exitCode: 0,
      },
    );
  });

  it("omits the original command for a new command name", async () => {
    const custom = defineCommand("custom", async (_args, ctx) => ({
      stdout: String(ctx.origCommand),
      stderr: "",
      exitCode: 0,
    }));

    expect(
      await new Bash({ customCommands: [custom] }).exec("custom"),
    ).toMatchObject({
      stdout: "undefined",
      stderr: "",
      exitCode: 0,
    });
  });
});
