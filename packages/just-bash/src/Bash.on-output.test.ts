import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";
import { ExecutionLimitError } from "./interpreter/errors.js";
import type { ExecResult, StreamedBytes } from "./types.js";

type Chunk = [stream: "stdout" | "stderr", text: string];

/** Runs script with onOutput and returns the chunks, each decoded as latin1 so that one character is one byte. */
async function chunksOf(
  script: string,
  bash = new Bash(),
): Promise<{ chunks: Chunk[]; result: ExecResult }> {
  const chunks: Chunk[] = [];
  const result = await bash.exec(script, {
    onOutput: (stream, bytes) =>
      chunks.push([stream, Buffer.from(bytes).toString("latin1")]),
  });
  return { chunks, result };
}

async function textChunks(script: string, bash?: Bash): Promise<Chunk[]> {
  const { chunks } = await chunksOf(script, bash);
  return chunks.map(([stream, text]) => [
    stream,
    Buffer.from(text, "latin1").toString("utf8"),
  ]);
}

describe("Bash.exec with onOutput", () => {
  it("hands over the bytes a command wrote, without decoding them", async () => {
    expect((await chunksOf("printf '\\xff\\xfe\\n'")).chunks).toEqual([
      ["stdout", "\xff\xfe\n"],
    ]);
    expect((await chunksOf("echo é")).chunks).toEqual([
      ["stdout", "\xc3\xa9\n"],
    ]);
    expect((await chunksOf("echo é >&2")).chunks).toEqual([
      ["stderr", "\xc3\xa9\n"],
    ]);
  });

  it("keeps the bytes of a file that is not UTF-8", async () => {
    const bash = new Bash();
    await bash.fs.writeFile("/tmp/b", new Uint8Array([0xff, 0x00, 0xc3, 0x0a]));
    expect((await chunksOf("cat /tmp/b", bash)).chunks).toEqual([
      ["stdout", "\xff\x00\xc3\n"],
    ]);
  });

  it("returns empty stdout and stderr and the exit code", async () => {
    const { result } = await chunksOf("echo a; echo b >&2; exit 3");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(3);
  });

  it("interleaves the two streams in the order the script wrote them", async () => {
    expect(await textChunks("echo a; echo b >&2; echo c")).toEqual([
      ["stdout", "a\n"],
      ["stderr", "b\n"],
      ["stdout", "c\n"],
    ]);
  });

  it("hands over the output of each command of a loop before the next command starts", async () => {
    const events: string[] = [];
    const bash = new Bash({
      sleep: async (ms) => {
        events.push(`sleep ${ms}`);
      },
    });
    await bash.exec("for i in 1 2 3; do echo $i; sleep 0.2; done", {
      onOutput: (stream, bytes) =>
        events.push(`${stream} ${Buffer.from(bytes).toString()}`),
    });
    expect(events).toEqual([
      "stdout 1\n",
      "sleep 200",
      "stdout 2\n",
      "sleep 200",
      "stdout 3\n",
      "sleep 200",
    ]);
  });

  it("hands over command by command inside functions, eval, groups, subshells, and conditionals", async () => {
    const events: string[] = [];
    const bash = new Bash({
      sleep: async () => {
        events.push("sleep");
      },
    });
    const script = [
      "f() { echo f1; sleep 1; echo f2 >&2; }; f",
      "eval 'echo e1; sleep 1; echo e2'",
      "{ echo g1; sleep 1; echo g2; }",
      "( echo s1; sleep 1; echo s2 )",
      "if echo c1; then sleep 1; echo c2; fi",
      "while read line; do echo $line; sleep 1; done <<< w1",
    ].join("\n");
    await bash.exec(script, {
      onOutput: (_stream, bytes) =>
        events.push(Buffer.from(bytes).toString().trim()),
    });
    expect(events).toEqual([
      "f1",
      "sleep",
      "f2",
      "e1",
      "sleep",
      "e2",
      "g1",
      "sleep",
      "g2",
      "s1",
      "sleep",
      "s2",
      "c1",
      "sleep",
      "c2",
      "w1",
      "sleep",
    ]);
  });

  it("leaves out the output that a pipe, a substitution, or a redirection takes", async () => {
    const bash = new Bash();
    expect(
      await textChunks(
        "x=$(echo hidden); echo shown | cat > f; echo visible",
        bash,
      ),
    ).toEqual([["stdout", "visible\n"]]);
    expect(await bash.readFile("f")).toBe("shown\n");
    expect(
      await textChunks(
        "cat <(echo substituted) > /dev/null; { echo g; echo h >&2; } > /dev/null 2>&1; echo end",
      ),
    ).toEqual([["stdout", "end\n"]]);
  });

  it("hands over the output of a redirected compound command as it leaves the redirection", async () => {
    expect(
      await textChunks("{ echo a; echo b; } 1>&2; f() { echo c; }; f 1>&2"),
    ).toEqual([
      ["stderr", "a\nb\n"],
      ["stderr", "c\n"],
    ]);
  });

  it("hands over the standard error of a pipeline stage when the stage ends", async () => {
    const events: string[] = [];
    const bash = new Bash({
      sleep: async () => {
        events.push("sleep");
      },
    });
    await bash.exec("echo warn >&2 | sleep 1; echo both 2>&1 | cat", {
      onOutput: (stream, bytes) =>
        events.push(`${stream} ${Buffer.from(bytes).toString().trim()}`),
    });
    expect(events).toEqual(["stderr warn", "sleep", "stdout both"]);
  });

  it("hands over the messages of the shell at the step that produced them", async () => {
    expect(
      await textChunks("echo a; nosuchcommand; echo $((1x)); echo b"),
    ).toEqual([
      ["stdout", "a\n"],
      ["stderr", "bash: nosuchcommand: command not found\n"],
      ["stderr", 'bash: 1x: value too great for base (error token is "1x")\n'],
      ["stdout", "b\n"],
    ]);
    expect(await textChunks("set -x; echo t >/dev/null; x=1")).toEqual([
      ["stderr", "+ echo t\n"],
      ["stderr", "+ x=1\n"],
    ]);
    const syntax = await textChunks('echo a; echo "open');
    expect(syntax).toHaveLength(1);
    expect(syntax[0][0]).toBe("stderr");
    expect(syntax[0][1]).toContain("unexpected EOF");
  });

  it("hands over the output written before exit and before a failed expansion", async () => {
    expect(await textChunks("echo a; exit 2; echo b")).toEqual([
      ["stdout", "a\n"],
    ]);
    expect(await textChunks("echo a; echo ${y?unset}; echo b")).toEqual([
      ["stdout", "a\n"],
      ["stderr", "bash: unset\n"],
    ]);
  });

  it("ends a command that exceeds the output limit with the limit error", async () => {
    const bash = new Bash({ executionLimits: { maxOutputSize: 30 } });
    const { chunks, result } = await chunksOf(
      "for i in 1 2 3 4 5; do echo 0123456789; done; echo end",
      bash,
    );
    expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    expect(chunks.slice(0, -1)).toEqual([
      ["stdout", "0123456789\n"],
      ["stdout", "0123456789\n"],
    ]);
    expect(chunks.at(-1)?.[0]).toBe("stderr");
    expect(chunks.at(-1)?.[1]).toContain("total output size exceeded");
  });

  it("keeps what it handed over before an abort and ends with the abort message", async () => {
    const stop = new AbortController();
    const chunks: string[] = [];
    const bash = new Bash({
      sleep: async () => {
        stop.abort();
      },
    });
    const result = await bash.exec("echo a; sleep 1; echo b", {
      signal: stop.signal,
      onOutput: (_stream, bytes) => chunks.push(Buffer.from(bytes).toString()),
    });
    expect(chunks).toEqual(["a\n", "bash: execution aborted\n"]);
    expect(result.exitCode).toBe(124);
  });

  it("returns the output in the result when onOutput is omitted", async () => {
    const result = await new Bash().exec("echo a; echo b >&2; echo é");
    expect(result.stdout).toBe("a\né\n");
    expect(result.stderr).toBe("b\n");
  });
});

describe("the command hook with onOutput", () => {
  async function invocations(
    script: string,
    streaming: boolean,
  ): Promise<Record<string, number[]>> {
    const seen: Record<string, number[]> = {};
    const bash = new Bash({
      commandHook: (command, run) =>
        run((result: ExecResult, streamed: StreamedBytes) => {
          seen[command.name] = [
            result.stdout.length + streamed.stdoutBytes,
            result.stderr.length + streamed.stderrBytes,
          ];
        }),
    });
    await bash.exec(
      script,
      streaming ? { onOutput: () => undefined } : undefined,
    );
    return seen;
  }

  it("counts the bytes a function, eval, and a redirected function wrote, the same as without onOutput", async () => {
    const script =
      "f() { echo out; echo err >&2; }; f; eval 'echo evaluated'; g() { echo quiet; }; g > /dev/null";
    const streamed = await invocations(script, true);
    expect(streamed).toEqual(await invocations(script, false));
    expect(streamed.f).toEqual([4, 4]);
    expect(streamed.eval).toEqual([10, 0]);
    expect(streamed.g).toEqual([6, 0]);
  });
});
