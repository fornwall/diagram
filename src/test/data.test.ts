import * as assert from "node:assert";
import type { DataFormat } from "../chartSpec";
import { parseNumber, parseTable } from "../data";

/** Parses a table, with its columns by name. */
function parse(text: string, format?: DataFormat) {
  const table = parseTable(text, format);
  return { columns: table.columns.map((column) => column.name), rows: table.rows };
}

suite("data", () => {
  test("parseNumber parses plain, grouped, percent, exponent and size numbers", () => {
    const cases: [string, number, string?][] = [
      ["42", 42],
      [" -3 ", -3],
      ["12.5", 12.5],
      [".5", 0.5],
      ["1,234", 1234],
      ["1,234,567.5", 1234567.5],
      ["1e3", 1000],
      ["12.5%", 12.5, "%"],
      ["0B", 0, "bytes"],
      ["1.5K", 1536, "bytes"],
      ["12M", 12 * 1024 ** 2, "bytes"],
      ["3G", 3 * 1024 ** 3, "bytes"],
      ["4T", 4 * 1024 ** 4, "bytes"],
      ["2KiB", 2048, "bytes"],
      ["128Mi", 128 * 1024 ** 2, "bytes"],
      ["1,500M", 1500 * 1024 ** 2, "bytes"],
    ];
    for (const [text, value, unit] of cases) {
      assert.deepStrictEqual(parseNumber(text), unit === undefined ? { value } : { value, unit });
    }
  });

  test("parseNumber leaves other text alone", () => {
    for (const text of [
      "",
      "-",
      "abc",
      "1.2.3",
      "12,34",
      "1,5M",
      "2024-01-05",
      "1 234",
      "e3",
      "12X",
      "NaN",
    ]) {
      assert.strictEqual(parseNumber(text), undefined, text);
    }
  });

  test("parses CSV with a header and quoted fields", () => {
    const table = parseTable('name,count\n"Smith, J",3\n"say ""hi""",4\n\nplain,\n', "auto");
    assert.deepStrictEqual(table, {
      columns: [
        { name: "name", numeric: false },
        { name: "count", numeric: true },
      ],
      rows: [
        ["Smith, J", 3],
        ['say "hi"', 4],
        ["plain", null],
      ],
      header: true,
    });
  });

  test("parses quoted numbers and newlines in CSV", () => {
    assert.deepStrictEqual(parse('a,b\n"x\ny","1,234"\r\nz,5', "csv").rows, [
      ["x\ny", 1234],
      ["z", 5],
    ]);
  });

  test("strips a byte order mark before a quoted header", () => {
    assert.deepStrictEqual(parse('﻿"name","count"\n"a",1'), {
      columns: ["name", "count"],
      rows: [["a", 1]],
    });
  });

  test("detects semicolon-separated values, also as format csv", () => {
    const expected = {
      columns: ["fruit", "kg"],
      rows: [
        ["apples", 12],
        ["pears", 3],
      ],
    };
    assert.deepStrictEqual(parse("fruit;kg\napples;12\npears;3"), expected);
    assert.deepStrictEqual(parse("fruit;kg\napples;12\npears;3", "csv"), expected);
  });

  test("parses du -h output with decimal commas", () => {
    assert.deepStrictEqual(parse("44K\tsrc/test\n1,5M\tz.bin\n4,0K\ta\n").rows, [
      [44 * 1024, "src/test"],
      [1.5 * 1024 ** 2, "z.bin"],
      [4096, "a"],
    ]);
    assert.deepStrictEqual(parse("44K src/test\n1,5M z.bin\n", "whitespace").rows, [
      [44 * 1024, "src/test"],
      [1.5 * 1024 ** 2, "z.bin"],
    ]);
  });

  test("parses decimal commas in semicolon-separated values", () => {
    assert.deepStrictEqual(parse("a;1,5;x\nb;2,25;\nc;1,234;"), {
      columns: ["Column 1", "Column 2", "Column 3"],
      rows: [
        ["a", 1.5, "x"],
        ["b", 2.25, null],
        ["c", 1.234, null],
      ],
    });
    assert.deepStrictEqual(parse("a;1,5\nb;2,5").rows, [
      ["a", 1.5],
      ["b", 2.5],
    ]);
    assert.deepStrictEqual(parse("name;share\nx;12,5%\ny;-0,25").rows, [
      ["x", 12.5],
      ["y", -0.25],
    ]);
    // As exported by Excel in many European locales.
    assert.deepStrictEqual(parse("Name;Amount\nA;1.234,56\nB;999,00").rows, [
      ["A", 1234.56],
      ["B", 999],
    ]);
  });

  test("keeps thousands separators in columns without decimal commas", () => {
    assert.deepStrictEqual(parse("a;12,345\nb;56,789").rows, [
      ["a", 12345],
      ["b", 56789],
    ]);
    assert.deepStrictEqual(parse("a 4,321\nb 1,234,567").rows, [
      ["a", 4321],
      ["b", 1234567],
    ]);
    assert.deepStrictEqual(parse("apples 1,234\npears 5,678").rows, [
      ["apples", 1234],
      ["pears", 5678],
    ]);
    // "1,234.5" can only have a thousands separator, so "12,5" is not a number here.
    assert.deepStrictEqual(parse('a,"1,234.5"\nb,"12,5"', "csv").rows, [
      ["a", 1234.5],
      ["b", "12,5"],
    ]);
    assert.deepStrictEqual(parse("x\t3,25\ny\t4", "tsv").rows, [
      ["x", 3.25],
      ["y", 4],
    ]);
  });

  test("parses TSV, keeping spaces in fields", () => {
    assert.deepStrictEqual(parse("12\tsrc/a b.ts\n1.5K\tREADME.md\n"), {
      columns: ["Column 1", "Column 2"],
      rows: [
        [12, "src/a b.ts"],
        [1536, "README.md"],
      ],
    });
  });

  test("parses TSV with unbalanced quotes", () => {
    assert.deepStrictEqual(parse('4\t"odd name\n8\tother', "tsv").rows, [
      [4, '"odd name'],
      [8, "other"],
    ]);
  });

  test("parses whitespace-separated output, the last column keeping its spaces", () => {
    assert.deepStrictEqual(parse("  12 src/a b.ts\n 345 src/c.ts\n 357 total\n"), {
      columns: ["Column 1", "Column 2"],
      rows: [
        [12, "src/a b.ts"],
        [345, "src/c.ts"],
        [357, "total"],
      ],
    });
  });

  test("parses ls -l output, leaving out its total line", () => {
    const table = parse(
      [
        "total 16",
        "-rw-r--r-- 1 fred staff 1234 Jan  1 12:00 a.txt",
        "-rw-r--r-- 1 fred staff 56 Feb 12 09:30 my notes.md",
        "drwxr-xr-x 3 fred staff 4096 Mar  3  2024 src",
      ].join("\n"),
    );
    assert.strictEqual(table.columns.length, 9);
    assert.strictEqual(table.rows.length, 3);
    assert.deepStrictEqual(table.rows[1]?.[8], "my notes.md");
    assert.deepStrictEqual(table.rows[2]?.[4], 4096);
  });

  test("parses ls -l output whose first file could pass for an aligned header", () => {
    const table = parse(
      [
        "total 12",
        "-rw-r--r--  1 fred staff  1234 Jan  1 12:00 a.txt",
        "-rw-r--r--  1 fred staff  5678 Feb  2 09:30 my notes.md",
        "drwxr-xr-x  3 fred staff  4096 Mar  3 10:15 src",
      ].join("\n"),
    );
    assert.strictEqual(table.rows.length, 3);
    assert.deepStrictEqual(
      table.rows.map((row) => [row[4], row[8]]),
      [
        [1234, "a.txt"],
        [5678, "my notes.md"],
        [4096, "src"],
      ],
    );
  });

  test("parses aligned output with multi-word headers and empty cells", () => {
    assert.deepStrictEqual(
      parse(
        [
          "CONTAINER ID   IMAGE     STATUS        PORTS     NAMES",
          "abc123         nginx     Up 2 hours    80/tcp    web",
          "def456         redis     Up 5 days               cache",
        ].join("\n"),
      ),
      {
        columns: ["CONTAINER ID", "IMAGE", "STATUS", "PORTS", "NAMES"],
        rows: [
          ["abc123", "nginx", "Up 2 hours", "80/tcp", "web"],
          ["def456", "redis", "Up 5 days", null, "cache"],
        ],
      },
    );
  });

  test("parses docker ps output with commas in a column", () => {
    const table = parse(
      [
        "CONTAINER ID   IMAGE     STATUS       PORTS                               NAMES",
        "3f4e5d6c7b8a   nginx     Up 2 hours   0.0.0.0:80->80/tcp, :::80->80/tcp   web",
        "9a8b7c6d5e4f   redis     Up 5 days    6379/tcp                            cache",
      ].join("\n"),
    );
    assert.deepStrictEqual(table.columns, ["CONTAINER ID", "IMAGE", "STATUS", "PORTS", "NAMES"]);
    assert.deepStrictEqual(table.rows[0]?.[3], "0.0.0.0:80->80/tcp, :::80->80/tcp");
  });

  test("parses df -h output, matching multi-word header names to columns", () => {
    const table = parseTable(
      [
        "Filesystem      Size  Used Avail Use% Mounted on",
        "/dev/nvme0n1p2  468G  300G  145G  68% /",
        "tmpfs           7.8G     0  7.8G   0% /dev/shm",
      ].join("\n"),
    );
    assert.deepStrictEqual(table.columns, [
      { name: "Filesystem", numeric: false },
      { name: "Size", numeric: true, unit: "bytes" },
      { name: "Used", numeric: true, unit: "bytes" },
      { name: "Avail", numeric: true, unit: "bytes" },
      { name: "Use%", numeric: true, unit: "%" },
      { name: "Mounted on", numeric: false },
    ]);
    assert.deepStrictEqual(table.rows[1], [
      "tmpfs",
      7.8 * 1024 ** 3,
      0,
      7.8 * 1024 ** 3,
      0,
      "/dev/shm",
    ]);
  });

  test("parses free output, whose header has no name for the first column", () => {
    assert.deepStrictEqual(
      parse(
        [
          "               total        used        free      shared  buff/cache   available",
          "Mem:           15904        6458        1340         826        8105        9125",
          "Swap:           2047           0        2047",
        ].join("\n"),
      ),
      {
        columns: ["Column 1", "total", "used", "free", "shared", "buff/cache", "available"],
        rows: [
          ["Mem:", 15904, 6458, 1340, 826, 8105, 9125],
          ["Swap:", 2047, 0, 2047, null, null, null],
        ],
      },
    );
  });

  test("takes a percentage unit from the column name", () => {
    const table = parseTable("USER PID %CPU %MEM COMMAND\nroot 1 0.0 0.1 init\nfred 42 3.5 1.2 vi");
    assert.deepStrictEqual(table.columns[2], { name: "%CPU", numeric: true, unit: "%" });
    assert.deepStrictEqual(table.columns[1], { name: "PID", numeric: true });
  });

  test("uses a header for whitespace output with numeric columns", () => {
    assert.deepStrictEqual(parse("dir size\nsrc 12\ntest 3").columns, ["dir", "size"]);
  });

  test("parses 200,000 rows", () => {
    const lines = Array.from({ length: 200_000 }, (_, i) => `row ${i} /a`);
    assert.strictEqual(parse(lines.join("\n")).rows.length, 200_000);
    assert.strictEqual(parse(lines.join("\n").replaceAll(" ", ",")).rows.length, 200_000);
    const df = parse(["Name Size Mounted on", ...lines].join("\n"));
    assert.deepStrictEqual(df.columns, ["Name", "Size", "Mounted on"]);
  });

  test("parses a JSON array of objects, with the union of keys as columns", () => {
    assert.deepStrictEqual(parse('[{"a": "x", "b": 1}, {"b": "2", "c": true}]'), {
      columns: ["a", "b", "c"],
      rows: [
        ["x", 1, null],
        [null, 2, "true"],
      ],
    });
  });

  test("parses newline-delimited JSON", () => {
    assert.deepStrictEqual(parse('{"name": "a", "n": 1}\n{"name": "b", "n": 2}\n'), {
      columns: ["name", "n"],
      rows: [
        ["a", 1],
        ["b", 2],
      ],
    });
  });

  test("parses a JSON array of arrays with and without a header", () => {
    assert.deepStrictEqual(parse('[["lang", "loc"], ["ts", 120], ["css", 30]]'), {
      columns: ["lang", "loc"],
      rows: [
        ["ts", 120],
        ["css", 30],
      ],
    });
    assert.deepStrictEqual(parse('[["ts", 120], ["css", 30]]').columns, ["Column 1", "Column 2"]);
  });

  test("parses a JSON object mapping names to numbers", () => {
    assert.deepStrictEqual(parse('{"ts": 120, "css": 30}'), {
      columns: ["name", "value"],
      rows: [
        ["ts", 120],
        ["css", 30],
      ],
    });
  });

  test("parses a JSON object wrapping an array, and one with column arrays", () => {
    const rows = { columns: ["k", "v"], rows: [["a", 1]] };
    assert.deepStrictEqual(parse('{"data": [{"k": "a", "v": 1}], "total": 1}'), rows);
    assert.deepStrictEqual(parse('{"items": [{"k": "a", "v": 1}], "errors": []}'), rows);
    assert.deepStrictEqual(parse('{"label": ["a", "b"], "count": [1, 2]}'), {
      columns: ["label", "count"],
      rows: [
        ["a", 1],
        ["b", 2],
      ],
    });
  });

  test("parses a JSON object mapping names to objects", () => {
    assert.deepStrictEqual(parse('{"2023": {"a": 1, "b": 2}, "2024": {"a": 3, "b": 4}}'), {
      columns: ["name", "a", "b"],
      rows: [
        [2023, 1, 2],
        [2024, 3, 4],
      ],
    });
  });

  test("names missing and duplicate header columns", () => {
    assert.deepStrictEqual(parse(",x,x\na,1,2").columns, ["Column 1", "x", "x (2)"]);
  });

  test("detects a header with years as column names", () => {
    assert.deepStrictEqual(parse("region,2024,2025\nNorth,10,14\nSouth,20,18"), {
      columns: ["region", "2024", "2025"],
      rows: [
        ["North", 10, 14],
        ["South", 20, 18],
      ],
    });
    assert.deepStrictEqual(parse("Alice,1990\nBob,1985").columns, ["Column 1", "Column 2"]);
    assert.deepStrictEqual(parse("apples,1500\npears,300").columns, ["Column 1", "Column 2"]);
  });

  test("treats a first row without a numeric column below it as data", () => {
    const table = parseTable("a,b\nc,d");
    assert.strictEqual(table.header, false);
    assert.deepStrictEqual(table.rows, [
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("throws helpful errors for empty or invalid data", () => {
    assert.throws(() => parseTable("  \n"), /^Error: The data is empty\. Give JSON, CSV/);
    assert.throws(() => parseTable('{"a": '), /^Error: The data is not valid JSON: .*\.$/);
    assert.throws(() => parseTable("[]"), /array is empty/);
    assert.throws(() => parseTable('{"data": []}'), /array is empty/);
    assert.throws(() => parseTable("[{}]"), /holds no values/);
    assert.throws(
      () => parseTable('a,b\nc,"d\ne,f', "csv"),
      /^Error: The quoted field that starts on line 2 is not closed\.$/,
    );
  });
});
