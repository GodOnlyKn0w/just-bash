import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_BYTES } from "../../encoding.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import { resolveLimits } from "../../limits.js";
import type { RuntimeCommandContext } from "../../types.js";
import { _internals, sqlite3Command } from "./sqlite3.js";

type WorkerScript = (worker: {
  emit: (event: string, payload?: unknown) => void;
  emitAuthenticated: (event: string, payload: Record<string, unknown>) => void;
}) => void;

function createMockWorker(
  script: WorkerScript,
  protocolToken: string,
  options: { rejectTermination?: boolean } = {},
) {
  const handlers = new Map<string, Array<(payload?: unknown) => void>>();

  const worker = {
    on(event: string, cb: (payload?: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
      return worker;
    },
    terminate(): Promise<number> {
      if (options.rejectTermination) {
        return Promise.reject(new Error("termination rejected"));
      }
      const list = handlers.get("exit") ?? [];
      for (const cb of list) cb(0);
      return Promise.resolve(0);
    },
  };

  queueMicrotask(() => {
    script({
      emit: (event: string, payload?: unknown) => {
        const list = handlers.get(event) ?? [];
        for (const cb of list) cb(payload);
      },
      emitAuthenticated: (event: string, payload: Record<string, unknown>) => {
        const message = Object.create(null) as Record<string, unknown>;
        for (const [key, value] of Object.entries(payload)) {
          message[key] = value;
        }
        message.protocolToken = protocolToken;
        const list = handlers.get(event) ?? [];
        for (const cb of list) cb(message);
      },
    });
  });

  return worker;
}

function createContext(
  overrides: Partial<RuntimeCommandContext> = {},
): RuntimeCommandContext {
  return {
    fs: new InMemoryFs(),
    cwd: "/",
    env: new Map([
      ["HOME", "/home/user"],
      ["PATH", "/usr/bin:/bin"],
      ["IFS", " \t\n"],
    ]),
    stdin: EMPTY_BYTES,
    ...overrides,
    limits: overrides.limits ?? resolveLimits(),
  };
}

describe("sqlite3 worker protocol abuse", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces malformed success payloads as explicit command errors", async () => {
    vi.spyOn(_internals, "createWorker").mockImplementation((_path, input) => {
      return createMockWorker((worker) => {
        worker.emitAuthenticated("message", { success: true });
      }, input.protocolToken) as never;
    });

    const result = await sqlite3Command.execute(
      [":memory:", "SELECT 1"],
      createContext(),
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "sqlite3: Malformed worker response: missing results array\n",
    );
    expect(result.exitCode).toBe(1);
  });

  it("sanitizes worker errors before forwarding to stderr", async () => {
    vi.spyOn(_internals, "createWorker").mockImplementation((_path, input) => {
      return createMockWorker((worker) => {
        worker.emitAuthenticated("message", {
          success: false,
          error:
            "sqlite crash near /Users/attacker/private.db at node:internal/modules/run_main:99",
        });
      }, input.protocolToken) as never;
    });

    const result = await sqlite3Command.execute(
      [":memory:", "SELECT 1"],
      createContext(),
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "sqlite3: sqlite crash near <path> at <internal>:99\n",
    );
    expect(result.exitCode).toBe(1);
  });

  it("sanitizes worker-bootstrap exception strings before forwarding to stderr", async () => {
    vi.spyOn(_internals, "createWorker").mockImplementation(() => {
      throw new Error(
        "bootstrap fault at /Users/attacker/.cache/sqlite/worker.js via node:internal/modules/cjs/loader:1234",
      );
    });

    const result = await sqlite3Command.execute(
      [":memory:", "SELECT 1"],
      createContext(),
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "sqlite3: worker error: sqlite3 worker failed to load: bootstrap fault at <path> via <internal>:1234\n",
    );
    expect(result.exitCode).toBe(1);
  });

  it("rejects forged worker messages with invalid protocol token", async () => {
    vi.spyOn(_internals, "createWorker").mockImplementation((_path, input) => {
      return createMockWorker((worker) => {
        worker.emit("message", {
          protocolToken: `${input.protocolToken}-forged`,
          success: true,
          results: [],
          hasModifications: false,
          dbBuffer: null,
        });
      }, input.protocolToken) as never;
    });

    const result = await sqlite3Command.execute(
      [":memory:", "SELECT 1"],
      createContext(),
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "sqlite3: Malformed worker response: invalid protocol token\n",
    );
    expect(result.exitCode).toBe(1);
  });

  it("poisons the database lock when termination is not acknowledged", async () => {
    const fs = new InMemoryFs({ "/database.db": "empty" });
    const createWorker = vi
      .spyOn(_internals, "createWorker")
      .mockImplementation((_path, input) => {
        return createMockWorker(
          (worker) => {
            worker.emitAuthenticated("message", {
              success: true,
              results: [],
              hasModifications: false,
              dbBuffer: null,
            });
          },
          input.protocolToken,
          { rejectTermination: true },
        ) as never;
      });

    const first = sqlite3Command.execute(
      ["/database.db", "SELECT 1"],
      createContext({ fs }),
    );
    const second = sqlite3Command.execute(
      ["/database.db", "SELECT 2"],
      createContext({ fs }),
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.stderr).toContain("termination was not acknowledged");
    expect(secondResult.stderr).toContain("termination was not acknowledged");
    expect(createWorker).toHaveBeenCalledTimes(1);

    const third = await sqlite3Command.execute(
      ["/database.db", "SELECT 3"],
      createContext({ fs }),
    );
    expect(third.stderr).toContain("termination was not acknowledged");
    expect(createWorker).toHaveBeenCalledTimes(1);
  });
});
