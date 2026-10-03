import * as assert from "node:assert";
import type { DataFormat } from "../chartSpec";
import { findColumn, parseTable } from "../data";
import { parseJson } from "../dataJson";
import { parseNumber } from "../dataNumber";
import { splitText } from "../dataText";

/** Parses a table, with its columns by name. */
function parse(text: string, format?: DataFormat) {
  const table = parseTable(text, format);
  return { columns: table.columns.map((column) => column.name), rows: table.rows };
}

suite("data", () => {
  test("column lookup prefers exact names and otherwise ignores case and spaces", () => {
    const table = parseTable('[{"Value": 1, "value": 2}]');
    assert.strictEqual(findColumn(table, "value", "value"), 1);
    assert.strictEqual(findColumn(table, " VALUE ", "filter"), 0);
    assert.throws(
      () => findColumn(table, "missing", "facet"),
      /Unknown facet column.*Value.*value/,
    );
  });

  test("parses spaces between numbers and units in tabular exports", () => {
    const table = parseTable("name;size;share\na;1,5 MiB;12,5 %\nb;2\u00a0MiB;25\u202f%");
    assert.deepStrictEqual(table.rows, [
      ["a", 1.5 * 1024 ** 2, 12.5],
      ["b", 2 * 1024 ** 2, 25],
    ]);
    assert.deepStrictEqual(table.columns, [
      { name: "name", numeric: false },
      { name: "size", numeric: true, unit: "bytes" },
      { name: "share", numeric: true, unit: "%" },
    ]);
    assert.strictEqual(parseNumber("1\nMiB"), undefined);
  });

  test("parses tables with carriage-return line endings", () => {
    for (const newline of ["\r", "\r\n", "\n"]) {
      for (const delimiter of [",", ";", "\t", " "]) {
        const text = [
          ["name", "value"],
          ["a", "1"],
          ["b", "2"],
        ]
          .map((row) => row.join(delimiter))
          .join(newline);
        assert.deepStrictEqual(parse(text), {
          columns: ["name", "value"],
          rows: [
            ["a", 1],
            ["b", 2],
          ],
        });
      }
    }
  });

  test("rejects oversized records during parsing before converting cells", () => {
    const wide = Array.from({ length: 1100 }, () => 1);
    const rows = [wide, ...Array.from({ length: 1100 }, () => [1])];
    assert.throws(() => parseJson(JSON.stringify(rows)), /exceeding the 1,000,000 cell limit/);
    for (const format of ["csv", "tsv"] as const) {
      const delimiter = format === "csv" ? "," : "\t";
      assert.throws(
        () => splitText(rows.map((row) => row.join(delimiter)).join("\n"), format),
        /exceeding the 1,000,000 cell limit/,
      );
    }
  });

  test("an oversized CSV delimiter candidate does not reject a valid alternative", () => {
    const label = `${"a,".repeat(1100)}z`;
    for (const quoted of [false, true]) {
      const field = quoted ? `"${label}"` : label;
      const text = `name,meta;value\n${`${field};1\n`.repeat(1100)}`;
      for (const format of ["auto", "csv"] as const) {
        const table = parseTable(text, format);
        assert.deepStrictEqual(
          table.columns.map(({ name }) => name),
          ["name,meta", "value"],
        );
        assert.strictEqual(table.rows.length, 1100);
        assert.deepStrictEqual(table.rows[0], [label, 1]);
      }
    }
  });

  test("rejects sparse data before expanding it into an oversized table", () => {
    const json = JSON.stringify(Array.from({ length: 1100 }, (_, i) => ({ [`field${i}`]: i })));
    const csv = `${Array.from({ length: 1100 }, (_, i) => `field${i}`).join(",")}\n${"1\n".repeat(1100)}`;
    for (const [text, format] of [
      [json, "json"],
      [csv, "csv"],
    ] as const) {
      assert.throws(
        () => parseTable(text, format),
        /exceeding the 1,000,000 cell limit\. Select fewer rows or columns/,
      );
    }
  });

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
      ["0Bi", 0, "bytes"],
      ["1.5kB", 1500, "bytes"],
      ["187MB", 187e6, "bytes"],
      ["2GB", 2e9, "bytes"],
      ["$1,234.50", 1234.5],
      ["-€5", -5],
      ["\u22124", -4],
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
      "$",
      "5$",
    ]) {
      assert.strictEqual(parseNumber(text), undefined, text);
    }
  });

  test("parseNumber rejects overflow, including after converting byte units", () => {
    for (const value of ["1e309", "1e308K", "-1e308MB", "1e300EiB"]) {
      assert.strictEqual(parseNumber(value), undefined, value);
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

  test("detects quoted single-column CSV, preserving records and reading numeric values", () => {
    assert.deepStrictEqual(parse('"value"\n"1"\n"2"'), {
      columns: ["value"],
      rows: [[1], [2]],
    });
    assert.deepStrictEqual(parse('"value"\n"1,5"\n"2,5"'), {
      columns: ["value"],
      rows: [[1.5], [2.5]],
    });
    assert.deepStrictEqual(parse('"first\nrecord"\n"second ""quoted"" record"'), {
      columns: ["Column 1"],
      rows: [["first\nrecord"], ['second "quoted" record']],
    });
  });

  test("parses prices", () => {
    assert.deepStrictEqual(parse('item,price\nsoup,$4.50\nbread,"$1,200"'), {
      columns: ["item", "price"],
      rows: [
        ["soup", 4.5],
        ["bread", 1200],
      ],
    });
    assert.deepStrictEqual(parse("item;price\nsoup;€4,50").rows, [["soup", 4.5]]);
  });

  test("parses quoted numbers and newlines in CSV", () => {
    assert.deepStrictEqual(parse('a,b\n"x\ny","1,234"\r\nz,5', "csv").rows, [
      ["x\ny", 1234],
      ["z", 5],
    ]);
  });

  test("rule-looking lines inside quoted fields do not turn data into a header", () => {
    for (const [format, delimiter] of [
      ["csv", ","],
      ["tsv", "\t"],
    ] as const) {
      const table = parseTable(`"a\n---\nb"${delimiter}2\nc${delimiter}3`, format);
      assert.strictEqual(table.header, false);
      assert.deepStrictEqual(table.rows, [
        ["a\n---\nb", 2],
        ["c", 3],
      ]);
    }
  });

  test("strips a byte order mark before a quoted header", () => {
    assert.deepStrictEqual(parse('﻿"name","count"\n"a",1'), {
      columns: ["name", "count"],
      rows: [["a", 1]],
    });
  });

  test("quoted rule-looking cells remain data", () => {
    assert.deepStrictEqual(parse('"label"\n"---"\n"x"', "csv").rows, [["label"], ["---"], ["x"]]);
    assert.deepStrictEqual(parse('a\tb\n"---"\t"---"\nx\ty', "tsv").rows, [
      ["a", "b"],
      ["---", "---"],
      ["x", "y"],
    ]);
  });

  test("parses CSV whose lines have different numbers of fields", () => {
    const cloc =
      'files,language,blank,code,"github.com/AlDanial/cloc v 1.98  T=0.05 s"\n' +
      "3,TypeScript,50,400\n2,CSS,10,100\n5,SUM,60,500";
    assert.deepStrictEqual(parse(cloc), {
      columns: ["files", "language", "blank", "code", "github.com/AlDanial/cloc v 1.98  T=0.05 s"],
      rows: [
        [3, "TypeScript", 50, 400, null],
        [2, "CSS", 10, 100, null],
        [5, "SUM", 60, 500, null],
      ],
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

  test("reports unclosed CSV quotes instead of falling back to whitespace", () => {
    for (const format of ["auto", "csv"] as const) {
      for (const delimiter of [",", ";"]) {
        assert.throws(
          () => parseTable(`name${delimiter}value\na${delimiter}"1\nb${delimiter}2`, format),
          /The quoted field that starts on line 2 is not closed/,
        );
      }
    }
  });

  test("a quote error with one CSV delimiter does not reject the other", () => {
    const data = 'name,note;value\na,"note;1\nb,plain;2';
    for (const format of ["auto", "csv"] as const) {
      assert.deepStrictEqual(parse(data, format), {
        columns: ["name,note", "value"],
        rows: [
          ['a,"note', 1],
          ["b,plain", 2],
        ],
      });
    }
  });

  test("rejects text after closing CSV quotes instead of changing its value", () => {
    for (const format of ["auto", "csv"] as const) {
      for (const delimiter of [",", ";"]) {
        assert.throws(
          () => parseTable(`name${delimiter}value\na${delimiter}"12"3\nb${delimiter}4`, format),
          /Unexpected text after a closing quote on line 2/,
        );
        assert.deepStrictEqual(
          parse(`name${delimiter}value\n"a"  ${delimiter}"12" \n"b"${delimiter}4`, format).rows,
          [
            ["a", 12],
            ["b", 4],
          ],
        );
      }
    }
  });

  test("literal commas and quotes in whitespace-separated paths stay text", () => {
    const data = '12 src/a,"odd name\n23 src/other';
    for (const format of ["auto", "whitespace"] as const) {
      assert.deepStrictEqual(parse(data, format).rows, [
        [12, 'src/a,"odd name'],
        [23, "src/other"],
      ]);
    }
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
    assert.deepStrictEqual(parse("Name;Amount\nA;1.234,56\nB;999,00\nC;2.000").rows, [
      ["A", 1234.56],
      ["B", 999],
      ["C", 2000],
    ]);
  });

  test("detects semicolons in headerless decimal-comma numeric tables", () => {
    for (const format of ["auto", "csv"] as const) {
      for (const text of ["1,5;2,5", '"1,5";"2,5"', "1,5;2,5\n3,5;4,5"]) {
        assert.deepStrictEqual(
          parse(text, format).rows,
          text.includes("\n")
            ? [
                [1.5, 2.5],
                [3.5, 4.5],
              ]
            : [[1.5, 2.5]],
          `${format}: ${text}`,
        );
      }
      assert.deepStrictEqual(parse("1.5;2.5\n3.5;4.5", format).rows, [
        [1.5, 2.5],
        [3.5, 4.5],
      ]);
      assert.deepStrictEqual(parse('"a;b",1,2\n"c;d",3,4', format).rows, [
        ["a;b", 1, 2],
        ["c;d", 3, 4],
      ]);
    }
  });

  test("parses localized scientific notation without dropping exponents", () => {
    assert.deepStrictEqual(parse("name;value\na;1,25e3\nb;-2,5E-2\nc;1.234,5e1").rows, [
      ["a", 1250],
      ["b", -0.025],
      ["c", 12345],
    ]);
    assert.deepStrictEqual(parseNumber("1,5e2KiB", true), { value: 150 * 1024, unit: "bytes" });
  });

  test("explicit headers do not change the numeric format or unit of their values", () => {
    const table = parseTable('[{"1,5": "1,234", "1M": 12}, {"1,5": "2,345", "1M": 34}]');
    assert.deepStrictEqual(table.columns, [
      { name: "1,5", numeric: true },
      { name: "1M", numeric: true },
    ]);
    assert.deepStrictEqual(table.rows, [
      [1234, 12],
      [2345, 34],
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

  test("tabs inside CSV fields do not change its delimiter", () => {
    for (const delimiter of [",", ";"]) {
      const rows = `"a\tb"${delimiter}1\n"c\td"${delimiter}2`;
      for (const header of ["", `name${delimiter}value\n`]) {
        assert.deepStrictEqual(parse(`${header}${rows}`).rows, [
          ["a\tb", 1],
          ["c\td", 2],
        ]);
      }
      assert.deepStrictEqual(
        parse(`name${delimiter}value\na\tb${delimiter}1\nc\td${delimiter}2`).rows,
        [
          ["a\tb", 1],
          ["c\td", 2],
        ],
      );
    }
  });

  test("parses TSV with unbalanced quotes", () => {
    assert.deepStrictEqual(parse('4\t"odd name\n8\tother', "tsv").rows, [
      [4, '"odd name'],
      [8, "other"],
    ]);
    assert.deepStrictEqual(parse('4\t"odd,name\n8\tother,file').rows, [
      [4, '"odd,name'],
      [8, "other,file"],
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

  test("parses docker stats output, whose cells have spaces where its header has", () => {
    const table = parseTable(
      [
        "CONTAINER ID   NAME      CPU %     MEM USAGE / LIMIT     MEM %     NET I/O         PIDS",
        "b5d2a2d1c3e4   web       0.00%     3.98MiB / 15.5GiB     0.03%     5.9kB / 0B      2",
        "0a1b2c3d4e5f   db        1.25%     150.2MiB / 15.5GiB    0.95%     12.3MB / 4MB    31",
      ].join("\n"),
    );
    assert.deepStrictEqual(
      table.columns.map((column) => column.name),
      ["CONTAINER ID", "NAME", "CPU %", "MEM USAGE / LIMIT", "MEM %", "NET I/O", "PIDS"],
    );
    assert.deepStrictEqual(table.rows[1], [
      "0a1b2c3d4e5f",
      "db",
      1.25,
      "150.2MiB / 15.5GiB",
      0.95,
      "12.3MB / 4MB",
      31,
    ]);
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

  test("parses tables drawn with pipes, as in Markdown and by psql and mysql", () => {
    const expected = {
      columns: ["lang", "lines"],
      rows: [
        ["ts", 1200],
        ["css", 300],
      ],
    };
    for (const table of [
      "| lang | lines |\n|:-----|------:|\n| ts | 1,200 |\n| css | 300 |",
      " lang | lines\n------+-------\n ts   |  1200\n css  |   300\n(2 rows)",
      "+------+-------+\n| lang | lines |\n+------+-------+\n| ts   |  1200 |\n| css  |   300 |\n+------+-------+",
    ]) {
      assert.deepStrictEqual(parse(table), expected, table);
    }
    assert.deepStrictEqual(parse("a | b\n--|--\nx\\|y | 1").rows, [["x|y", 1]]);
    assert.deepStrictEqual(parse("a | b\n--|--\n1 | x\\|").rows, [[1, "x|"]]);
    assert.deepStrictEqual(parse("| a | b |\n|---|---|\n| x | 1 |\n| y |").rows, [
      ["x", 1],
      ["y", null],
    ]);
  });

  test("leaves out rules, taking the line above one as the header", () => {
    assert.deepStrictEqual(parse("Package    Version\n---------- -------\nnumpy      1.26.0"), {
      columns: ["Package", "Version"],
      rows: [["numpy", "1.26.0"]],
    });
    // PowerShell's Format-Table, with blank lines around it.
    assert.deepStrictEqual(
      parse("\nName        Length\n----        ------\nmy file.txt    4567\n\n"),
      {
        columns: ["Name", "Length"],
        rows: [["my file.txt", 4567]],
      },
    );
    assert.deepStrictEqual(
      parse(
        [
          "=========================================",
          " Language            Files        Lines",
          "=========================================",
          " TypeScript             12         2400",
          " CSS                     2          300",
          "=========================================",
        ].join("\n"),
      ),
      {
        columns: ["Language", "Files", "Lines"],
        rows: [
          ["TypeScript", 12, 2400],
          ["CSS", 2, 300],
        ],
      },
    );
  });

  test("leaves out rules and empty rows in CSV and TSV", () => {
    assert.deepStrictEqual(parse("a,b\n1,2\n-----\n3,4\n,\n"), {
      columns: ["a", "b"],
      rows: [
        [1, 2],
        [3, 4],
      ],
    });
    assert.deepStrictEqual(parse("name\tdesc\n----\t----\nx\ty\n\t\n"), {
      columns: ["name", "desc"],
      rows: [["x", "y"]],
    });
  });

  test("takes a percentage unit from the column name", () => {
    const table = parseTable("USER PID %CPU %MEM COMMAND\nroot 1 0.0 0.1 init\nfred 42 3.5 1.2 vi");
    assert.deepStrictEqual(table.columns[2], { name: "%CPU", numeric: true, unit: "%" });
    assert.deepStrictEqual(table.columns[1], { name: "PID", numeric: true });
  });

  test("uses a header for whitespace output with numeric columns", () => {
    assert.deepStrictEqual(parse("dir size\nsrc 12\ntest 3").columns, ["dir", "size"]);
  });

  test("parses 200,000 rows", function () {
    // Takes about a second, or longer on a busy machine; quadratic time would take minutes.
    this.timeout(10_000);
    const lines = Array.from({ length: 200_000 }, (_, i) => `row ${i} /a`);
    assert.strictEqual(parse(lines.join("\n")).rows.length, 200_000);
    assert.strictEqual(parse(lines.join("\n").replaceAll(" ", ",")).rows.length, 200_000);
    const df = parse(["Name Size Mounted on", ...lines].join("\n"));
    assert.deepStrictEqual(df.columns, ["Name", "Size", "Mounted on"]);
  });

  test("names 100,000 equally named columns", () => {
    const columns = parse(`${"x,".repeat(100_000)}x\n${"1,".repeat(100_000)}1`).columns;
    assert.strictEqual(columns.length, 100_001);
    assert.strictEqual(columns[100_000], "x (100001)");
  });

  test("parses a long line that almost is a rule", () => {
    assert.strictEqual(parse(`a 1\n${"-".repeat(1_000_000)}x 2`).rows.length, 2);
  });

  test("parses a header with many spaces at the end", () => {
    assert.deepStrictEqual(parse(`name  size${" ".repeat(1_000_000)}\na     1\nb c   2`), {
      columns: ["name", "size"],
      rows: [
        ["a", 1],
        ["b c", 2],
      ],
    });
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

  test("missing JSON fields do not inherit object properties", () => {
    assert.deepStrictEqual(parse('[{"__proto__": 1, "constructor": 2}, {"value": 3}]'), {
      columns: ["__proto__", "constructor", "value"],
      rows: [
        [1, 2, null],
        [null, null, 3],
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

  test("JSON Lines accepts all text line endings and reports the original error line", () => {
    for (const newline of ["\n", "\r\n", "\r"]) {
      assert.deepStrictEqual(parse(['{"n": 1}', "", '{"n": 2}'].join(newline)), {
        columns: ["n"],
        rows: [[1], [2]],
      });
      assert.throws(
        () => parse(['{"n": 1}', "", '{"n": }'].join(newline)),
        /Line 3 of the JSON Lines/,
      );
    }
  });

  test("JSON Lines errors report the original line after blank lines", () => {
    assert.throws(() => parse('{"n": 1}\n\n{"n": 2}\n\n{"n": }'), /Line 5 of the JSON Lines/);
    assert.throws(() => parse('\n\n{"n": 1}\n\n{"n": }'), /Line 5 of the JSON Lines/);
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

  test("generated column names preserve explicit headers appearing later", () => {
    const table = parseTable(",x,x,x (2),Column 1\na,1,2,3,4");
    assert.deepStrictEqual(
      table.columns.map(({ name }) => name),
      ["Column 1 (2)", "x", "x (3)", "x (2)", "Column 1"],
    );
    assert.strictEqual(table.rows[0]?.[findColumn(table, "x (2)", "value")], 3);
    assert.strictEqual(table.rows[0]?.[findColumn(table, "Column 1", "value")], 4);
  });

  test("generated JSON row keys do not rename existing value columns", () => {
    const table = parseTable(JSON.stringify({ row: { " name ": "A", key: 42, "key (2)": 99 } }));
    assert.deepStrictEqual(
      table.columns.map(({ name }) => name),
      ["key (3)", "name", "key", "key (2)"],
    );
    assert.strictEqual(table.rows[0]?.[findColumn(table, "key", "value")], 42);
    assert.strictEqual(table.rows[0]?.[findColumn(table, "key (2)", "value")], 99);
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

  test("reads markers of missing values in numeric columns as empty", () => {
    const table = parseTable(
      [
        "country,gdp,population,growth,note",
        "Sweden,541.2,10.35,-,None",
        "Norway,N/A,5.38,1.2%,NA",
        "Denmark,356.1,NULL,—,-",
        "Finland,#N/A,5.54,n/a,-",
        "Iceland,NaN,0.37,0.8%,-",
      ].join("\n"),
    );
    assert.strictEqual(table.header, true);
    assert.deepStrictEqual(
      table.columns.map((column) => column.numeric),
      [false, true, true, true, false],
    );
    assert.deepStrictEqual(table.rows, [
      ["Sweden", 541.2, 10.35, null, "None"],
      ["Norway", null, 5.38, 1.2, "NA"],
      ["Denmark", 356.1, null, null, "-"],
      ["Finland", null, 5.54, null, "-"],
      ["Iceland", null, 0.37, 0.8, "-"],
    ]);
    // Labels that look like markers stay labels.
    assert.deepStrictEqual(parse("plan,users\nNone,12\nPro,30\nNA,5").rows, [
      ["None", 12],
      ["Pro", 30],
      ["NA", 5],
    ]);
  });

  test("reads -- in docker stats output for a stopped container as empty", () => {
    const table = parseTable(
      [
        "CONTAINER ID   NAME      CPU %     MEM USAGE / LIMIT     MEM %     PIDS",
        "b5d2a2d1c3e4   web       0.00%     3.98MiB / 15.5GiB     0.03%     2",
        "0a1b2c3d4e5f   old       --        -- / --               --        --",
      ].join("\n"),
    );
    assert.deepStrictEqual(
      table.columns.map((column) => column.numeric),
      [false, false, true, false, true, true],
    );
    assert.deepStrictEqual(table.rows[1], ["0a1b2c3d4e5f", "old", null, "-- / --", null, null]);
  });

  test("throws helpful errors for empty or invalid data", () => {
    assert.throws(() => parseTable("  \n"), /^Error: The data is empty\. Give JSON, CSV/);
    assert.throws(() => parseTable('{"a": '), /^Error: The data is not valid JSON: .*\.$/);
    assert.throws(
      () => parseTable('{"a": 1}\n{"a": 2,}'),
      /^Error: Line 2 of the JSON Lines is not valid JSON: [^()]*\.$/,
    );
    assert.throws(() => parseTable("[]"), /array is empty/);
    assert.throws(() => parseTable('{"data": []}'), /array is empty/);
    assert.throws(() => parseTable("[{}]"), /holds no values/);
    assert.throws(
      () => parseTable('a,b\nc,"d\ne,f', "csv"),
      /^Error: The quoted field that starts on line 2 is not closed\. A quote in a quoted field is written twice, as in "say ""hi"""\.$/,
    );
  });
});
