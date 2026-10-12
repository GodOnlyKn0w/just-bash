import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("printf with \\x escapes that are not UTF-8", () => {
  it("writes the bytes themselves to a pipe and to a file", async () => {
    const bash = new Bash();
    const result = await bash.exec(
      "printf '\\xff\\xfe\\n' | od -An -b; printf 'é\\xff%s' ü > f; od -An -b f; printf '%b' '\\xfe' | od -An -b",
    );
    expect(result.stdout).toBe(" 377 376 012\n 303 251 377 303 274\n 376\n");
  });

  it("keeps a valid sequence of \\x escapes as text", async () => {
    const result = await new Bash().exec("printf '\\xc3\\xa9\\n'");
    expect(result.stdout).toBe("é\n");
  });

  it("returns one character for each byte of an output that is not UTF-8", async () => {
    const result = await new Bash().exec("printf '\\xff\\xfe\\n'");
    expect(result.stdout).toBe("\xff\xfe\n");
  });

  it("stores the character of the same code with -v", async () => {
    const result = await new Bash().exec(
      "printf -v v '\\xff'; printf '%s' \"$v\" | od -An -b",
    );
    expect(result.stdout).toBe(" 303 277\n");
  });

  it("leaves a character outside the Basic Multilingual Plane as text", async () => {
    const result = await new Bash().exec("printf '<%s>\\n' '💥' 'a💥'");
    expect(result.stdout).toBe("<💥>\n<a💥>\n");
  });
});
