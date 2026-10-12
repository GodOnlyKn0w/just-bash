/**
 * The world backend interface of the tree harness (src/world/index.ts in the
 * tree repository), restated here because this package does not depend on
 * tree. Names and semantics follow tree's definitions; tree's docs/world.md
 * is the reference for every term used below.
 */
import { createHash } from "node:crypto";

const CONTENT_VERSION_CHARS = 12;

/** The content version of `content`: SHA-256 of all bytes, first 12 lowercase hex characters. Strings are hashed as UTF-8. */
export function contentVersion(content: Uint8Array | string): string {
  return createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, CONTENT_VERSION_CHARS);
}

export type WorldWriter = "tool" | "runtime" | "human";

/** The execution a report belongs to. `invocation` is tree's ToolInvocation, passed through unchanged. */
export interface WorldExecution {
  readonly driver: WorldWriter;
  readonly invocation?: unknown;
  readonly jobId?: string;
  readonly commandId?: string;
}

export type WorldChangeKind =
  | "create"
  | "modify"
  | "remove"
  | "move"
  | "metadata";
export type WorldReadKind = "content" | "list" | "stat";

export interface WorldChange {
  readonly execution: WorldExecution;
  readonly path: string;
  readonly kind: WorldChangeKind;
  readonly to?: string;
  readonly before?: string;
  readonly after?: string;
  readonly worldVersion?: string;
}

export interface WorldRead {
  readonly execution: WorldExecution;
  readonly path: string;
  readonly kind: WorldReadKind;
  readonly version?: string;
}

export interface CommandInvocation {
  readonly execution: WorldExecution & { readonly commandId: string };
  readonly parentCommandId?: string;
  readonly name: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

/** Each method returns after the host has recorded the report, so the order of calls is the order of records. */
export interface WorldObserver {
  changed(change: WorldChange): void;
  read(read: WorldRead): void;
  invoked(command: CommandInvocation): void;
}

export interface WorldCapabilities {
  readonly toolObservation: boolean;
  readonly commandObservation: boolean;
  readonly commandInvocations: boolean;
  readonly worldVersion: boolean;
  readonly fork: boolean;
  readonly clock: "host" | "world";
  readonly commands: "process" | "interpreter";
  readonly toolOrigin: boolean;
}

export type WorldEntry =
  | { readonly kind: "file"; readonly content: Buffer }
  | { readonly kind: "directory" };

export interface WorldStat {
  readonly kind: "file" | "directory";
  readonly size: number;
}

export type WorldExit = { readonly code: number } | { readonly signal: string };

export interface WorldOutputFile {
  write(chunk: Buffer): void;
  close(): void;
  discard(): void;
}

export interface ExecOptions {
  readonly execution: WorldExecution;
  readonly signal: AbortSignal;
  onOutput(chunk: Buffer): void;
}

export interface ExecResult {
  readonly exit: WorldExit;
  readonly endedBeforeStop?: {
    readonly elapsedMs: number;
    readonly exit: WorldExit;
  };
}

export interface WorldJobEnd {
  readonly exit: WorldExit | null;
  readonly residualKilled: boolean;
}

export interface WorldJob {
  readonly handle: string;
  readonly ended: Promise<WorldJobEnd>;
  kill(): Promise<void>;
}

/**
 * One path of a world version. Symbolic links are part of this world but not
 * of tree's interface, which only knows files and directories; they are
 * listed with kind "symlink" and their target.
 */
export interface WorldVersionEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
  /** Content version of a file. */
  readonly version?: string;
  /** Target of a symbolic link. */
  readonly target?: string;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface WorldBinding {
  readonly module: string;
  readonly options?: JsonValue;
}

export type WorldPathFailure = "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR";

export interface WorldVersions {
  current(): Promise<string>;
  readonly forkedFrom: string | undefined;
  entries(version: string): Promise<WorldVersionEntry[] | undefined>;
  content(version: string): Promise<Buffer | undefined>;
}

export interface WorldBackend {
  readonly capabilities: WorldCapabilities;
  readonly cwd: string;
  bind(observer: WorldObserver, restore: string | undefined): Promise<void>;
  readEntry(
    path: string,
    execution: WorldExecution,
  ): Promise<WorldEntry | undefined>;
  stat(path: string, execution: WorldExecution): Promise<WorldStat | undefined>;
  writeFile(
    path: string,
    content: Buffer,
    execution: WorldExecution,
    options?: { readonly exclusive?: boolean },
  ): Promise<void>;
  makeDirectory(path: string, execution: WorldExecution): Promise<void>;
  remove(path: string, execution: WorldExecution): Promise<void>;
  outputPath(name: string): string;
  createOutput(path: string, execution: WorldExecution): WorldOutputFile;
  exec(command: string, options: ExecOptions): Promise<ExecResult>;
  startJob(
    command: string,
    options: Omit<ExecOptions, "signal">,
  ): Promise<WorldJob>;
  reapJob(handle: string): void;
  readonly versions?: WorldVersions;
  fork?(version: string): Promise<WorldBinding>;
  close(): Promise<void>;
}

export interface WorldBackendInput {
  readonly cwd: string;
  readonly options: JsonValue | undefined;
  readonly snapshots?: string;
}
