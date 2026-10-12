/**
 * The git index file (.git/index), versions 2 and 3: the staged entries
 * sorted by path. Extensions of a file that is read are dropped when the
 * index is written; git rebuilds the ones it uses.
 */
import { createHash } from "node:crypto";

/** One staged file. `mode` is the git mode: 0o100644, 0o100755, 0o120000 (symbolic link), or 0o160000 (gitlink). */
export interface IndexEntry {
  path: string;
  oid: string;
  mode: number;
  /** Size and modification time of the working tree file when the entry was staged, for the check that skips reading an unchanged file. */
  size: number;
  mtimeSeconds: number;
  mtimeNanoseconds: number;
  /** Merge stage; 0 for an entry without a conflict. */
  stage: number;
}

const SIGNATURE = 0x44495243; // "DIRC"
const HASH_BYTES = 20;
const ENTRY_FIXED_BYTES = 62;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

/** Git's order of index entries: by the bytes of the path, then by stage. */
function compareIndexEntries(a: IndexEntry, b: IndexEntry): number {
  return comparePaths(a.path, b.path) || a.stage - b.stage;
}

/** Order of two paths by their UTF-8 bytes. */
export function comparePaths(a: string, b: string): number {
  if (a === b) return 0;
  const x = textEncoder.encode(a);
  const y = textEncoder.encode(b);
  const shared = Math.min(x.length, y.length);
  for (let i = 0; i < shared; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}

/** The entries of an index file. Fails on a version other than 2 and 3, and on a file whose checksum does not match. */
export function parseIndex(bytes: Uint8Array): IndexEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 + HASH_BYTES || view.getUint32(0) !== SIGNATURE) {
    throw new Error("index file corrupt: bad signature");
  }
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`index file version ${version} is not supported`);
  }
  const body = bytes.subarray(0, bytes.length - HASH_BYTES);
  const checksum = hex(bytes.subarray(bytes.length - HASH_BYTES));
  if (createHash("sha1").update(body).digest("hex") !== checksum) {
    throw new Error("index file corrupt: bad checksum");
  }
  const count = view.getUint32(8);
  const entries: IndexEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const mtimeSeconds = view.getUint32(offset + 8);
    const mtimeNanoseconds = view.getUint32(offset + 12);
    const mode = view.getUint32(offset + 24);
    const size = view.getUint32(offset + 36);
    const oid = hex(bytes.subarray(offset + 40, offset + 60));
    const flags = view.getUint16(offset + 60);
    const extended = (flags & 0x4000) !== 0;
    const pathStart = offset + ENTRY_FIXED_BYTES + (extended ? 2 : 0);
    let pathEnd = pathStart + (flags & 0xfff);
    // A path of 0xfff bytes or more ends at its NUL.
    if ((flags & 0xfff) === 0xfff) {
      while (bytes[pathEnd] !== 0) pathEnd++;
    }
    entries.push({
      path: textDecoder.decode(bytes.subarray(pathStart, pathEnd)),
      oid,
      mode,
      size,
      mtimeSeconds,
      mtimeNanoseconds,
      stage: (flags >> 12) & 3,
    });
    // Entries are padded with 1 to 8 NUL bytes to a multiple of 8.
    const length = pathEnd - offset;
    offset += (length + 8) & ~7;
  }
  return entries;
}

/** An index file of version 2 with the given entries, sorted here. */
export function serializeIndex(entries: readonly IndexEntry[]): Uint8Array {
  const sorted = [...entries].sort(compareIndexEntries);
  const paths = sorted.map((entry) => textEncoder.encode(entry.path));
  let total = 12 + HASH_BYTES;
  for (const path of paths) {
    total += (ENTRY_FIXED_BYTES + path.length + 8) & ~7;
  }
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, SIGNATURE);
  view.setUint32(4, 2);
  view.setUint32(8, sorted.length);
  let offset = 12;
  sorted.forEach((entry, i) => {
    const path = paths[i];
    // ctime repeats mtime; dev, ino, uid, and gid stay zero.
    view.setUint32(offset, entry.mtimeSeconds);
    view.setUint32(offset + 4, entry.mtimeNanoseconds);
    view.setUint32(offset + 8, entry.mtimeSeconds);
    view.setUint32(offset + 12, entry.mtimeNanoseconds);
    view.setUint32(offset + 24, entry.mode);
    view.setUint32(offset + 36, entry.size >>> 0);
    for (let j = 0; j < HASH_BYTES; j++) {
      bytes[offset + 40 + j] = Number.parseInt(
        entry.oid.slice(j * 2, j * 2 + 2),
        16,
      );
    }
    view.setUint16(
      offset + 60,
      (entry.stage << 12) | Math.min(path.length, 0xfff),
    );
    bytes.set(path, offset + ENTRY_FIXED_BYTES);
    offset += (ENTRY_FIXED_BYTES + path.length + 8) & ~7;
  });
  const digest = createHash("sha1")
    .update(bytes.subarray(0, total - HASH_BYTES))
    .digest();
  bytes.set(digest, total - HASH_BYTES);
  return bytes;
}
