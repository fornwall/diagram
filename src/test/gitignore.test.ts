import * as assert from "node:assert";
import { type IgnoreFiles, ignoredGlobs, ignoreMatcher, ignoreRules } from "../gitignore";
import { assertLinearTime } from "./afterTest";

/** The paths that the ignore files, given by folder, ignore. */
function ignoredOf(files: Record<string, string>, paths: readonly string[]): string[] {
  const ignored = ignoreMatcher(ignoreFilesOf(files));
  return paths.filter((path) => ignored(path));
}

function ignoreFilesOf(files: Record<string, string>): IgnoreFiles {
  return new Map(Object.entries(files).map(([folder, text]) => [folder, ignoreRules(text)]));
}

suite("gitignore", () => {
  test("matches names at any depth and paths with a slash relative to their folder", () => {
    assert.deepStrictEqual(
      ignoredOf({ "": "*.log\n/top.txt\ndocs/*.md\nbuild/\n" }, [
        "a.log",
        "deep/er/b.log",
        "top.txt",
        "sub/top.txt",
        "docs/a.md",
        "docs/deep/a.md",
        "sub/docs/a.md",
        "build/out.js",
        "sub/build/out.js",
        "build",
      ]),
      ["a.log", "deep/er/b.log", "top.txt", "docs/a.md", "build/out.js", "sub/build/out.js"],
    );
  });

  test("matches ** as any number of folders, and other wildcards within a name", () => {
    assert.deepStrictEqual(
      ignoredOf({ "": "**/gen\na/**/b\nlogs/**\nf?o\n[!x]y\n*.[ch]\n.*rc\n" }, [
        "gen/a",
        "x/gen/a",
        "a/b",
        "a/x/y/b",
        "logs/a/b",
        "logs",
        "foo",
        "fo",
        "zy",
        "xy",
        "s.c",
        "s.d",
        ".npmrc",
      ]),
      ["gen/a", "x/gen/a", "a/b", "a/x/y/b", "logs/a/b", "foo", "zy", "s.c", ".npmrc"],
    );
  });

  test("matches the classes that brackets name as git does, and nothing for an unknown one", () => {
    const files = { "": "v[[:digit:]]\nw[![:alpha:]_]\nx[[:punct:]]\ny[:]\nz[[:nope:]]\n" };
    assert.deepStrictEqual(
      ignoredOf(files, ["v1", "vx", "w1", "wa", "w_", "x!", "x`", "x~", "xa", "y:", "y]", "z1"]),
      ["v1", "w1", "x!", "x`", "x~", "y:"],
    );
    // Globs, by which a search excludes, have no such classes.
    assert.deepStrictEqual(ignoredGlobs(ignoreFilesOf({ "": "v[[:digit:]]\n" })), []);
  });

  test("includes again with !, except in an ignored folder, and deeper files override", () => {
    const files = {
      "": "*.log\n!keep.log\nout/\n!out/a.js\n.vscode/*\n!.vscode/settings.json\n",
      sub: "!*.log\n/local.txt\n",
    };
    assert.deepStrictEqual(
      ignoredOf(files, [
        "a.log",
        "keep.log",
        "x/keep.log",
        "out/a.js",
        ".vscode/tasks.json",
        ".vscode/settings.json",
        "sub/b.log",
        "sub/local.txt",
        "sub/deep/local.txt",
        "other/local.txt",
      ]),
      ["a.log", "out/a.js", ".vscode/tasks.json", "sub/local.txt"],
    );
  });

  test("reads comments, escapes and trailing spaces as git does", () => {
    assert.deepStrictEqual(
      ignoredOf({ "": "# comment\n\\#hash\n\\!bang\nspace\\ \ntrail   \n[z-a]\n\r\n" }, [
        "# comment",
        "#hash",
        "!bang",
        "space ",
        "space",
        "trail",
        "trail   ",
      ]),
      ["#hash", "!bang", "space ", "trail"],
    );
  });

  test("leaves malformed character classes and trailing escapes unmatched", () => {
    for (const pattern of ["a[", "[a", "[!]", "[]", "a\\"]) {
      assert.deepStrictEqual(ignoreRules(pattern), [], pattern);
    }
    assert.deepStrictEqual(ignoredOf({ "": "a\\[\n\\[a\na\\\\\n" }, ["a[", "[a", "a\\", "a"]), [
      "a[",
      "[a",
      "a\\",
    ]);
  });

  test("matches escaped path separators and recursive runs of stars as git does", () => {
    assert.deepStrictEqual(
      ignoredOf({ "": "a\\/b\nc/***/d\n" }, [
        "a/b",
        "a/b/file",
        "a\\/b",
        "c/d",
        "c/x/d",
        "c/x/y/d",
        "c/x/y/e",
      ]),
      ["a/b", "a/b/file", "c/d", "c/x/d", "c/x/y/d"],
    );
  });

  test("matches repeated wildcards without exponential backtracking", () => {
    const pattern = `${"*a".repeat(12)}b`;
    const name = "a".repeat(200);
    assert.deepStrictEqual(ignoredOf({ "": pattern }, [name, `${name}b`, `${"a".repeat(11)}b`]), [
      `${name}b`,
    ]);
    assert.deepStrictEqual(
      ignoredOf({ "": "*a*b/*a?b*c" }, ["aaab/aabc", "aaab/aabxbc", "aaab/abc"]),
      ["aaab/aabc", "aaab/aabxbc"],
    );
  });

  test("excludes what no ! pattern could include again, relative to each folder", () => {
    assert.deepStrictEqual(
      ignoredGlobs(
        ignoreFilesOf({
          "": "dist\n*.log\n!keep.log\n/out/\na\\ b\n{x}\n",
          "pkg/[id]": "cache/\n/local.txt\n*.tmp\n",
          "pkg/[id]/deep": "!c.tmp\n",
          "{odd}": "never\n",
        }),
      ),
      [
        "**/dist",
        "**/dist/**",
        "out/**",
        "pkg/[[]id[]]/**/cache/**",
        "pkg/[[]id[]]/local.txt",
        "pkg/[[]id[]]/local.txt/**",
      ],
    );
  });

  test("excludes by many ignore files with ! patterns in linear time", () => {
    // As where each of many folders is kept in git by an ignore file of "*" and "!.gitignore".
    const ignoreFiles = (count: number) => {
      const files = new Map([["", ignoreRules("dist/\n*.log\n")]]);
      for (let index = 0; index < count; index++) {
        files.set(
          `packages/p${index % 50}/f${index}`,
          ignoreRules("*.tmp\ncache/\n*\n!.gitignore\n"),
        );
      }
      return files;
    };
    assertLinearTime((count) => {
      const files = ignoreFiles(count);
      return () => ignoredGlobs(files);
    }, 750);
    const globs = ignoredGlobs(ignoreFiles(3000));
    // The ! patterns below include again only what is named ".gitignore".
    assert.deepStrictEqual(globs.slice(0, 4), [
      "**/dist/**",
      "**/*.log",
      "**/*.log/**",
      "packages/p0/f0/**/*.tmp",
    ]);
  });
});
