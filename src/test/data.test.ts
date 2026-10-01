import * as assert from "node:assert";
import { describeTable, hasTotalsRow, parseNumber, parseTable } from "../data";

suite("data", () => {
  test("parseNumber parses plain, grouped, percent, exponent and size numbers", () => {
    assert.strictEqual(parseNumber("42"), 42);
    assert.strictEqual(parseNumber(" -3 "), -3);
    assert.strictEqual(parseNumber("12.5"), 12.5);
    assert.strictEqual(parseNumber(".5"), 0.5);
    assert.strictEqual(parseNumber("1,234"), 1234);
    assert.strictEqual(parseNumber("1,234,567.5"), 1234567.5);
    assert.strictEqual(parseNumber("12.5%"), 12.5);
    assert.strictEqual(parseNumber("1e3"), 1000);
    assert.strictEqual(parseNumber("1.5K"), 1536);
    assert.strictEqual(parseNumber("12M"), 12 * 1024 ** 2);
    assert.strictEqual(parseNumber("3G"), 3 * 1024 ** 3);
    assert.strictEqual(parseNumber("4T"), 4 * 1024 ** 4);
    assert.strictEqual(parseNumber("2KiB"), 2048);
  });

  test("parseNumber parses sizes with a decimal comma, as du -h prints in some locales", () => {
    assert.strictEqual(parseNumber("1,5M"), 1.5 * 1024 ** 2);
    assert.strictEqual(parseNumber("4,0K"), 4096);
    assert.strictEqual(parseNumber("12,25G"), 12.25 * 1024 ** 3);
    assert.strictEqual(parseNumber("1,500M"), 1500 * 1024 ** 2);
  });

  test("parseNumber leaves other text alone", () => {
    for (const text of [
      "",
      "-",
      "abc",
      "1.2.3",
      "12,34",
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
      columns: ["name", "count"],
      rows: [
        ["Smith, J", 3],
        ['say "hi"', 4],
        ["plain", null],
      ],
    });
  });

  test("parses quoted numbers and newlines in CSV", () => {
    assert.deepStrictEqual(parseTable('a,b\n"x\ny","1,234"\r\nz,5', "csv").rows, [
      ["x\ny", 1234],
      ["z", 5],
    ]);
  });

  test("detects semicolon-separated values", () => {
    assert.deepStrictEqual(parseTable("fruit;kg\napples;12\npears;3"), {
      columns: ["fruit", "kg"],
      rows: [
        ["apples", 12],
        ["pears", 3],
      ],
    });
  });

  test("parses du -h output with decimal commas", () => {
    assert.deepStrictEqual(parseTable("44K\tsrc/test\n1,5M\tz.bin\n4,0K\ta\n").rows, [
      [44 * 1024, "src/test"],
      [1.5 * 1024 ** 2, "z.bin"],
      [4096, "a"],
    ]);
    assert.deepStrictEqual(parseTable("44K src/test\n1,5M z.bin\n", "whitespace").rows, [
      [44 * 1024, "src/test"],
      [1.5 * 1024 ** 2, "z.bin"],
    ]);
  });

  test("parses decimal commas in semicolon-separated values", () => {
    assert.deepStrictEqual(parseTable("a;1,5;x\nb;2,25;\nc;1,234;"), {
      columns: ["Column 1", "Column 2", "Column 3"],
      rows: [
        ["a", 1.5, "x"],
        ["b", 2.25, null],
        ["c", 1.234, null],
      ],
    });
    assert.deepStrictEqual(parseTable("a;1,5\nb;2,5"), {
      columns: ["Column 1", "Column 2"],
      rows: [
        ["a", 1.5],
        ["b", 2.5],
      ],
    });
    assert.deepStrictEqual(parseTable("name;share\nx;12,5%\ny;-0,25").rows, [
      ["x", 12.5],
      ["y", -0.25],
    ]);
  });

  test("keeps thousands separators in columns without decimal commas", () => {
    assert.deepStrictEqual(parseTable("a;12,345\nb;56,789").rows, [
      ["a", 12345],
      ["b", 56789],
    ]);
    assert.deepStrictEqual(parseTable("a 4,321\nb 1,234,567").rows, [
      ["a", 4321],
      ["b", 1234567],
    ]);
    // "1,234.5" can only have a thousands separator, so "12,5" is not a number here.
    assert.deepStrictEqual(parseTable('a,"1,234.5"\nb,"12,5"', "csv").rows, [
      ["a", 1234.5],
      ["b", "12,5"],
    ]);
    assert.deepStrictEqual(parseTable("x\t3,25\ny\t4", "tsv").rows, [
      ["x", 3.25],
      ["y", 4],
    ]);
  });

  test("parses TSV, keeping spaces in fields", () => {
    assert.deepStrictEqual(parseTable("12\tsrc/a b.ts\n1.5K\tREADME.md\n"), {
      columns: ["Column 1", "Column 2"],
      rows: [
        [12, "src/a b.ts"],
        [1536, "README.md"],
      ],
    });
  });

  test("parses TSV with unbalanced quotes", () => {
    assert.deepStrictEqual(parseTable('4\t"odd name\n8\tother', "tsv").rows, [
      [4, '"odd name'],
      [8, "other"],
    ]);
  });

  test("parses whitespace-separated output, the last column keeping its spaces", () => {
    const table = parseTable("  12 src/a b.ts\n 345 src/c.ts\n 357 total\n");
    assert.deepStrictEqual(table, {
      columns: ["Column 1", "Column 2"],
      rows: [
        [12, "src/a b.ts"],
        [345, "src/c.ts"],
        [357, "total"],
      ],
    });
  });

  test("parses ls -l output using the most common field count", () => {
    const table = parseTable(
      [
        "total 16",
        "-rw-r--r-- 1 fred staff 1234 Jan  1 12:00 a.txt",
        "-rw-r--r-- 1 fred staff 56 Feb 12 09:30 my notes.md",
        "drwxr-xr-x 3 fred staff 4096 Mar  3  2024 src",
      ].join("\n"),
      "whitespace",
    );
    assert.strictEqual(table.columns.length, 9);
    assert.deepStrictEqual(table.rows[0], ["total", 16, null, null, null, null, null, null, null]);
    assert.deepStrictEqual(table.rows[2]?.[8], "my notes.md");
    assert.deepStrictEqual(table.rows[3]?.[4], 4096);
  });

  test("parses aligned output with multi-word headers and empty cells", () => {
    const table = parseTable(
      [
        "CONTAINER ID   IMAGE     STATUS        PORTS     NAMES",
        "abc123         nginx     Up 2 hours    80/tcp    web",
        "def456         redis     Up 5 days               cache",
      ].join("\n"),
    );
    assert.deepStrictEqual(table, {
      columns: ["CONTAINER ID", "IMAGE", "STATUS", "PORTS", "NAMES"],
      rows: [
        ["abc123", "nginx", "Up 2 hours", "80/tcp", "web"],
        ["def456", "redis", "Up 5 days", null, "cache"],
      ],
    });
  });

  test("parses df output, matching multi-word header names to columns", () => {
    const table = parseTable(
      [
        "Filesystem      Size  Used Avail Use% Mounted on",
        "/dev/nvme0n1p2  468G  300G  145G  68% /",
        "tmpfs           7.8G     0  7.8G   0% /dev/shm",
      ].join("\n"),
    );
    assert.deepStrictEqual(table.columns, [
      "Filesystem",
      "Size",
      "Used",
      "Avail",
      "Use%",
      "Mounted on",
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

  test("uses a header for whitespace output with numeric columns", () => {
    assert.deepStrictEqual(parseTable("dir size\nsrc 12\ntest 3").columns, ["dir", "size"]);
  });

  test("parses a JSON array of objects, with the union of keys as columns", () => {
    assert.deepStrictEqual(parseTable('[{"a": "x", "b": 1}, {"b": "2", "c": true}]'), {
      columns: ["a", "b", "c"],
      rows: [
        ["x", 1, null],
        [null, 2, "true"],
      ],
    });
  });

  test("parses a JSON array of arrays with and without a header", () => {
    assert.deepStrictEqual(parseTable('[["lang", "loc"], ["ts", 120], ["css", 30]]'), {
      columns: ["lang", "loc"],
      rows: [
        ["ts", 120],
        ["css", 30],
      ],
    });
    assert.deepStrictEqual(parseTable('[["ts", 120], ["css", 30]]').columns, [
      "Column 1",
      "Column 2",
    ]);
  });

  test("parses a JSON object mapping names to numbers", () => {
    assert.deepStrictEqual(parseTable('{"ts": 120, "css": 30}'), {
      columns: ["name", "value"],
      rows: [
        ["ts", 120],
        ["css", 30],
      ],
    });
  });

  test("parses a JSON object wrapping an array, and one with column arrays", () => {
    assert.deepStrictEqual(parseTable('{"data": [{"k": "a", "v": 1}], "total": 1}'), {
      columns: ["k", "v"],
      rows: [["a", 1]],
    });
    assert.deepStrictEqual(parseTable('{"label": ["a", "b"], "count": [1, 2]}'), {
      columns: ["label", "count"],
      rows: [
        ["a", 1],
        ["b", 2],
      ],
    });
  });

  test("parses a JSON object mapping names to objects", () => {
    assert.deepStrictEqual(parseTable('{"2023": {"a": 1, "b": 2}, "2024": {"a": 3, "b": 4}}'), {
      columns: ["name", "a", "b"],
      rows: [
        ["2023", 1, 2],
        ["2024", 3, 4],
      ],
    });
  });

  test("names missing and duplicate header columns", () => {
    assert.deepStrictEqual(parseTable(",x,x\na,1,2").columns, ["Column 1", "x", "x (2)"]);
  });

  test("detects a header with years as column names", () => {
    assert.deepStrictEqual(parseTable("region,2024,2025\nNorth,10,14\nSouth,20,18"), {
      columns: ["region", "2024", "2025"],
      rows: [
        ["North", 10, 14],
        ["South", 20, 18],
      ],
    });
    assert.deepStrictEqual(parseTable("Alice,1990\nBob,1985").columns, ["Column 1", "Column 2"]);
    assert.deepStrictEqual(parseTable("apples,1500\npears,300").columns, ["Column 1", "Column 2"]);
  });

  test("treats a first row without a numeric column below it as data", () => {
    assert.deepStrictEqual(parseTable("a,b\nc,d"), {
      columns: ["Column 1", "Column 2"],
      rows: [
        ["a", "b"],
        ["c", "d"],
      ],
    });
  });

  test("throws helpful errors for empty or invalid data", () => {
    assert.throws(() => parseTable("  \n"), /empty.*Accepted formats/s);
    assert.throws(() => parseTable('{"a": '), /Could not parse the data as JSON.*Accepted/s);
    assert.throws(() => parseTable("[]"), /array is empty/);
    assert.throws(() => parseTable('{"data": []}'), /array is empty/);
    assert.throws(() => parseTable('a,"b', "csv"), /quoted field is not closed/);
  });

  test("describeTable summarizes columns and the first rows", () => {
    const table = parseTable(
      ["dir,size,note", "a,1,", "b,2,", "c,3,", "d,4,", "e,5,", "f,6,"].join("\n"),
    );
    assert.strictEqual(
      describeTable(table),
      [
        '6 rows; columns: "dir" (text), "size" (number), "note" (empty)',
        "First 5 rows:",
        '["a",1,null]',
        '["b",2,null]',
        '["c",3,null]',
        '["d",4,null]',
        '["e",5,null]',
      ].join("\n"),
    );
    assert.strictEqual(
      describeTable({ columns: ["x"], rows: [[1]] }),
      '1 row; columns: "x" (number)\nRows:\n[1]',
    );
  });

  test("describeTable points out text cells in numeric columns", () => {
    const table = {
      columns: ["size", "file"],
      rows: [
        [1, "a"],
        ["1,5X", "b"],
        [3, "c"],
      ],
    };
    assert.match(describeTable(table), /"size" \(number, 1 text cell: "1,5X"\), "file" \(text\)/);
    const many = {
      columns: ["n"],
      rows: [[1], [2], [3], [4], [5], ["a"], ["b"], ["c"], ["d"]],
    };
    assert.match(describeTable(many), /"n" \(number, 4 text cells: "a", "b", "c", …\)/);
  });

  test("hasTotalsRow recognizes a last row that sums up the others", () => {
    const wc = parseTable("  12 a.ts\n 345 b.ts\n  3 c.ts\n 360 total\n");
    assert.strictEqual(hasTotalsRow(wc, 1, [0]), true);
    assert.match(describeTable(wc), /The last row \("total"\) is a total of the others/);
    const cloc = parseTable(
      ["language,files,code", "TypeScript,10,1200", "CSS,2,300", "SUM:,12,1500"].join("\n"),
    );
    assert.strictEqual(hasTotalsRow(cloc, 0, [1, 2]), true);
    assert.match(describeTable(cloc), /The last row \("SUM:"\)/);
    // Within 1%.
    assert.strictEqual(
      hasTotalsRow(
        {
          columns: ["a", "b"],
          rows: [
            ["x", 50],
            ["y", 50.5],
            [" Total ", 100],
          ],
        },
        0,
        [1],
      ),
      true,
    );
  });

  test("hasTotalsRow needs a total label and a matching sum", () => {
    const table = (label: string, total: number) => ({
      columns: ["a", "b"],
      rows: [
        ["x", 10],
        ["y", 20],
        [label, total],
      ],
    });
    assert.strictEqual(hasTotalsRow(table("total", 31), 0, [1]), false);
    assert.strictEqual(hasTotalsRow(table("z", 30), 0, [1]), false);
    assert.strictEqual(hasTotalsRow(table("total", 30), 1, [0]), false);
    assert.strictEqual(
      hasTotalsRow(
        {
          columns: ["a", "b"],
          rows: [
            ["x", 10],
            ["total", 10],
          ],
        },
        0,
        [1],
      ),
      false,
    );
    assert.doesNotMatch(describeTable(table("total", 31)), /total of the others/);
  });
});
