// What .gitignore files ignore, matched as git matches them.

/** A pattern of a .gitignore file, which matches paths relative to the folder of its file. */
export interface IgnoreRule {
  /** Whether the pattern starts with "!", which includes again what it matches. */
  negated: boolean;
  /** Whether the pattern ends with "/", which matches only folders. */
  folderOnly: boolean;
  pattern: RegExp;
  /** The name that the paths it matches end with, when the pattern gives it literally. */
  name: string | undefined;
  /** Matches the name that the paths it matches end with. */
  namePattern: RegExp;
  /** The globs that match what the pattern does and what is in it, if globs can say so. */
  globs: string[] | undefined;
}

/**
 * The .gitignore files of a workspace folder, by the path of the folder that each is in, relative
 * to the workspace folder: "" for the workspace folder itself.
 */
export type IgnoreFiles = ReadonlyMap<string, readonly IgnoreRule[]>;

/** The patterns of a .gitignore file, leaving out those that are invalid. */
export function ignoreRules(text: string): IgnoreRule[] {
  return text.split(/\r?\n/).flatMap((line) => {
    try {
      return ignoreRule(line) ?? [];
    } catch {
      // A range such as "[z-a]", which matches nothing.
      return [];
    }
  });
}

function ignoreRule(line: string): IgnoreRule | undefined {
  // Trailing spaces are left out, unless a backslash quotes them.
  let text = line.replace(/((?:^|[^\\])(?:\\\\)*) +$/, "$1");
  if (!text || text.startsWith("#")) return undefined;
  const negated = text.startsWith("!");
  if (negated) text = text.slice(1);
  const folderOnly = text.endsWith("/");
  if (folderOnly) text = text.slice(0, -1);
  // A pattern with a "/" before its end matches relative to its folder, others at any depth.
  const anchored = text.includes("/");
  text = text.replace(/^\//, "");
  if (!text) return undefined;
  const segments = text.split("/");
  let source = anchored ? "" : "(?:.*/)?";
  let separated = true;
  let last = { source: ".*", literal: undefined as string | undefined };
  for (const [index, segment] of segments.entries()) {
    // "**" as a whole name matches any number of folders: "a/**" what is in a.
    if (segment === "**") {
      source +=
        index < segments.length - 1
          ? `${separated ? "" : "/"}(?:.*/)?`
          : `${separated ? "" : "/"}.*`;
      last = { source: ".*", literal: undefined };
      separated = true;
    } else {
      last = segmentSource(segment);
      source += `${separated ? "" : "/"}${last.source}`;
      separated = false;
    }
  }
  const body = /[\\{},]/.test(text) || /[^/]\*\*|\*\*[^/]/.test(text) ? undefined : text;
  const glob = body === undefined ? undefined : anchored ? body : `**/${body}`;
  return {
    negated,
    folderOnly,
    pattern: new RegExp(`^${source}$`, "su"),
    name: last.literal,
    namePattern: new RegExp(`^${last.source}$`, "su"),
    globs: glob === undefined ? undefined : folderOnly ? [`${glob}/**`] : [glob, `${glob}/**`],
  };
}

/** A regular expression for a name in a pattern, and the name, if the pattern gives it literally. */
function segmentSource(segment: string): { source: string; literal: string | undefined } {
  const chars = [...segment];
  let source = "";
  let literal: string | undefined = "";
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? "";
    if (char === "\\" && index + 1 < chars.length) {
      index++;
      const quoted = chars[index] ?? "";
      source += RegExp.escape(quoted);
      if (literal !== undefined) literal += quoted;
      continue;
    }
    if (char === "*" || char === "?") {
      source += char === "*" ? "[^/]*" : "[^/]";
      literal = undefined;
      continue;
    }
    if (char === "[") {
      const end = classEnd(chars, index);
      if (end > 0) {
        source += classSource(chars.slice(index + 1, end));
        literal = undefined;
        index = end;
        continue;
      }
    }
    source += RegExp.escape(char);
    if (literal !== undefined) literal += char;
  }
  return { source, literal };
}

/** Where the bracket expression that starts at `start` ends, or -1 when it does not. */
function classEnd(chars: readonly string[], start: number): number {
  let index = start + 1;
  if (chars[index] === "!" || chars[index] === "^") index++;
  // A "]" first is one of the characters.
  if (chars[index] === "]") index++;
  for (; index < chars.length; index++) {
    if (chars[index] === "\\") index++;
    else if (chars[index] === "]") return index;
  }
  return -1;
}

