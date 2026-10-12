import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/comparison-tests/**",
      "**/python3/**",
      "**/sqlite3/**",
      "**/js-exec/**",
      "**/python-scripting*",
    ],
    // Tests that spawn workers or replace node modules need process-level
    // isolation so they don't leak state into thread neighbours.
    poolMatchGlobs: [
      ["forks", "**/security/attacks/**"],
      ["forks", "**/security/sandbox/**"],
      ["forks", "**/sqlite3.worker-protocol-abuse.test.ts"],
      ["forks", "**/python3.worker-protocol-abuse.test.ts"],
      ["forks", "**/python3.queue-desync.runtime.test.ts"],
      ["forks", "**/wasm-callback.test.ts"],
    ],
  },
});
