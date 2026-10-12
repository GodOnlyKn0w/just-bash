/**
 * The output formats of `git diff` for a list of changes: the patch, the
 * diffstat, the name lists, and the summary lines that `git commit` prints.
 *
 * Every string a function returns holds bytes: one character for each byte
 * of the output.
 */
import { encodeUtf8ToBytes, latin1FromBytes } from "../../encoding.js";
import { type Change, sideContent } from "./changes.js";
import type { Repository } from "./repository.js";
import {
  byteString,
  DEFAULT_TEXT_DIFF,
  diffText,
  isBinary,
  type TextDiffOptions,
} from "./text-diff.js";

/** The UTF-8 bytes of text. */
export function utf8(text: string): string {
  return latin1FromBytes(encodeUtf8ToBytes(text));
}

const ESCAPES: ReadonlyMap<number, string> = new Map([
  [7, "\\a"],
  [8, "\\b"],
  [9, "\\t"],
  [10, "\\n"],
  [11, "\\v"],
  [12, "\\f"],
  [13, "\\r"],
  [34, '\\"'],
  [92, "\\\\"],
]);

/**
 * The bytes of a path as git prints it with core.quotePath: in double quotes
 * with C escapes when it holds a control character, a double quote, a
 * backslash, or a byte from 0x80, and with quoteSpace also when it holds a
 * space.
 */
export function quotePath(path: string, quoteSpace = false): string {
  const bytes = utf8(path);
  let quoted = "";
  let needed = false;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes.charCodeAt(i);
    const escaped = ESCAPES.get(byte);
    if (escaped !== undefined) {
      quoted += escaped;
      needed = true;
    } else if (byte < 0x20 || byte >= 0x7f) {
      quoted += `\\${byte.toString(8).padStart(3, "0")}`;
      needed = true;
    } else {
      quoted += bytes[i];
      if (byte === 0x20 && quoteSpace) needed = true;
    }
  }
  return needed ? `"${quoted}"` : bytes;
}

/** One change with its content compared. */
export interface FileDiff {
  readonly change: Change;
  readonly binary: boolean;
  /** The hunks of a text change. */
  readonly hunks: string;
  readonly insertions: number;
  readonly deletions: number;
  /** Byte sizes of the two sides of a binary change. */
  readonly oldSize: number;
  readonly newSize: number;
}

/** Compares the content of each change. A type change becomes a deletion followed by an addition, as git prints it. */
export async function fileDiffs(
  repository: Repository,
  changes: readonly Change[],
  options: TextDiffOptions = DEFAULT_TEXT_DIFF,
): Promise<FileDiff[]> {
  const diffs: FileDiff[] = [];
  for (const change of changes) {
    if (change.status === "T") {
      diffs.push(
        ...(await fileDiffs(
          repository,
          [
            { status: "D", path: change.path, before: change.before },
            { status: "A", path: change.path, after: change.after },
          ],
          options,
        )),
      );
      continue;
    }
    const sameContent =
      change.before !== undefined &&
      change.after !== undefined &&
      change.before.oid === change.after.oid;
    const before = await sideContent(
      repository,
      change.oldPath ?? change.path,
      change.before,
    );
    const after = sameContent
      ? before
      : await sideContent(repository, change.path, change.after);
    const binary = isBinary(before) || isBinary(after);
    const text =
      binary || sameContent
        ? { text: "", insertions: 0, deletions: 0 }
        : diffText(byteString(before), byteString(after), options);
    diffs.push({
      change,
      binary,
      hunks: text.text,
      insertions: text.insertions,
      deletions: text.deletions,
      // git does not load the content of two sides with the same object id.
      oldSize: sameContent && !change.after?.inWorktree ? 0 : before.length,
      newSize: sameContent && !change.after?.inWorktree ? 0 : after.length,
    });
  }
  return diffs;
}

function octal(mode: number): string {
  return mode.toString(8).padStart(6, "0");
}

const ABBREVIATION = 7;

