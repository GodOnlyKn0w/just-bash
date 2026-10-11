/**
 * Browser-compatible entry point for just-bash.
 *
 * Note: The gzip/gunzip/zcat commands will fail at runtime in browsers
 * since they use node:zlib. All other commands work.
 */

export type { BashLogger, BashOptions, ExecOptions } from "./Bash.js";
export { Bash } from "./Bash.js";
export type { AllCommandName, CommandName } from "./commands/registry.js";
export { getCommandNames } from "./commands/registry.js";
export type {
  CommandContextOptions,
  CustomCommand,
  LazyCommand,
} from "./custom-commands.js";
export { createCommandContext, defineCommand } from "./custom-commands.js";
export { InMemoryFs } from "./fs/in-memory-fs/index.js";
export type {
  BufferEncoding,
  CpOptions,
  CreateExclusiveOptions,
  DirectoryEntry,
  FileContent,
  FileEntry,
  FileInit,
  FileSystemFactory,
  FsEntry,
  FsStat,
  InitialFiles,
  LazyFileEntry,
  LazyFileProvider,
  MkdirOptions,
  RmOptions,
  SymlinkEntry,
} from "./fs/interface.js";
export {
  MountableFs,
  type MountableFsOptions,
  type MountConfig,
} from "./fs/mountable-fs/index.js";
export type {
  BashExecResult,
  Command,
  CommandContext,
  ExecResult,
  IFileSystem,
  ResolvedCommandContext,
} from "./types.js";
