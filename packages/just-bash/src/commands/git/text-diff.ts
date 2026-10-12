/**
 * Line differences in the form git prints them: the changed line groups are
 * placed by the rules of git's xdiff (slide each group as far down as it
 * goes, then apply the indent heuristic), and the hunks carry three lines of
 * context and the function line of the hunk header.
 *
 * Lines are strings with one character for each byte.
 */
import { diffArrays } from "diff";

const CONTEXT = 3;
const BINARY_PROBE_BYTES = 8000;

/** Whether git treats content as binary: a NUL byte in its first 8000 bytes. */
export function isBinary(content: Uint8Array): boolean {
  const end = Math.min(content.length, BINARY_PROBE_BYTES);
  for (let i = 0; i < end; i++) {
    if (content[i] === 0) return true;
  }
  return false;
}

/** The bytes of content as a string with one character for each byte. */
export function byteString(content: Uint8Array): string {
  let text = "";
  const step = 0x8000;
  for (let i = 0; i < content.length; i += step) {
    text += String.fromCharCode(...content.subarray(i, i + step));
  }
  return text;
}

/** The lines of text, each with its line feed; the last line has none when text does not end with one. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    if (end === -1) {
      lines.push(text.slice(start));
      break;
    }
    lines.push(text.slice(start, end + 1));
    start = end + 1;
  }
  return lines;
}

// ---- Placement of change groups (xdiff's xdl_change_compact) ----

interface Side {
  readonly lines: readonly string[];
  /** Whether each line is changed; one more element than lines, always false. */
  readonly changed: boolean[];
}

interface Group {
  start: number;
  end: number;
}

function firstGroup(side: Side): Group {
  let end = 0;
  while (side.changed[end]) end++;
  return { start: 0, end };
}

function nextGroup(side: Side, group: Group): boolean {
  if (group.end === side.lines.length) return false;
  group.start = group.end + 1;
  group.end = group.start;
  while (side.changed[group.end]) group.end++;
  return true;
}

function previousGroup(side: Side, group: Group): boolean {
  if (group.start === 0) return false;
  group.end = group.start - 1;
  group.start = group.end;
  while (group.start > 0 && side.changed[group.start - 1]) group.start--;
  return true;
}

function slideUp(side: Side, group: Group): boolean {
  if (
    group.start > 0 &&
    side.lines[group.start - 1] === side.lines[group.end - 1]
  ) {
    side.changed[--group.start] = true;
    side.changed[--group.end] = false;
    while (group.start > 0 && side.changed[group.start - 1]) group.start--;
    return true;
  }
  return false;
}

function slideDown(side: Side, group: Group): boolean {
  if (
    group.end < side.lines.length &&
    side.lines[group.start] === side.lines[group.end]
  ) {
    side.changed[group.start++] = false;
    side.changed[group.end++] = true;
    while (side.changed[group.end]) group.end++;
    return true;
  }
  return false;
}

const INDENT_LIMIT = 200;
const BLANK_LIMIT = 20;
const SLIDING_LIMIT = 100;

/** The indentation of a line in columns; -1 for a line of white space only. */
function indentOf(line: string): number {
  let indent = 0;
  for (let i = 0; i < line.length; i++) {
    const character = line[i];
    if (character === " ") indent += 1;
    else if (character === "\t") indent += 8 - (indent % 8);
    else if (
      character !== "\n" &&
      character !== "\r" &&
      character !== "\v" &&
      character !== "\f"
    ) {
      return indent;
    }
    if (indent >= INDENT_LIMIT) return INDENT_LIMIT;
  }
  return -1;
}

interface Score {
  effectiveIndent: number;
  penalty: number;
}