/** The patch of the diffs: for each one the `diff --git` header and the hunks. The two prefixes go before the old and the new path. */
export function patch(
  diffs: readonly FileDiff[],
  prefixes: readonly [string, string] = ["a/", "b/"],
): string {
  let out = "";
  for (const diff of diffs) {
    const { change } = diff;
    const oldName = quotePath(`${prefixes[0]}${change.oldPath ?? change.path}`);
    const newName = quotePath(`${prefixes[1]}${change.path}`);
    out += `diff --git ${oldName} ${newName}\n`;
    const { before, after } = change;
    if (before === undefined && after !== undefined) {
      out += `new file mode ${octal(after.mode)}\n`;
    } else if (before !== undefined && after === undefined) {
      out += `deleted file mode ${octal(before.mode)}\n`;
    } else if (before !== undefined && after !== undefined) {
      if (before.mode !== after.mode) {
        out += `old mode ${octal(before.mode)}\nnew mode ${octal(after.mode)}\n`;
      }
    }
    if (change.status === "R") {
      out += `similarity index ${change.similarity}%\nrename from ${quotePath(change.oldPath ?? "")}\nrename to ${quotePath(change.path)}\n`;
    }
    const oldOid = before?.oid ?? "0".repeat(40);
    const newOid = after?.oid ?? "0".repeat(40);
    if (oldOid === newOid) continue;
    out += `index ${oldOid.slice(0, ABBREVIATION)}..${newOid.slice(0, ABBREVIATION)}${
      before !== undefined && after !== undefined && before.mode === after.mode
        ? ` ${octal(after.mode)}`
        : ""
    }\n`;
    const oldLabel = before === undefined ? "/dev/null" : oldName;
    const newLabel = after === undefined ? "/dev/null" : newName;
    if (diff.binary) {
      out += `Binary files ${oldLabel} and ${newLabel} differ\n`;
    } else if (diff.hunks !== "") {
      // git ends the name of a file with a tab when the name has a space.
      const end = (label: string) => (label.includes(" ") ? "\t" : "");
      out += `--- ${oldLabel}${end(oldLabel)}\n+++ ${newLabel}${end(newLabel)}\n${diff.hunks}`;
    }
  }
  return out;
}

/** A rename as git abbreviates it: `dir/{old => new}/file`, or `old => new` without a common part. */
function renameName(oldPath: string, newPath: string): string {
  const a = quotePath(oldPath);
  const b = quotePath(newPath);
  if (a.startsWith('"') || b.startsWith('"')) return `${a} => ${b}`;
  let prefix = 0;
  for (let i = 0; i < a.length && i < b.length && a[i] === b[i]; i++) {
    if (a[i] === "/") prefix = i + 1;
  }
  let suffix = 0;
  const slash = prefix > 0 ? 1 : 0;
  let oldEnd = a.length - 1;
  let newEnd = b.length - 1;
  while (
    prefix - slash <= oldEnd &&
    prefix - slash <= newEnd &&
    a[oldEnd] === b[newEnd]
  ) {
    if (a[oldEnd] === "/") suffix = a.length - oldEnd;
    oldEnd--;
    newEnd--;
  }
  if (prefix + suffix === 0) return `${a} => ${b}`;
  const oldMiddle = a.slice(prefix, Math.max(prefix, a.length - suffix));
  const newMiddle = b.slice(prefix, Math.max(prefix, b.length - suffix));
  return `${a.slice(0, prefix)}{${oldMiddle} => ${newMiddle}}${a.slice(a.length - suffix)}`;
}

function displayName(change: Change): string {
  return change.status === "R" && change.oldPath !== undefined
    ? renameName(change.oldPath, change.path)
    : quotePath(change.path);
}

function decimalWidth(value: number): number {
  return String(value).length;
}

function scale(value: number, width: number, maximum: number): number {
  return value === 0 ? 0 : 1 + Math.floor((value * (width - 1)) / maximum);
}

const STAT_WIDTH = 80;

/** The last line of a diffstat: ` 2 files changed, 3 insertions(+), 1 deletion(-)`; empty without files. */
export function shortStat(diffs: readonly FileDiff[]): string {
  if (diffs.length === 0) return "";
  let insertions = 0;
  let deletions = 0;
  for (const diff of diffs) {
    insertions += diff.insertions;
    deletions += diff.deletions;
  }
  let out = ` ${diffs.length} file${diffs.length === 1 ? "" : "s"} changed`;
  if (insertions > 0 || deletions === 0) {
    out += `, ${insertions} insertion${insertions === 1 ? "" : "s"}(+)`;
  }
  if (deletions > 0 || insertions === 0) {
    out += `, ${deletions} deletion${deletions === 1 ? "" : "s"}(-)`;
  }
  return `${out}\n`;
}

