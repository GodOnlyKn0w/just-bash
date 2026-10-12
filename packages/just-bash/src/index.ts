// AST types (for plugin authors)
export type {
  CommandNode,
  PipelineNode,
  ScriptNode,
  SimpleCommandNode,
  StatementNode,
  WordNode,
} from "./ast/types.js";
export type {
  BashLogger,
  BashOptions,
  ExecOptions,
  JavaScriptConfig,
} from "./Bash.js";
export { Bash } from "./Bash.js";
export type {
  AllCommandName,
  CommandName,
  JavaScriptCommandName,
  PythonCommandName,
} from "./commands/registry.js";
export {
  getCommandNames,
  getJavaScriptCommandNames,
  getPythonCommandNames,
} from "./commands/registry.js";
// Custom commands API
export type {
  CommandContextOptions,
  CustomCommand,
  LazyCommand,
} from "./custom-commands.js";
export {
  createCommandContext,
  defineCommand,
} from "./custom-commands.js";
// Byte/text boundary helpers — required by custom commands that read
// `ctx.stdin` (an opaque `ByteString`).
export type { ByteString, OutputKind } from "./encoding.js";
export {
  bytesOutput,
  decodeBytesToUtf8,
  EMPTY_BYTES,
  encodeUtf8ToBytes,
  latin1FromBytes,
  stdoutAsBytes,
  stdoutKind,
  textOutput,
  unsafeBytesFromLatin1,
} from "./encoding.js";
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
// Parser
export { parse } from "./parser/parser.js";
// Transform API
export { BashTransformPipeline } from "./transform/pipeline.js";
export type { CommandCollectorMetadata } from "./transform/plugins/command-collector.js";
export { CommandCollectorPlugin } from "./transform/plugins/command-collector.js";
export type {
  TeeFileInfo,
  TeePluginMetadata,
  TeePluginOptions,
} from "./transform/plugins/tee-plugin.js";
export { TeePlugin } from "./transform/plugins/tee-plugin.js";
export { serialize } from "./transform/serialize.js";
export type {
  BashTransformResult,
  TransformContext,
  TransformPlugin,
  TransformResult,
} from "./transform/types.js";
export type {
  BashExecResult,
  Command,
  CommandContext,
  CommandHook,
  CommandHookCall,
  ExecResult,
  IFileSystem,
  ResolvedCommandContext,
  StreamedBytes,
} from "./types.js";