/** Adds to score the badness of a split of the lines before index `split`; the constants are xdiff's. */
function scoreSplit(lines: readonly string[], split: number, score: Score) {
  const endOfFile = split >= lines.length;
  const indent = endOfFile ? -1 : indentOf(lines[split]);
  let preBlank = 0;
  let preIndent = -1;
  for (let i = split - 1; i >= 0; i--) {
    preIndent = indentOf(lines[i]);
    if (preIndent !== -1) break;
    preBlank += 1;
    if (preBlank === BLANK_LIMIT) {
      preIndent = 0;
      break;
    }
  }
  let postBlank = 0;
  let postIndent = -1;
  for (let i = split + 1; i < lines.length; i++) {
    postIndent = indentOf(lines[i]);
    if (postIndent !== -1) break;
    postBlank += 1;
    if (postBlank === BLANK_LIMIT) {
      postIndent = 0;
      break;
    }
  }
  if (preIndent === -1 && preBlank === 0) score.penalty += 1;
  if (endOfFile) score.penalty += 21;
  const blanksAfter = indent === -1 ? 1 + postBlank : 0;
  const totalBlank = preBlank + blanksAfter;
  score.penalty += -30 * totalBlank;
  score.penalty += 6 * blanksAfter;
  const effective = indent !== -1 ? indent : postIndent;
  const anyBlanks = totalBlank !== 0;
  score.effectiveIndent += effective;
  if (effective === -1 || preIndent === -1) return;
  if (effective > preIndent) score.penalty += anyBlanks ? 10 : -4;
  else if (effective < preIndent) {
    if (postIndent !== -1 && postIndent > effective) {
      score.penalty += anyBlanks ? 17 : 24;
    } else {
      score.penalty += anyBlanks ? 17 : 23;
    }
  }
}

function compareScores(a: Score, b: Score): number {
  const indents =
    Number(a.effectiveIndent > b.effectiveIndent) -
    Number(a.effectiveIndent < b.effectiveIndent);
  return 60 * indents + (a.penalty - b.penalty);
}

function compact(side: Side, other: Side): void {
  const group = firstGroup(side);
  const otherGroup = firstGroup(other);
  for (;;) {
    if (group.end !== group.start) {
      let size: number;
      let earliestEnd: number;
      let endMatchingOther: number;
      do {
        size = group.end - group.start;
        endMatchingOther = -1;
        while (slideUp(side, group)) previousGroup(other, otherGroup);
        earliestEnd = group.end;
        if (otherGroup.end > otherGroup.start) endMatchingOther = group.end;
        while (slideDown(side, group)) {
          nextGroup(other, otherGroup);
          if (otherGroup.end > otherGroup.start) endMatchingOther = group.end;
        }
      } while (size !== group.end - group.start);
      if (group.end !== earliestEnd) {
        if (endMatchingOther !== -1) {
          // Line the group up with the last change of the other file.
          while (otherGroup.end === otherGroup.start) {
            slideUp(side, group);
            previousGroup(other, otherGroup);
          }
        } else {
          let shift = Math.max(
            earliestEnd,
            group.end - size - 1,
            group.end - SLIDING_LIMIT,
          );
          let bestShift = -1;
          let bestScore: Score = { effectiveIndent: 0, penalty: 0 };
          for (; shift <= group.end; shift++) {
            const score: Score = { effectiveIndent: 0, penalty: 0 };
            scoreSplit(side.lines, shift, score);
            scoreSplit(side.lines, shift - size, score);
            if (bestShift === -1 || compareScores(score, bestScore) <= 0) {
              bestScore = score;
              bestShift = shift;
            }
          }
          while (group.end > bestShift) {
            slideUp(side, group);
            previousGroup(other, otherGroup);
          }
        }
      }
    }
    if (!nextGroup(side, group)) break;
    nextGroup(other, otherGroup);
  }
}

// ---- Hunks ----

export interface TextDiff {
  /** The hunks as printed, from the first `@@` line on; empty for equal content. */
  readonly text: string;
  readonly insertions: number;
  readonly deletions: number;
}

const NO_NEWLINE = "\\ No newline at end of file\n";

/** The line of a hunk: its marker, the line, and the note for a last line without a line feed. */
function hunkLine(marker: string, line: string): string {
  return line.endsWith("\n")
    ? marker + line
    : `${marker + line}\n${NO_NEWLINE}`;
}

