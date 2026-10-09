import * as assert from "node:assert";
import { type IgnoreFiles, ignoredGlobs, ignoreMatcher, ignoreRules } from "../gitignore";

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
});
