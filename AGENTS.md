# AGENTS.md

This file provides guidance to coding agents working with the code in this repository.

Source paths below are relative to `packages/just-bash`, the published package. The repository root has no `src/` or `dist/`.

## Setup and commands

just-bash is a pnpm monorepo. It requires Node.js `>=20.19` and pnpm. These commands run from the repository root:

```sh
pnpm install
pnpm build              # required before anything reads dist/
pnpm test:run           # unit, comparison, and spec tests; spec tests have known failures
pnpm test:unit          # fast unit tests
pnpm test:comparison    # recorded bash fixtures
pnpm test:wasm          # python3, sqlite3, js-exec
pnpm typecheck
pnpm --filter just-bash test:run src/commands/grep/grep.basic.test.ts  # a single test file
```

## Workflow shortcuts

- Inspect shell behavior with `pnpm dev:exec` instead of writing a throwaway script: `echo 'echo hello' | pnpm dev:exec`; `--real-bash` also runs the system bash and compares, `--print-ast` prints the parsed AST.
- While iterating, run `pnpm test:unit` or a single test file rather than the full suite.
- Tests run from source. Run `pnpm build` before exercising the compiled output under `dist/`.

## Code map

```
Input Script → Parser (src/parser/) → AST (src/ast/) → Interpreter (src/interpreter/) → ExecResult
```

| Path | Responsibility |
| --- | --- |
| `src/parser/` | Recursive descent parser producing AST nodes. `lexer.ts` tokenizes bash syntax (heredocs, quotes, expansions); `expansion-parser.ts` and `compound-parser.ts` handle expansions and compound commands. |
| `src/interpreter/` | AST execution. `interpreter.ts` holds the execution loop and command dispatch, alongside word expansion, arithmetic, conditionals, control flow, and `builtins/`. |
| `src/commands/` | One directory per command, holding its implementation and its tests. Commands are registered in `registry.ts`. |
| `src/commands/python3/` | CPython compiled to WebAssembly, running in a worker thread. |
| `src/commands/js-exec/` | Sandboxed JavaScript and TypeScript runtime built on QuickJS. |
| `src/fs/` | Virtual filesystem: `in-memory-fs/` and `mountable-fs/`. |
| `src/security/` | Defense-in-depth layers, execution limits, and the security test suite. |
| `src/comparison-tests/`, `src/spec-tests/` | Cross-checking suites: recorded bash fixtures, and bash specification conformance with known failures. |
