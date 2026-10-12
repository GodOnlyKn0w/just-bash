import { describe, expect, it } from "vitest";
import type {
  WorldChange,
  WorldExecution,
  WorldRead,
} from "../../world/interface.js";
import { createWorldBackend } from "../../world/virtual-world.js";

describe("python3 in a virtual world", () => {
  it("attributes the files python reads and writes to its command invocation", async () => {
    const backend = await createWorldBackend({
      hostCwd: "/work",
      options: { python: true, files: { "in.txt": "data" } },
    });
    const changes: WorldChange[] = [];
    const reads: WorldRead[] = [];
    const commands = new Map<string, string>();
    await backend.bind(
      {
        changed: (change) => changes.push(change),
        read: (read) => reads.push(read),
        invoked: (command) =>
          commands.set(command.execution.commandId, command.name),
      },
      undefined,
    );
    const execution: WorldExecution = { driver: "tool" };
    const chunks: Buffer[] = [];
    const { exit } = await backend.exec(
      `python3 -c "open('out.txt','w').write(open('in.txt').read().upper())"; cat out.txt`,
      {
        execution,
        signal: new AbortController().signal,
        onOutput: (chunk) => chunks.push(chunk),
      },
    );
    await backend.close();
    expect(exit).toEqual({ code: 0 });
    expect(Buffer.concat(chunks).toString()).toBe("DATA");
    const by = (report: WorldChange | WorldRead) =>
      commands.get(report.execution.commandId ?? "");
    const python = reads.find(
      (read) => read.path === "/work/in.txt" && read.kind === "content",
    );
    expect(python && by(python)).toBe("python3");
    const written = changes.filter((change) => change.path === "/work/out.txt");
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((change) => by(change) === "python3")).toBe(true);
  }, 60000);
});
