// Reading the output of particular commands, which the general rules would read wrongly: ls -l,
// go test -bench, git diff --stat and top. Each split… function returns undefined unless the lines
// are that output.

import type { Records } from "./data";
import { parseNumber, type Unit } from "./dataNumber";

/** The summary under git diff --stat: "3 files changed, 9 insertions(+), 6 deletions(-)". */
const DIFF_STAT_SUMMARY =
  /^\s*\d+ files? changed(?:, \d+ insertions?\(\+\))?(?:, \d+ deletions?\(-\))?\s*$/;

/** The part of a git diff --stat line after its pipe: changed lines and a bar, or "Bin …". */
const DIFF_STAT_CHANGES = /^ +(?:(\d+)( [+-]+)?|Bin\b.*)$/;

/**
 * Splits the output of git diff --stat (" src/a.ts | 12 ++++--") into the files and their numbers
 * of changed lines, leaving out the bars, which are scaled to fit, and the summary below them.
 */
export function splitDiffStat(lines: string[]): Records | undefined {
  const summary = DIFF_STAT_SUMMARY.test(lines.at(-1) ?? "");
  const records: string[][] = [["File", "Changes"]];
  let bars = false;
  for (const line of summary ? lines.slice(0, -1) : lines) {
    const pipe = line.lastIndexOf("|");
    const [, changes, bar] = DIFF_STAT_CHANGES.exec(line.slice(pipe + 1)) ?? [];
    const file = line.slice(0, pipe).trim();
    if (pipe < 0 || file === "" || (changes === undefined && !line.includes("Bin"))) {
      return undefined;
    }
    bars ||= bar !== undefined;
    records.push([file, changes ?? ""]);
  }
  return records.length > 1 && (summary || bars) ? { records, header: true } : undefined;
}

/** A file's type and permissions, perhaps marked for an ACL, a security context or attributes. */
const LS_MODE = "[-bcdDlnpsw?][-rwxsStTlL]{9}[.+@]?";
/** A size, as "1234" or "4.0K" (-h), or a device's major and minor numbers: "8,   1". */
const LS_SIZE = String.raw`\d+, *\d+|0x[\da-f]+|\d[\d.,]*[A-Za-z]*`;
/**
 * A modification time: "Oct  4 14:02", "Oct  4  2025", "4 okt. 14:02" in other locales,
 * "Oct  4 14:02:33 2025" (-T), "2025-10-04 14:02" (long-iso), with seconds and a time zone
 * (full-iso), or "10-04 14:02" and "2024-10-04" (iso).
 */
const LS_TIME = [
  String.raw`\d{4}-\d\d-\d\d(?: +\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?: +[-+]\d{4})?)?`,
  String.raw`\d\d-\d\d +\d\d:\d\d`,
  String.raw`\S+ +\S+ +(?:\d{1,2}:\d\d(?::\d\d +\d{4})?|\d{4})`,
].join("|");
/**
 * A line of ls -l, with or without the group (as with -o or -g), and perhaps with the inode
 * (-i) and the number of blocks (-s, or -sh as "4.0K") before it.
 */
const LS_LINE = new RegExp(
  String.raw`^ *((?:\d[\d.,]*[A-Za-z]? +){0,2})(${LS_MODE}) +(\d+) +(\S+) +(?:(\S+) +)?(${LS_SIZE}) +(${LS_TIME}) +(.+)$`,
);

/**
 * Names the number that ls -s or -i prints first in each of `files`: blocks if each could be the
 * 512- or 1024-byte blocks that hold its file's size, or else inodes if they are unique.
 */
function lsNumberName(files: string[][]): string {
  const numbers = files.map(([number = ""]) => number);
  if (numbers.some((number) => !/^\d+$/.test(number))) return "Blocks";
  let sized = false;
  const holdSizes = files.every((file, i) => {
    const size = parseNumber(file.at(-3) ?? "", { sizes: true })?.value;
    if (size === undefined) return true;
    sized = true;
    // Allowing for the rounding up to whole blocks of a file system, or for preallocation.
    return Number(numbers[i]) * 1024 <= 2 * size + 65536;
  });
  if (sized && holdSizes) return "Blocks";
  return new Set(numbers).size === numbers.length ? "Inode" : "";
}

/**
 * Splits the output of ls -l, as GNU and BSD ls print it, into named columns, leaving out the
 * "total" lines and the headings of directories ("src:"). The names of symbolic links leave out
 * their targets ("bin -> usr/bin"). Returns undefined unless every other line is a file.
 */
