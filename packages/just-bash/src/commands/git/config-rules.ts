/**
 * Which config values this git honours. A config key of a watched section
 * changes what git prints or stores; a value this git does not implement
 * ends the command, so that no setting is ignored without notice.
 */
import { isTrue } from "./repository.js";

type Rule = (value: string) => boolean;

const any: Rule = () => true;
const isFlag: Rule = (value) =>
  /^(?:true|yes|on|1|false|no|off|0|)$/i.test(value);
const isOn: Rule = (value) => isTrue(value);
const isOff: Rule = (value) => isFlag(value) && !isTrue(value);
const isCount: Rule = (value) => /^\d+$/.test(value);
const oneOf =
  (...values: string[]): Rule =>
  (value) =>
    values.includes(value.toLowerCase());
const notAlways: Rule = (value) => !/always/i.test(value);

/**
 * The accepted values of each known key. A key whose rule is `any`,
 * `isFlag`, or `isCount` is implemented, or changes nothing that the
 * implemented subcommands print; every other rule accepts the values that
 * mean git's default behaviour.
 */
const RULES = new Map<string, Rule>([
  // Implemented.
  ["diff.mnemonicprefix", isFlag],
  ["diff.noprefix", isFlag],
  ["diff.srcprefix", any],
  ["diff.dstprefix", any],
  ["diff.context", isCount],
  ["diff.interhunkcontext", isCount],
  ["diff.indentheuristic", isFlag],
  ["diff.renames", isFlag],
  ["status.renames", isFlag],
  ["status.short", isFlag],
  ["status.branch", isFlag],
  ["status.relativepaths", isFlag],
  // Only the default behaviour is implemented.
  ["diff.algorithm", oneOf("myers", "default")],
  ["diff.relative", isOff],
  ["diff.suppressblankempty", isOff],
  ["status.showuntrackedfiles", oneOf("normal")],
  ["status.showstash", isOff],
  ["status.aheadbehind", isOn],
  ["status.submodulesummary", isOff],
  ["status.displaycommentprefix", isOff],
  ["log.date", oneOf("default")],
  ["log.decorate", oneOf("auto", "false", "no", "off", "0")],
  ["log.abbrevcommit", isOff],
  ["log.showsignature", isOff],
  ["log.follow", isOff],
  ["log.showroot", isOn],
  ["format.pretty", oneOf("medium")],
  ["core.quotepath", isOn],
  ["core.abbrev", oneOf("auto", "7")],
  ["core.autocrlf", isOff],
  ["core.eol", oneOf("lf", "native")],
  ["core.filemode", isOn],
  ["core.symlinks", isOn],
  ["commit.gpgsign", isOff],
  ["commit.cleanup", oneOf("default", "whitespace")],
  ["i18n.commitencoding", oneOf("utf-8", "utf8")],
  ["i18n.logoutputencoding", oneOf("utf-8", "utf8")],
  ["advice.statushints", isOn],
  ["branch.sort", oneOf("refname")],
  // No effect on what the implemented subcommands print without a terminal.
  ["diff.tool", any],
  ["diff.guitool", any],
  ["diff.colormoved", any],
  ["diff.colormovedws", any],
  ["diff.wserrorhighlight", any],
  ["diff.wordregex", any],
  ["diff.autorefreshindex", any],
  ["diff.renamelimit", any],
  ["diff.dirstat", any],
  ["diff.ignoresubmodules", any],
  ["diff.submodule", any],
  ["log.mailmap", any],
  ["log.excludedecoration", any],
  ["log.graphcolors", any],
  ["log.initialdecorationset", any],
]);

/** Sections in which a key without a rule is rejected. */
const WATCHED = ["diff.", "status.", "log.", "i18n.", "include.", "includeif."];

/** Sections that set colors or columns: every value but one with `always` leaves the output without a terminal as it is. */
const TERMINAL = ["color.", "column."];

/** The first config setting this git does not honour, as `key=value`; undefined when it honours all. */
export function unsupportedSetting(
  values: ReadonlyMap<string, string>,
): string | undefined {
  for (const [key, value] of values) {
    const rule = RULES.get(key);
    const accepted =
      rule !== undefined
        ? rule(value)
        : TERMINAL.some((section) => key.startsWith(section))
          ? notAlways(value)
          : !WATCHED.some((section) => key.startsWith(section));
    if (!accepted) return `${key}=${value}`;
  }
  return undefined;
}
