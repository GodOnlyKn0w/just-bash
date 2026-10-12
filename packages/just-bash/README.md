# just-bash

A virtual bash environment with an in-memory filesystem, written in TypeScript and designed for AI agents.

Broad support for standard unix commands and bash syntax with optional Python, JS/TS, and sqlite support.

**Note**: This is beta software. Use at your own risk and please provide feedback. See [security model](#security-model).

## Quick Start

```bash
npm install just-bash
```

```typescript
import { Bash } from "just-bash";

const bash = new Bash();
await bash.exec('echo "Hello" > greeting.txt');
const result = await bash.exec("cat greeting.txt");
console.log(result.stdout); // "Hello\n"
console.log(result.exitCode); // 0
```

Each `exec()` call gets its own isolated shell state — environment variables, functions, and working directory reset between calls. The **filesystem is shared** across calls, so files written in one `exec()` are visible in the next.

## Custom Commands

Extend just-bash with your own TypeScript commands using `defineCommand`:

```typescript
import { Bash, decodeBytesToUtf8, defineCommand } from "just-bash";

const hello = defineCommand("hello", async (args, ctx) => {
  const name = args[0] || "world";
  return { stdout: `Hello, ${name}!\n`, stderr: "", exitCode: 0 };
});

const upper = defineCommand("upper", async (args, ctx) => {
  // ctx.stdin is a ByteString — decode to text before string ops.
  return {
    stdout: decodeBytesToUtf8(ctx.stdin).toUpperCase(),
    stderr: "",
    exitCode: 0,
  };
});

const bash = new Bash({ customCommands: [hello, upper] });

await bash.exec("hello Alice"); // "Hello, Alice!\n"
await bash.exec("echo 'test' | upper"); // "TEST\n"
```

Custom command callbacks receive a `ResolvedCommandContext` with `fs`, `cwd`,
`env`, `stdin`, resolved `limits`, and `exec` (for subcommands), and work with
pipes, redirections, and all shell features. The legacy `CommandContext` remains
available for standalone context inputs; use `createCommandContext({ fs })` when
calling a command directly with a fully resolved context.

Every invocation is bound by `maxExecutionTimeMs`. On cancellation, just-bash
revokes the command context immediately; `maxExtensionCleanupTimeMs` only
bounds how long it waits for the now-authority-free command promise to settle.
A command that is still resolving, such as one whose module is loading, is
never started and reports cancellation immediately instead.
A late continuation cannot use `ctx.fs`, `ctx.env`, `ctx.exec`, or other context
capabilities. Cleanup work that must run at scope closure can be registered with
`ctx.executionScope.registerCleanup()`. A cleanup failure is returned as a
generic exit-126 shell result rather than rejecting `Bash.exec()` or exposing
host error details. JavaScript cannot forcibly stop arbitrary host code, so
extensions requiring a hard guarantee against external side effects must run
in a terminable worker or process. Tests that invoke command objects directly
can use `createCommandContext({ fs })` to get a fully resolved context without
duplicating internal defaults.

<details>
<summary><h2>Supported Commands</h2></summary>

### File Operations

`cat`, `cp`, `file`, `ln`, `ls`, `mkdir`, `mktemp`, `mv`, `readlink`, `rm`, `rmdir`, `split`, `stat`, `touch`, `tree`

### Text Processing

`awk`, `base64`, `column`, `comm`, `cut`, `diff`, `expand`, `fold`, `grep` (+ `egrep`, `fgrep`), `head`, `join`, `md5sum`, `nl`, `od`, `paste`, `printf`, `rev`, `rg`, `sed`, `sha1sum`, `sha256sum`, `sort`, `strings`, `tac`, `tail`, `tr`, `unexpand`, `uniq`, `wc`, `xargs`

### Data Processing

`jq` (JSON), `sqlite3` (SQLite), `xan` (CSV), `yq` (YAML/XML/TOML/CSV), `html-to-markdown` (HTML)

### Optional Runtimes

`js-exec` (JavaScript/TypeScript via QuickJS; requires `javascript: true`), `python3`/`python` (Python via CPython; requires `python: true`)

### Compression & Archives

`gzip` (+ `gunzip`, `zcat`), `tar`

### Version Control

`git` (subcommands init, add, commit, status, diff, log, and stash; any other subcommand or option exits with 129)

### Navigation & Environment

`basename`, `cd`, `dirname`, `du`, `echo`, `env`, `export`, `find`, `hostname`, `printenv`, `pwd`, `tee`

### Shell Utilities

`alias`, `bash`, `chmod`, `clear`, `date`, `expr`, `false`, `help`, `history`, `seq`, `sh`, `sleep`, `time`, `timeout`, `true`, `unalias`, `which`, `whoami`, `yes`

All commands support `--help` for usage information.

### Shell Features

- **Pipes**: `cmd1 | cmd2`
- **Redirections**: `>`, `>>`, `2>`, `2>&1`, `<`
- **Command chaining**: `&&`, `||`, `;`
- **Variables**: `$VAR`, `${VAR}`, `${VAR:-default}`
- **Positional parameters**: `$1`, `$2`, `$@`, `$#`
- **Glob patterns**: `*`, `?`, `[...]`
- **If statements**: `if COND; then CMD; elif COND; then CMD; else CMD; fi`
- **Functions**: `function name { ... }` or `name() { ... }`
- **Local variables**: `local VAR=value`
- **Loops**: `for`, `while`, `until`
- **Symbolic links**: `ln -s target link`
- **Hard links**: `ln target link`

</details>

## Configuration

```typescript
const env = new Bash({
  files: { "/data/file.txt": "content" }, // Initial files
  env: { MY_VAR: "value" }, // Initial environment
  cwd: "/app", // Starting directory (default: /home/user)
  executionLimits: { maxCallDepth: 50 }, // See "Execution Protection"
  python: true, // Enable python3/python commands
  javascript: true, // Enable js-exec command
  // Or with bootstrap: javascript: { bootstrap: "globalThis.X = 1;" }
});

// Per-exec overrides
await env.exec("echo $TEMP", { env: { TEMP: "value" }, cwd: "/tmp" });

// Pass stdin to the script
await env.exec("cat", { stdin: "hello from stdin\n" });

// Start with a clean environment
await env.exec("env", { replaceEnv: true, env: { ONLY: "this" } });

// Pass arguments without shell escaping (like spawnSync)
await env.exec("grep", { args: ["-r", "TODO", "src/"] });

// Cancel long-running scripts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);
await env.exec("while true; do sleep 1; done", { signal: controller.signal });

// Preserve leading whitespace (e.g., for heredocs)
await env.exec("cat <<EOF\n  indented\nEOF", { rawScript: true });
```

### Timezone

`date` defaults to UTC (`%Z=UTC`, `%z=+0000`) regardless of the host clock, so the sandbox does not leak the host timezone. To opt into a specific zone, pass `TZ` as an initial env var:

```typescript
const bash = new Bash({ env: { TZ: "America/New_York" } });
await bash.exec("date"); // Mon Jun  1 09:30:00 EDT 2026
```

`-u` always forces UTC; an unset or invalid `$TZ` falls back to UTC. Setting `TZ` exposes that timezone to scripts running in the sandbox, so only pass a value you are comfortable revealing — forwarding the host's real `$TZ` (e.g. `process.env.TZ`) reintroduces the disclosure that the UTC default exists to prevent.

`exec()` options:

| Option | Type | Description |
|---|---|---|
| `env` | `Record<string, string>` | Environment variables for this execution only |
| `cwd` | `string` | Working directory for this execution only |
| `stdin` | `string` | Standard input passed to the script |
| `args` | `string[]` | Additional argv passed directly to the first command (bypasses shell parsing; does not change `$1`, `$2`, ...) |
| `replaceEnv` | `boolean` | Start with empty env instead of merging (default: `false`) |
| `signal` | `AbortSignal` | Cooperative cancellation; stops at next statement boundary |
| `rawScript` | `boolean` | Skip leading-whitespace normalization (default: `false`) |

## Filesystem Options

Two filesystem implementations:

**InMemoryFs** (default) - Pure in-memory filesystem, no disk access:

```typescript
import { Bash } from "just-bash";

const env = new Bash({
  files: {
    "/data/config.json": '{"key": "value"}',
    // Lazy: called on first read, cached. Never called if written before read.
    "/data/large.csv": () => "col1,col2\na,b\n",
    "/data/remote.txt": async () => (await fetch("https://example.com")).text(),
  },
});
```

**MountableFs** - Mount multiple filesystems at different paths into a unified namespace. A mounted filesystem sees paths relative to its mount point:

```typescript
import { Bash, MountableFs, InMemoryFs } from "just-bash";

const fs = new MountableFs({ base: new InMemoryFs() });

// Mount a knowledge base
fs.mount("/mnt/knowledge", new InMemoryFs({ "/doc.txt": "notes\n" }));

// Mount a workspace
fs.mount("/home/agent", new InMemoryFs());

const bash = new Bash({ fs, cwd: "/home/agent" });

await bash.exec("ls /mnt/knowledge"); // reads from knowledge base
await bash.exec("cp /mnt/knowledge/doc.txt ./"); // cross-mount copy
await bash.exec('echo "notes" > notes.txt'); // writes to workspace
```

You can also configure mounts in the constructor:

```typescript
import { MountableFs, InMemoryFs } from "just-bash";

const fs = new MountableFs({
  base: new InMemoryFs(),
  mounts: [
    { mountPoint: "/data", filesystem: new InMemoryFs() },
    { mountPoint: "/workspace", filesystem: new InMemoryFs() },
  ],
});
```

## Optional Capabilities

### JavaScript Support

JavaScript and TypeScript execution via QuickJS is opt-in due to additional security surface. Enable with `javascript: true`:

```typescript
const env = new Bash({
  javascript: true,
});

// Execute JavaScript code
await env.exec('js-exec -c "console.log(1 + 2)"');

// Run script files (.js, .mjs, .ts, .mts)
await env.exec('js-exec script.js');

// ES module mode with imports
await env.exec('js-exec -m -c "import fs from \'fs\'; console.log(fs.readFileSync(\'/data/file.txt\', \'utf8\'))"');
```

#### Bootstrap Code

Run setup code before every `js-exec` invocation with the `bootstrap` option:

```typescript
const env = new Bash({
  javascript: {
    bootstrap: `
      globalThis.API_BASE = "https://api.example.com";
      globalThis.formatDate = (d) => new Date(d).toISOString();
    `,
  },
});

await env.exec('js-exec -c "console.log(API_BASE)"');
// Output: https://api.example.com
```

#### Node.js Compatibility

`js-exec` supports `require()` and `import` with these Node.js modules:

- **fs**: `readFileSync`, `writeFileSync`, `readdirSync`, `statSync`, `existsSync`, `mkdirSync`, `rmSync`, `fs.promises.*`
- **path**: `join`, `resolve`, `dirname`, `basename`, `extname`, `relative`, `normalize`
- **child_process**: `execSync`, `spawnSync`
- **process**: `argv`, `cwd()`, `exit()`, `env`, `platform`, `version`
- **Other modules**: `os`, `url`, `assert`, `util`, `events`, `buffer`, `stream`, `string_decoder`, `querystring`
- **Globals**: `console`, `Buffer`, `URL`, `URLSearchParams`, `Headers`, `Request`, `Response`

`fs.readFileSync()` returns a `Buffer` by default (matching Node.js). Pass an encoding like `'utf8'` to get a string.

**Note:** The `js-exec` command only exists when `javascript` is configured. It is not available in browser environments. Execution uses the `run` package's QuickJS sandbox with a 64 MB memory limit and configurable timeout (30 seconds in the default `normal` profile and 10 seconds in the opt-in `hardened` profile).

#### Tool Invocation Hook

`js-exec` scripts can call host-defined tools through a global `tools` proxy
when `javascript.invokeTool` is provided:

```typescript
const bash = new Bash({
  javascript: {
    // path:     "math.add"  (dot-separated)
    // argsJson: '{"a":1,"b":2}'  (or "" for no args)
    // return:   JSON-stringified result, or "" for undefined
    // throw:    propagates as a sandbox exception
    invokeTool: async (path, argsJson, abortSignal) => {
      const args = argsJson ? JSON.parse(argsJson) : undefined;
      if (path === "math.add") {
        abortSignal.throwIfAborted();
        return JSON.stringify({ sum: args.a + args.b });
      }
      throw new Error(`Unknown tool: ${path}`);
    },
  },
});

await bash.exec(`js-exec -c 'console.log((await tools.math.add({a:3,b:4})).sum)'`);
```

The `abortSignal` fires when the JavaScript execution is canceled or times
out. Tool implementations should forward it to network requests and other
cancelable work so effects do not outlive the sandbox execution.

The hook is generic — wire any tool framework through it (raw maps, MCP,
Anthropic tool-use, etc.).

### Python Support

Python (CPython compiled to WASM) is opt-in due to additional security surface. Enable with `python: true`:

```typescript
const env = new Bash({
  python: true,
});

// Execute Python code
await env.exec('python3 -c "print(1 + 2)"');

// Run Python scripts
await env.exec('python3 script.py');
```

**Note:** The `python3` and `python` commands only exist when `python: true` is configured. Python is not available in browser environments.

### SQLite Support

`sqlite3` uses sql.js (SQLite compiled to WASM), sandboxed from the real filesystem:

```typescript
const env = new Bash();

// Query in-memory database
await env.exec('sqlite3 :memory: "SELECT 1 + 1"');

// Query file-based database
await env.exec('sqlite3 data.db "SELECT * FROM users"');
```

**Note:** SQLite is not available in browser environments. Queries run in a worker thread with a configurable timeout (30 seconds in the default `normal` profile and 5 seconds in the opt-in `hardened` profile) to prevent runaway queries from blocking execution.

## AST Transform Plugins

Parse bash scripts into an AST, transform them, and serialize back to bash. Good for instrumenting scripts (e.g., capturing per-command stdout/stderr) or extracting metadata before execution.

```typescript
import { Bash, BashTransformPipeline, TeePlugin, CommandCollectorPlugin } from "just-bash";

// Standalone pipeline — output can be run by any shell
const pipeline = new BashTransformPipeline()
  .use(new TeePlugin({ outputDir: "/tmp/logs" }))
  .use(new CommandCollectorPlugin());
const result = pipeline.transform("echo hello | grep hello");
result.script;             // transformed bash string
result.metadata.commands;  // ["echo", "grep", "tee"]

// Integrated API — exec() auto-applies transforms and returns metadata
const bash = new Bash();
bash.registerTransformPlugin(new CommandCollectorPlugin());
const execResult = await bash.exec("echo hello | grep hello");
execResult.metadata?.commands; // ["echo", "grep"]
```

See [src/transform/README.md](src/transform/README.md) for the full API, built-in plugins, and how to write custom plugins.

## Execution Protection

Bash protects against infinite loops and deep recursion with configurable limits:

```typescript
const env = new Bash({
  // `normal` is the liberal, compatibility-oriented default. Use `hardened`
  // for tighter untrusted-workload policy, then override individual resources.
  executionLimitProfile: "hardened",
  executionLimits: {
    maxCallDepth: 100, // Max function recursion depth
    maxCommandCount: 20000, // Shared across nested execution
    maxSourceBytes: 8 * 1024 * 1024, // Shell source before parsing
    maxFileSystemBytes: 256 * 1024 * 1024, // Retained default-FS data
    maxOutputSize: 32 * 1024 * 1024, // Aggregate stdout + stderr bytes
    maxArchiveBytes: 256 * 1024 * 1024, // Expanded archive bytes
    maxDatabaseBytes: 128 * 1024 * 1024, // SQLite image bytes
    maxExecutionTimeMs: 30_000, // Whole execution wall-clock deadline
    maxExtensionCleanupTimeMs: 25, // Cancellation acknowledgement grace
  },
});
```

All resources remain bounded by default in both profiles. Explicit values
override the selected profile; non-negative safe integers and the legacy
`Infinity` spelling are accepted. Infinite deadlines omit the corresponding
platform timer rather than overflowing it; `js-exec` maps an infinite
JavaScript deadline to `run`'s longest timeout (about 24.9 days). Invalid
values are rejected when `Bash` is constructed. Error messages identify the
resource that was hit.

## Security Model

The Node.js package requires Node `>=20.19`.

- The shell only has access to the provided filesystem.
- All execution happens without VM isolation. This does introduce additional risk. The code base was designed to be robust against prototype-pollution attacks and other break outs to the host JS engine and filesystem.
- There is no network access.
- Python and JavaScript execution are off by default as they represent additional security surface.
- `js-exec` guest code runs inside the `run` package's QuickJS/WASM realm. Its
  primary isolation boundary is QuickJS plus the validated, bounded host
  bridge; guest JavaScript does not execute in the Node worker realm.
- Execution is protected against infinite loops and deep recursion with configurable limits.
- Node worker `resourceLimits` do not reliably cap the WebAssembly linear memory used by CPython or sql.js. Queue, deadline, file, database, bridge, and payload limits reduce exposure, but strong memory containment for these opt-in runtimes requires process/container isolation or a WASM build with a lower hard maximum.

## Browser Support

The core shell (parsing, execution, filesystem, and all built-in commands) works in browser environments. The following features require Node.js and are unavailable in browsers: `python3`/`python`, `sqlite3`, and `js-exec`.

## Default Layout

When created without options, Bash provides a Unix-like directory structure:

- `/home/user` - Default working directory (and `$HOME`)
- `/bin` - Contains stubs for all built-in commands
- `/usr/bin` - Additional binary directory
- `/tmp` - Temporary files directory

Commands can be invoked by path (e.g., `/bin/ls`) or by name.

## License

Apache-2.0