/** The text git puts after `@@` for a line that starts a function: a line whose first byte is a letter, `_`, or `$`. */
function functionLine(line: string): string | undefined {
  if (!/^[A-Za-z_$]/.test(line)) return undefined;
  // git takes 80 bytes, removes white space at their end, and then removes
  // the bytes of a UTF-8 character that the 80 byte limit cut.
  const text = line.slice(0, 80).replace(/\s+$/, "");
  if (line.length <= 80 || text.length < 80) return text;
  let length = text.length;
  while (length > 0 && (text.charCodeAt(length - 1) & 0xc0) === 0x80) length--;
  const lead = text.charCodeAt(length - 1);
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return needed > text.length - length + 1 ? text.slice(0, length - 1) : text;
}

function range(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  return count === 1 ? `${start + 1}` : `${start + 1},${count}`;
}

/** The difference of two texts, each a string with one character for each byte. */
export function diffText(before: string, after: string): TextDiff {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const old: Side = {
    lines: oldLines,
    changed: new Array<boolean>(oldLines.length + 1).fill(false),
  };
  const fresh: Side = {
    lines: newLines,
    changed: new Array<boolean>(newLines.length + 1).fill(false),
  };
  let i = 0;
  let j = 0;
  for (const part of diffArrays(oldLines, newLines)) {
    if (part.removed) {
      for (let k = 0; k < part.value.length; k++) old.changed[i++] = true;
    } else if (part.added) {
      for (let k = 0; k < part.value.length; k++) fresh.changed[j++] = true;
    } else {
      i += part.value.length;
      j += part.value.length;
    }
  }
  compact(old, fresh);
  compact(fresh, old);

  // Blocks of changed lines: [oldStart, oldEnd) replaced by [newStart, newEnd).
  const blocks: [number, number, number, number][] = [];
  i = 0;
  j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (!old.changed[i] && !fresh.changed[j]) {
      i++;
      j++;
      continue;
    }
    const oldStart = i;
    const newStart = j;
    while (old.changed[i]) i++;
    while (fresh.changed[j]) j++;
    blocks.push([oldStart, i, newStart, j]);
  }

  let text = "";
  let insertions = 0;
  let deletions = 0;
  let functionName: string | undefined;
  let searched = -1;
  for (let first = 0; first < blocks.length; ) {
    let last = first;
    while (
      last + 1 < blocks.length &&
      blocks[last + 1][0] - blocks[last][1] <= 2 * CONTEXT
    ) {
      last++;
    }
    const oldStart = Math.max(blocks[first][0] - CONTEXT, 0);
    const oldEnd = Math.min(blocks[last][1] + CONTEXT, oldLines.length);
    const newStart = Math.max(blocks[first][2] - CONTEXT, 0);
    const newEnd = Math.min(blocks[last][3] + CONTEXT, newLines.length);
    for (let line = oldStart - 1; line > searched; line--) {
      const name = functionLine(oldLines[line]);
      if (name !== undefined) {
        functionName = name;
        break;
      }
    }
    searched = oldStart - 1;
    text += `@@ -${range(oldStart, oldEnd - oldStart)} +${range(newStart, newEnd - newStart)} @@${functionName === undefined ? "" : ` ${functionName}`}\n`;
    let position = oldStart;
    for (let block = first; block <= last; block++) {
      const [from, to, added, addedEnd] = blocks[block];
      for (; position < from; position++) {
        text += hunkLine(" ", oldLines[position]);
      }
      for (; position < to; position++) {
        text += hunkLine("-", oldLines[position]);
        deletions++;
      }
      for (let line = added; line < addedEnd; line++) {
        text += hunkLine("+", newLines[line]);
        insertions++;
      }
    }
    for (; position < oldEnd; position++) {
      text += hunkLine(" ", oldLines[position]);
    }
    first = last + 1;
  }
  return { text, insertions, deletions };
}