export function splitLs(lines: string[]): Records | undefined {
  const files: string[][] = [];
  let count: number | undefined;
  let groups = false;
  for (const line of lines) {
    const match = LS_LINE.exec(line);
    if (match === null) {
      if (/^\S+ +\d[\d.,]*[A-Za-z]*$|:$/.test(line)) continue;
      return undefined;
    }
    const [, numbers = "", mode = "", links = "", owner = "", group, size = "", time = ""] = match;
    const leading = numbers === "" ? [] : numbers.trimEnd().split(/ +/);
    count ??= leading.length;
    if (leading.length !== count) return undefined;
    groups ||= group !== undefined;
    const file = (match[8] ?? "").trimEnd();
    files.push([
      ...leading,
      mode,
      links,
      owner,
      group ?? "",
      size.replace(/, +/, ", "),
      time.replace(/ +/g, " "),
      mode.startsWith("l") ? (file.split(" -> ")[0] ?? file) : file,
    ]);
  }
  if (count === undefined) {
    return undefined;
  }
  const leading = count === 2 ? ["Inode", "Blocks"] : count === 1 ? [lsNumberName(files)] : [];
  const header = [...leading, "Mode", "Links", "Owner", "Group", "Size", "Modified", "Name"];
  if (!groups) {
    for (const record of [header, ...files]) record.splice(count + 3, 1);
  }
  // Blocks are sizes too when printed with units, as by ls -sh.
  const units = header.map((name, column): Unit | undefined =>
    name === "Size" ||
    (name === "Blocks" && files.some((file) => /[A-Za-z]$/.test(file[column] ?? "")))
      ? "bytes"
      : undefined,
  );
  return { records: [header, ...files], header: true, units };
}

/** A result of go test -bench: a name, its iterations and measures ("1234 ns/op", "56 B/op"). */
const GO_BENCHMARK = /^(Benchmark\S+)\s+(\d+)((?:\s+\d+(?:\.\d+)? \S+)+)\s*$/;

/**
 * A line of go test -bench around the results: a heading ("goos: linux"), the end of the run
 * ("PASS", "ok"), the name that -v prints before each result, or what a benchmark logged, under
 * "--- BENCH:" and indented ("    parse_test.go:12: warm cache").
 */
const GO_BENCHMARK_OTHER = /^(?:\w+: |PASS$|FAIL\b|ok\s|Benchmark\S+$|--- \w+: |\s)/;

/**
 * Splits the output of go test -bench into a column for each measure, named by its unit, with the
 * time per operation in seconds and the memory in bytes, leaving out the other lines of the run.
 * Returns undefined unless every other line is one of those.
 */
export function splitGoBenchmarks(lines: string[]): Records | undefined {
  const header = ["Benchmark", "Iterations"];
  const records = [header];
  for (const line of lines) {
    const [, name = "", iterations = "", measures] = GO_BENCHMARK.exec(line) ?? [];
    if (measures === undefined) {
      if (GO_BENCHMARK_OTHER.test(line)) continue;
      return undefined;
    }
    const record = [name, iterations];
    for (const [, value = "", unit = ""] of measures.matchAll(/(\S+) (\S+)/g)) {
      const column = unit === "ns/op" ? "time/op" : unit;
      if (!header.includes(column)) header.push(column);
      record[header.indexOf(column)] = unit === "ns/op" ? `${value}ns` : value;
    }
    records.push(record);
  }
  const units = header.map((name): Unit | undefined => (name === "B/op" ? "bytes" : undefined));
  return records.length > 1 ? { records, header: true, units } : undefined;
}

/** The columns of top's processes that hold sizes, as VIRT and RES. */
const TOP_SIZES = new Set(["VIRT", "RES", "SHR", "SWAP", "CODE", "DATA", "USED"]);

/**
 * Reads the sizes of the processes that procps top lists in KiB, or in larger units after a
 * lowercase letter, as "1.2g", as bytes.
 */
export function topSizes(table: Records): Records {
  const [header = [], ...rows] = table.records;
  const units = header.map((name): Unit | undefined =>
    TOP_SIZES.has(String(name)) ? "bytes" : undefined,
  );
  for (const row of rows) {
    for (const [column, cell] of row.entries()) {
      if (units[column] !== undefined && typeof cell === "string") {
        row[column] = cell.replace(
          /^(\d+(?:\.\d+)?)([mgtpe]?)$/,
          (_, size: string, unit: string) => `${size}${(unit || "k").toUpperCase()}i`,
        );
      }
    }
  }
  return { ...table, units };
}
