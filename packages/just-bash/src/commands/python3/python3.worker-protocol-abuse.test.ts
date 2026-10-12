import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_BYTES } from "../../encoding.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import { resolveLimits } from "../../limits.js";
import type { RuntimeCommandContext } from "../../types.js";

type WorkerScript = (worker: {
  emit: (event: string, payload?: unknown) => void;
  emitAuthenticated: (event: string, payload: Record<string, unknown>) => void;
}) => void;

const mockState = vi.hoisted(() => ({
  script: null as WorkerScript | null,
  bridgeRunError: null as Error | null,
}));

vi.mock("node:worker_threads", () => {
  class MockWorker {
    private handlers = new Map<string, Array<(payload?: unknown) => void>>();

    constructor(_path: string, opts: unknown) {
      const protocolToken =
        typeof (opts as { workerData?: { protocolToken?: unknown } })
          ?.workerData?.protocolToken === "string"
          ? ((opts as { workerData: { protocolToken: string } }).workerData
              .protocolToken as string)
          : "";
      queueMicrotask(() => {
        mockState.script?.({
          emit: (event: string, payload?: unknown) => this.emit(event, payload),
          emitAuthenticated: (
            event: string,
            payload: Record<string, unknown>,
          ) => {
            const message = Object.create(null) as Record<string, unknown>;
            for (const [key, value] of Object.entries(payload)) {
              message[key] = value;
            }
            message.protocolToken = protocolToken;
            this.emit(event, message);
          },
        });
      });
    }

    on(event: string, cb: (payload?: unknown) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
      return this;
    }

    removeListener(event: string, cb: (payload?: unknown) => void): this {
      const list = this.handlers.get(event) ?? [];
      this.handlers.set(
        event,
        list.filter((handler) => handler !== cb),
      );
      return this;
    }

    terminate(): Promise<number> {
      this.emit("exit", 0);
      return Promise.resolve(0);
    }

    private emit(event: string, payload?: unknown): void {
      const list = this.handlers.get(event) ?? [];
      for (const cb of list) cb(payload);
    }
  }

  return { Worker: MockWorker };
});

vi.mock("../worker-bridge/bridge-handler.js", () => {
  class MockBridgeHandler {
    async run(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      if (mockState.bridgeRunError) {
        throw mockState.bridgeRunError;
      }
      return { stdout: "BRIDGE_STDOUT\n", stderr: "", exitCode: 0 };
    }
  }

  return { BridgeHandler: MockBridgeHandler };
});

vi.mock("../worker-bridge/protocol.js", () => {
  return {
    createSharedBuffer: () => new SharedArrayBuffer(4096),
  };
});

import { _resetExecutionQueue, python3Command } from "./python3.js";

function createContext(
  overrides: Partial<RuntimeCommandContext> = {},
): RuntimeCommandContext {
  return {
    fs: new InMemoryFs(),
    cwd: "/home/user",
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

describe("python3 worker protocol abuse", { retry: 2 }, () => {
  beforeEach(async () => {
    mockState.script = null;
    mockState.bridgeRunError = null;
    _resetExecutionQueue();
    // Allow any in-flight workers from previous tests to settle
    await new Promise((r) => setTimeout(r, 10));
  });

  it("treats malformed worker message as explicit error", async () => {
    mockState.script = (worker) => {
      worker.emit("message", null);
    };

    const result = await python3Command.execute(
      ["-c", "print('ignored')"],
      createContext(),
    );

    expect(result.stdout).toBe("BRIDGE_STDOUT\n");
    expect(result.stderr).toBe("python3: Malformed worker response\n");
    expect(result.exitCode).toBe(1);
  });

  it("sanitizes worker error strings before forwarding to stderr", async () => {
    mockState.script = (worker) => {
      worker.emitAuthenticated("message", {
        success: false,
        error:
          "Traceback: /Users/attacker/work/secret.py via node:internal/modules/cjs/loader:1234",
      });
    };

    const result = await python3Command.execute(
      ["-c", "print('ignored')"],
      createContext(),
    );

    expect(result.stdout).toBe("BRIDGE_STDOUT\n");
    expect(result.stderr).toBe(
      "python3: Traceback: <path> via <internal>:1234\n",
    );
    expect(result.exitCode).toBe(1);
  });

  it("sanitizes bridge exception strings before forwarding to stderr", async () => {
    mockState.script = (worker) => {
      worker.emitAuthenticated("message", { success: true });
    };
    mockState.bridgeRunError = new Error(
      "bridge fault near /Users/attacker/workdir at node:internal/process/task_queues:95",
    );

    const result = await python3Command.execute(
      ["-c", "print('ignored')"],
      createContext(),
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "python3: bridge error: bridge fault near <path> at <internal>:95\n",
    );
    expect(result.exitCode).toBe(1);
  });

  it("rejects forged worker messages with invalid protocol token", async () => {
    mockState.script = (worker) => {
      worker.emit("message", {
        protocolToken: "attacker-controlled-token",
        success: true,
      });
    };

    const result = await python3Command.execute(
      ["-c", "print('ignored')"],
      createContext(),
    );

    expect(result.stdout).toBe("BRIDGE_STDOUT\n");
    expect(result.stderr).toBe(
      "python3: Malformed worker response: invalid protocol token\n",
    );
    expect(result.exitCode).toBe(1);
  });
});