/** A bracket expression, without its brackets, which never matches "/". */
function classSource(chars: readonly string[]): string {
  const negated = chars[0] === "!" || chars[0] === "^";
  let members = "";
  for (let index = negated ? 1 : 0; index < chars.length; index++) {
    const char = chars[index] ?? "";
    if (char === "\\" && index + 1 < chars.length) {
      index++;
      members += RegExp.escape(chars[index] ?? "");
    } else {
      members += char === "-" ? char : RegExp.escape(char);
    }
  }
  return negated ? `[^${members}/]` : `(?!/)[${members}]`;
}

/**
 * Whether git ignores a path, relative to the workspace folder, of a file or else a folder: whether
 * it or a folder it is in is ignored, as nothing in an ignored folder can be included again. The
 * answers for folders are kept, so it is to be used while the files stay the same, other than
 * gaining files in folders deeper than any it has answered for.
 */
export function ignoreMatcher(files: IgnoreFiles): (path: string, folder?: boolean) => boolean {
  const folders = new Map<string, boolean>();
  const folderIgnored = (folder: string): boolean => {
    let ignored = folders.get(folder);
    if (ignored === undefined) {
      ignored = decision(files, folder, true) === true;
      folders.set(folder, ignored);
    }
    return ignored;
  };
  return (path, folder = false) => {
    for (let end = path.indexOf("/"); end >= 0; end = path.indexOf("/", end + 1)) {
      if (folderIgnored(path.slice(0, end))) return true;
    }
    return folder ? folderIgnored(path) : decision(files, path, false) === true;
  };
}

/**
 * Whether the .gitignore files ignore a path, not looking at the folders it is in, if one of their
 * patterns matches: the last that does in the deepest file with one, as deeper files override.
 */
function decision(files: IgnoreFiles, path: string, folder: boolean): boolean | undefined {
  for (let end = path.lastIndexOf("/"); ; end = end > 0 ? path.lastIndexOf("/", end - 1) : -1) {
    const rules = files.get(end < 0 ? "" : path.slice(0, end));
    const relative = path.slice(end + 1);
    for (let index = (rules?.length ?? 0) - 1; index >= 0; index--) {
      const rule = rules?.[index];
      if (rule && (folder || !rule.folderOnly) && rule.pattern.test(relative)) {
        return !rule.negated;
      }
    }
    if (end < 0) return undefined;
  }
}

/**
 * Globs, relative to the workspace folder, that exclude what the .gitignore files ignore, such that
 * a search need not find it, which {@link ignoreMatcher} leaves out in any case. A pattern that a
 * later "!" pattern, or one in a deeper file, could include again in part, as it may match a path
 * with the same name, is left out, as are those that globs cannot say.
 */
export function ignoredGlobs(files: IgnoreFiles): string[] {
  // The negations of each file, and those of the files in folders below each folder, found from
  // the files up rather than for each folder, as a large repository may have many files.
  const negations = new Map<string, { rule: IgnoreRule; index: number }[]>();
  const deeper = new Map<string, IgnoreRule[]>();
  for (const [folder, rules] of files) {
    const negated = rules.flatMap((rule, index) => (rule.negated ? [{ rule, index }] : []));
    if (negated.length === 0) continue;
    negations.set(folder, negated);
    // Up to the workspace folder, which is "".
    for (let above = folder; above !== ""; ) {
      above = above.slice(0, Math.max(above.lastIndexOf("/"), 0));
      const list = deeper.get(above) ?? [];
      deeper.set(above, list);
      for (const { rule } of negated) list.push(rule);
    }
  }
  return [...files].flatMap(([folder, rules]) => {
    // The globs are joined in braces, in which VS Code takes the first "}" to end them.
    if (/[{}]/.test(folder)) return [];
    const prefix = folder ? `${folder.replace(/[[\]*?,]/g, "[$&]")}/` : "";
    const own = negations.get(folder) ?? [];
    const below = deeper.get(folder) ?? [];
    return rules.flatMap((rule, index) => {
      if (rule.negated || !rule.globs) return [];
      const overridden =
        own.some((negation) => negation.index > index && sameName(rule, negation.rule)) ||
        below.some((negation) => sameName(rule, negation));
      return overridden ? [] : rule.globs.map((glob) => prefix + glob);
    });
  });
}

/** Whether two patterns could match paths with the same name. */
function sameName(one: IgnoreRule, other: IgnoreRule): boolean {
  if (one.name !== undefined) return other.namePattern.test(one.name);
  if (other.name !== undefined) return one.namePattern.test(other.name);
  return true;
}