/** The diffstat of `git diff --stat` at a width of 80 columns. */
export function stat(diffs: readonly FileDiff[]): string {
  if (diffs.length === 0) return "";
  const names = diffs.map((diff) => displayName(diff.change));
  let maxLength = 0;
  let maxChange = 0;
  let numberWidth = 0;
  let binWidth = 0;
  diffs.forEach((diff, i) => {
    maxLength = Math.max(maxLength, names[i].length);
    if (diff.binary) {
      binWidth = Math.max(
        binWidth,
        14 + decimalWidth(diff.oldSize) + decimalWidth(diff.newSize),
      );
      numberWidth = 3;
    } else {
      maxChange = Math.max(maxChange, diff.insertions + diff.deletions);
    }
  });
  numberWidth = Math.max(numberWidth, decimalWidth(maxChange));
  const width = Math.max(STAT_WIDTH, 16 + 6 + numberWidth);
  let graphWidth = maxChange + 4 > binWidth ? maxChange : binWidth - 4;
  let nameWidth = maxLength;
  if (nameWidth + numberWidth + 6 + graphWidth > width) {
    const limit = Math.floor((width * 3) / 8) - numberWidth - 6;
    if (graphWidth > limit) graphWidth = Math.max(limit, 6);
    if (nameWidth > width - numberWidth - 6 - graphWidth) {
      nameWidth = width - numberWidth - 6 - graphWidth;
    } else {
      graphWidth = width - numberWidth - 6 - nameWidth;
    }
  }
  let out = "";
  diffs.forEach((diff, i) => {
    let name = names[i];
    if (name.length > nameWidth) {
      // Keep the end of the name, from a slash on when there is one.
      let kept = name.slice(name.length - (nameWidth - 3));
      const slash = kept.indexOf("/");
      if (slash !== -1) kept = kept.slice(slash);
      name = `...${kept}`;
    }
    // @banned-pattern-ignore: nameWidth is at most the width of the diffstat
    out += ` ${name.padEnd(nameWidth)} |`;
    if (diff.binary) {
      // @banned-pattern-ignore: numberWidth is the digit count of a line count
      out += ` ${"Bin".padStart(numberWidth)}`;
      if (diff.oldSize !== 0 || diff.newSize !== 0) {
        out += ` ${diff.oldSize} -> ${diff.newSize} bytes`;
      }
      out += "\n";
      return;
    }
    let added = diff.insertions;
    let deleted = diff.deletions;
    const total = added + deleted;
    // @banned-pattern-ignore: numberWidth is the digit count of a line count
    out += ` ${String(total).padStart(numberWidth)}${total > 0 ? " " : ""}`;
    if (graphWidth <= maxChange) {
      let scaled = scale(total, graphWidth, maxChange);
      if (scaled < 2 && added > 0 && deleted > 0) scaled = 2;
      if (added < deleted) {
        added = scale(added, graphWidth, maxChange);
        deleted = scaled - added;
      } else {
        deleted = scale(deleted, graphWidth, maxChange);
        added = scaled - deleted;
      }
    }
    // @banned-pattern-ignore: added + deleted is at most the width of the diffstat after scaling
    out += `${"+".repeat(added)}${"-".repeat(deleted)}\n`;
  });
  return out + shortStat(diffs);
}

export function nameOnly(changes: readonly Change[]): string {
  return changes.map((change) => `${quotePath(change.path)}\n`).join("");
}

export function nameStatus(changes: readonly Change[]): string {
  return changes
    .map((change) =>
      change.status === "R"
        ? `R${String(change.similarity).padStart(3, "0")}\t${quotePath(change.oldPath ?? "")}\t${quotePath(change.path)}\n`
        : `${change.status}\t${quotePath(change.path)}\n`,
    )
    .join("");
}

/** The lines `git commit` prints after the diffstat line: created and deleted files, renames, and mode changes. */
export function summary(changes: readonly Change[]): string {
  let out = "";
  for (const change of changes) {
    const { before, after } = change;
    if (change.status === "A" && after !== undefined) {
      out += ` create mode ${octal(after.mode)} ${quotePath(change.path)}\n`;
    } else if (change.status === "D" && before !== undefined) {
      out += ` delete mode ${octal(before.mode)} ${quotePath(change.path)}\n`;
    } else if (change.status === "R") {
      out += ` rename ${displayName(change)} (${change.similarity}%)\n`;
    } else if (
      before !== undefined &&
      after !== undefined &&
      before.mode !== after.mode
    ) {
      out += ` mode change ${octal(before.mode)} => ${octal(after.mode)} ${quotePath(change.path)}\n`;
    }
  }
  return out;
}
