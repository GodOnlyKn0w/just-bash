import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: [
      "src/commands/python3/**/*.test.ts",
      "src/commands/sqlite3/**/*.test.ts",
      "src/commands/js-exec/**/*.test.ts",
      "src/agent-examples/python-scripting.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Mock tests (worker-protocol-abuse, queue-timeout-exploit) use
    // vi.mock to replace node:worker_threads. They share module-level queue
    // state with real tests, so each file needs its own module instance.
    isolate: true,
    // WASM worker tests need process-level isolation.
    maxWorkers: 2,
    poolMatchGlobs: [
      ["forks", "**/python3*.test.ts"],
      ["forks", "**/sqlite3*.test.ts"],
      ["forks", "**/js-exec*.test.ts"],
      ["forks", "**/python-scripting.test.ts"],
    ],
  },
});
