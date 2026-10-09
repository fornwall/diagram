import * as assert from "node:assert";
import { findColumn } from "../chartColumns";
import type { DataFormat } from "../chartSpec";
import { parseTable } from "../data";
import { parseJson } from "../dataJson";
import { parseNumber } from "../dataNumber";
import { splitText } from "../dataText";

/** Parses a table, with its columns by name. */
function parse(text: string, format?: DataFormat) {
  const table = parseTable(text, format);
  return { columns: table.columns.map((column) => column.name), rows: table.rows };
}

suite("data", () => {
  test("unquoted delimiters preserve the quoted parser's rows, rules and empty fields", () => {
    for (const [format, delimiter] of [
      ["csv", ","],
      ["csv", ";"],
      ["tsv", "\t"],
    ] as const) {
      for (const newline of ["\n", "\r", "\r\n"]) {
        const lines = [
          ["name", "value", "other"].join(delimiter),
          "----", // An unquoted rule below the header marks it as a header.
          ["  first ", "1", ""].join(delimiter),
          ["", "", ""].join(delimiter),
          ["second", "", "2"].join(delimiter),
          " \t ",
          ["third", "3", "4", "extra"].join(delimiter),
          "",
        ];
        const plain = lines.join(newline);
        // A quoted header selects the general parser without changing its fields.
        const quoted = plain.replace("name", '"name"');
        const expected = splitText(quoted, format);
        assert.deepStrictEqual(splitText(plain, format), expected);
        assert.strictEqual(expected.header, true);
        assert.strictEqual(expected.records.length, 4);
      }
    }
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
    assert.throws(
      () => splitText("\t".repeat(1_000_005), "tsv"),
      /^Error: A row of the data has more than 1,000,000 cells, exceeding the 1,000,000 cell limit by itself\. Select fewer columns/,
    );
    // Lines of whitespace-separated values are counted before they are split into columns.
    assert.throws(
      () => splitText("a 1\n".repeat(1_000_001), "whitespace"),
      /^Error: The data has 1,000,001 rows, counting any header row, exceeding the 1,000,000 cell limit even with one column\. Select fewer rows/,
    );
    for (const line of ["a ".repeat(1_000_005), `|${"a|".repeat(1_000_005)}`]) {
      assert.throws(() => splitText(line, "auto"), /exceeding the 1,000,000 cell limit/);
    }
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
    // Naming all the columns, so that the model knows how many to select.
    assert.throws(() => parseTable(json), /1,101 rows × 1,100 columns, counting any header row/);
  });

  test("reads K, M and B as sizes in bytes only in columns of sizes", () => {
    const table = parseTable("video,views,size\na,1.2K,1.2K\nb,3.4M,512M\nc,1.1B,2.1G");
    assert.deepStrictEqual(table.rows, [
      ["a", 1200, 1.2 * 1024],
      ["b", 3.4e6, 512 * 1024 ** 2],
      ["c", 1.1e9, 2.1 * 1024 ** 3],
    ]);
    assert.deepStrictEqual(
      table.columns.map((column) => column.unit),
      [undefined, undefined, "bytes"],
    );
    // A unit that only sizes have, a name of sizes, or no name at all, as du -h prints none.
    assert.deepStrictEqual(parse("pod,usage\na,800M\nb,1.2G").rows[0], ["a", 800 * 1024 ** 2]);
    assert.deepStrictEqual(parse("pod,memUsed\na,800M\nb,1.2K").rows[0], ["a", 800 * 1024 ** 2]);
    assert.deepStrictEqual(parse("800M\ta\n1.2K\tb").rows[0], [800 * 1024 ** 2, "a"]);
    assert.deepStrictEqual(parse("pod,members\na,800M\nb,1.2K").rows[0], ["a", 800e6]);
  });

  test("reads durations in seconds, as Go, kubectl, time and systemd print them", () => {
    for (const [text, value] of [
      ["5.123s", 5.123],
      ["812ms", 0.812],
      ["812 ms", 0.812],
      ["1.5µs", 1.5e-6],
      ["1.5us", 1.5e-6],
      ["1234ns", 1234e-9],
      ["0m1.234s", 1.234],
      ["1h2m3s", 3723],
      ["3h12m", 11_520],
      ["2d5h", 190_800],
      ["1min 2.345s", 62.345],
      ["1min2.345s", 62.345],
      ["1h 2min", 3720],
    ] as const) {
      assert.deepStrictEqual(parseNumber(text), { value, unit: "seconds" }, text);
    }
    // A single unit of minutes, hours or days, a clock, or whole seconds that read as a decade,
    // only in a column of durations.
    for (const text of ["5m", "5min", "3h", "2d", "1:02:03", "1980s"]) {
      assert.strictEqual(parseNumber(text), undefined, text);
    }
    assert.deepStrictEqual(parse("decade,count\n1980s,5\n1990s,7"), {
      columns: ["decade", "count"],
      rows: [
        ["1980s", 5],
        ["1990s", 7],
      ],
    });
    assert.deepStrictEqual(
      parse("run,elapsed\na,1200s\nb,45s").rows.map((row) => row[1]),
      [1200, 45],
    );
    const pods = parseTable(
      "NAME   READY   AGE\napi    1/1     45m\nweb    1/1     3h12m\ndb     1/1     2d",
    );
    assert.deepStrictEqual(
      pods.rows.map((row) => row[2]),
      [2700, 11_520, 172_800],
    );
    assert.deepStrictEqual(pods.columns[2], { name: "AGE", numeric: true, unit: "seconds" });
    const runs = parse("run,elapsed\na,1:02:03.5\nb,3:45\nc,1-00:00:00");
    assert.deepStrictEqual(
      runs.rows.map((row) => row[1]),
      [3723.5, 225, 86_400],
    );
    // systemd-analyze blame right-aligns durations with spaces between their parts.
    const blame = [
      "1h 2min 3.4s slow.service",
      "1min 30.123s NetworkManager-wait-online.service",
      "      812ms snapd.service",
    ].join("\n");
    for (const format of ["auto", "whitespace"] as const) {
      assert.deepStrictEqual(parse(blame, format).rows, [
        [3723.4, "slow.service"],
        [90.123, "NetworkManager-wait-online.service"],
        [0.812, "snapd.service"],
      ]);
    }
    // Durations in columns of their own stay apart.
    assert.deepStrictEqual(parse("job 2h 30s\nweb 3h 5s").rows, [
      ["job", "2h", 30],
      ["web", "3h", 5],
    ]);
    // The time of day in another column stays text.
    assert.deepStrictEqual(parse("event,at,people\nstandup,09:30,8\nlunch,12:00,20").rows[0], [
      "standup",
      "09:30",
      8,
    ]);
  });

  test("parses go test -bench output into a column for each measure", () => {
    const table = parseTable(
      [
        "goos: linux",
        "goarch: amd64",
        "pkg: example.com/parse",
        "cpu: AMD Ryzen 7 5800X 8-Core Processor",
        "BenchmarkParse-16     \t  952141\t      1234 ns/op\t     560 B/op\t       7 allocs/op",
        "BenchmarkRender-16    \t   41020\t     29071 ns/op\t   12.5 MB/s",
        "PASS",
        "ok  \texample.com/parse\t3.456s",
      ].join("\n"),
    );
    assert.deepStrictEqual(table.columns, [
      { name: "Benchmark", numeric: false },
      { name: "Iterations", numeric: true },
      { name: "time/op", numeric: true, unit: "seconds" },
      { name: "B/op", numeric: true, unit: "bytes" },
      { name: "allocs/op", numeric: true },
      { name: "MB/s", numeric: true },
    ]);
    assert.deepStrictEqual(table.rows, [
      ["BenchmarkParse-16", 952141, 1234e-9, 560, 7, null],
      ["BenchmarkRender-16", 41020, 29071e-9, null, null, 12.5],
    ]);
    // The headings above the results are no title above a table of tab-separated values.
    assert.strictEqual(table.note, undefined);
    // With -v, and with what the benchmarks logged.
    const logged = parseTable(
      [
        "BenchmarkParse",
        "BenchmarkParse-16     \t  952141\t      1234 ns/op",
        "--- BENCH: BenchmarkParse-16",
        "    parse_test.go:12: warm cache",
        "        and a second line",
        "BenchmarkRender",
        "BenchmarkRender-16    \t   41020\t     29071 ns/op",
        "PASS",
      ].join("\n"),
    );
    assert.deepStrictEqual(logged.rows, [
      ["BenchmarkParse-16", 952141, 1234e-9],
      ["BenchmarkRender-16", 41020, 29071e-9],
    ]);
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
    assert.deepStrictEqual(parse('a,b\n"x\ny","1,234"\r\nz,5', "csv").rows, [
      ["x\ny", 1234],
      ["z", 5],
    ]);
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
    // Much of Europe writes the currency after the number.
    assert.deepStrictEqual(parse("Artikel;Preis\nSuppe;4,50 €\nBrot;1.200,00 €").rows, [
      ["Suppe", 4.5],
      ["Brot", 1200],
    ]);
    assert.deepStrictEqual(parseNumber("5$"), { value: 5 });
    // The sign may come after the currency symbol.
    assert.deepStrictEqual(parse('item,change\na,$-5\nb,-$1.5\nc,"€-1,200"').rows, [
      ["a", -5],
      ["b", -1.5],
      ["c", -1200],
    ]);
    assert.deepStrictEqual(parse('item,price\na,"₹1,250"\nb,₩5000\nc,300 ₽').rows, [
      ["a", 1250],
      ["b", 5000],
      ["c", 300],
    ]);
    // Abbreviated amounts of money, which are not sizes in bytes.
    assert.deepStrictEqual(parse("company,revenue\na,$1.2B\nb,$350M\nc,-€12.5k\nd,$3T").rows, [
      ["a", 1.2e9],
      ["b", 350e6],
      ["c", -12_500],
      ["d", 3e12],
    ]);
    assert.deepStrictEqual(parseNumber("$2MB"), { value: 2e6, unit: "bytes" });
  });

  test("keeps rules in quotes as data, also when they would make the line above a header", () => {
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
    assert.deepStrictEqual(parse('"label"\n"---"\n"x"', "csv").rows, [["label"], ["---"], ["x"]]);
    assert.deepStrictEqual(parse('a\tb\n"---"\t"---"\nx\ty', "tsv").rows, [
      ["a", "b"],
      ["---", "---"],
      ["x", "y"],
    ]);
  });

  test("strips a byte order mark before a quoted header", () => {
    assert.deepStrictEqual(parse('﻿"name","count"\n"a",1'), {
      columns: ["name", "count"],
      rows: [["a", 1]],
    });
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

  test("reads the delimiter that a first sep= line names, as Excel writes it", () => {
    for (const format of ["auto", "csv", "tsv"] as const) {
      assert.deepStrictEqual(parse("﻿sep=;\r\nname;value\r\na;1,5\r\nb;2\r\n", format), {
        columns: ["name", "value"],
        rows: [
          ["a", 1.5],
          ["b", 2],
        ],
      });
    }
    assert.deepStrictEqual(parse("sep=|\nname|value\na,b|1").rows, [["a,b", 1]]);
    assert.throws(
      () => parseTable('sep=,\na,b\n"x,1'),
      /starts on line 3, column 1, is not closed/,
    );
  });

  test("reports unclosed CSV quotes instead of falling back to whitespace", () => {
    for (const format of ["auto", "csv"] as const) {
      for (const delimiter of [",", ";"]) {
        assert.throws(
          () => parseTable(`name${delimiter}value\na${delimiter}"1\nb${delimiter}2`, format),
          /The quoted field that starts on line 2, column 3, is not closed/,
        );
      }
    }
    // Also below quoted fields over several lines, which split the unquoted rows apart, counting
    // their lines with any line ending, and in escaped quotes.
    for (const format of ["auto", "csv"] as const) {
      assert.throws(
        () => parseTable('name,value\n"a\r\nb\rc""\n",1\n"d,2', format),
        /The quoted field that starts on line 6, column 1, is not closed/,
      );
    }
    // Not for text with a quote below a single line with a comma.
    assert.deepStrictEqual(parse('Done, ok\n"Starting\nnow').rows, [
      ["Done, ok"],
      ['"Starting'],
      ["now"],
    ]);
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
          /Unexpected text after the quoted field "12" on line 2, column 7\./,
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
    // Only a decimal comma reads several dots between thousands.
    assert.deepStrictEqual(parse("Stadt;Einwohner\nBerlin;3.645.000\nBremen;567.559").rows, [
      ["Berlin", 3_645_000],
      ["Bremen", 567_559],
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
    assert.deepStrictEqual(parseNumber("1,5e2KiB", { decimalComma: true }), {
      value: 150 * 1024,
      unit: "bytes",
    });
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

  test("keeps versions as text in a column with versions of several dots", () => {
    const pip = parse(
      "Package    Version\n---------- -------\npip        24.0\nsetuptools 69.0.3\nidna       3.10\nwheel      0.42.0",
    );
    assert.deepStrictEqual(pip.rows, [
      ["pip", "24.0"],
      ["setuptools", "69.0.3"],
      ["idna", "3.10"],
      ["wheel", "0.42.0"],
    ]);
    assert.deepStrictEqual(
      parseTable("name,version,stars\na,1.0,12\nb,2.0.0-rc.1,3\nc,v1.2.3,4").rows,
      [
        ["a", "1.0", 12],
        ["b", "2.0.0-rc.1", 3],
        ["c", "v1.2.3", 4],
      ],
    );
    // Numbers that only a decimal comma reads that way, or with units, are not versions.
    assert.deepStrictEqual(parse("a;1.234.567\nb;12\nc;1.2.3").rows, [
      ["a", 1234567],
      ["b", 12],
      ["c", "1.2.3"],
    ]);
    assert.deepStrictEqual(parse("a\t1.5 MB\nb\t2\nc\t10.0.0.1\nd\t3").rows, [
      ["a", 1.5e6],
      ["b", 2],
      ["c", "10.0.0.1"],
      ["d", 3],
    ]);
  });

  test("reads bare size units in powers of 1000 in columns with SI evidence", () => {
    // du --si and df -H write 1000 as a lowercase k, but 1000² as M.
    assert.deepStrictEqual(parse("4.1k\tsrc\n1.3M\tdist\n2.0G\tnode_modules\n").rows, [
      [4100, "src"],
      [1.3e6, "dist"],
      [2e9, "node_modules"],
    ]);
    const df = parseTable(
      [
        "Filesystem      Size  Used Avail Use% Mounted on",
        "/dev/nvme0n1p5  2.1T  1.7T  284G  86% /",
        "efivarfs        132k   79k   49k  62% /sys/firmware/efi/efivars",
      ].join("\n"),
    );
    assert.deepStrictEqual(df.rows[0]?.slice(1, 4), [2.1e12, 1.7e12, 284e9]);
    // Without a lowercase k, as from du -h and ls -lh, or with an uppercase K beside it.
    assert.deepStrictEqual(parse("4.0K\tsrc\n1.3M\tdist\n").rows[1], [1.3 * 1024 ** 2, "dist"]);
    assert.deepStrictEqual(parse("4.0K\ta\n4.1k\tb\n1M\tc\n").rows[2], [1024 ** 2, "c"]);
    // Explicit units keep their base in an SI column.
    assert.deepStrictEqual(parse("a\t150k\nb\t3Mi\nc\t2GiB\nd\t5MB\n").rows, [
      ["a", 150_000],
      ["b", 3 * 1024 ** 2],
      ["c", 2 * 1024 ** 3],
      ["d", 5e6],
    ]);
  });

  test("reads bare size units in powers of 1000 when told the command prints them so", () => {
    const text = "1.5M\tsrc\n2G\tdocs";
    assert.deepStrictEqual(parseTable(text, "auto", true).rows, [
      [1.5e6, "src"],
      [2e9, "docs"],
    ]);
    assert.deepStrictEqual(parseTable(text).rows[0], [1.5 * 1024 ** 2, "src"]);
  });

  test("reads thousands grouped with spaces or apostrophes in consistent columns", () => {
    assert.deepStrictEqual(
      parse("Pays;Habitants;Part\nFrance;68 042 591;12,5 %\nBelgique;11\u00A0763\u00A0650;1,25 %"),
      {
        columns: ["Pays", "Habitants", "Part"],
        rows: [
          ["France", 68042591, 12.5],
          ["Belgique", 11763650, 1.25],
        ],
      },
    );
    assert.deepStrictEqual(parse("a;1\u202F234,5\nb;999,25").rows, [
      ["a", 1234.5],
      ["b", 999.25],
    ]);
    assert.deepStrictEqual(
      parse("Kanton,Betrag\nZH,\"1'234.50\"\nBE,1\u2019000\nGE,-12'000").rows,
      [
        ["ZH", 1234.5],
        ["BE", 1000],
        ["GE", -12000],
      ],
    );
    // Two numbers with a space between them, as in a column of resolutions, stay text.
    assert.deepStrictEqual(parse("size,n\n640 480,1\n1920 1080,2\n320 240,3").rows, [
      ["640 480", 1],
      ["1920 1080", 2],
      ["320 240", 3],
    ]);
    assert.deepStrictEqual(parseNumber("-$1 234.5", { groups: true }), { value: -1234.5 });
    assert.strictEqual(parseNumber("1 2345", { groups: true }), undefined);
    assert.strictEqual(parseNumber("1 234 5", { groups: true }), undefined);
    assert.strictEqual(parseNumber("1 234'567", { groups: true }), undefined);
  });

  test("reads numbers in parentheses as negative in accounting columns", () => {
    assert.deepStrictEqual(
      parse('Item,Amount\nSales,"1,234.00"\nRefunds,"(567.50)"\nFees,$(89)\nTax,"($1,000)"').rows,
      [
        ["Sales", 1234],
        ["Refunds", -567.5],
        ["Fees", -89],
        ["Tax", -1000],
      ],
    );
    assert.deepStrictEqual(parse("a;(1.234,5)\nb;2,5").rows, [
      ["a", -1234.5],
      ["b", 2.5],
    ]);
    // A column that also has minus signs does not use parentheses for them.
    assert.deepStrictEqual(parse("a,-5\nb,(5)\nc,7").rows, [
      ["a", -5],
      ["b", "(5)"],
      ["c", 7],
    ]);
    assert.strictEqual(parseNumber("(5)"), undefined);
    assert.strictEqual(parseNumber("(-5)", { accounting: true }), undefined);
    assert.strictEqual(parseNumber("(5", { accounting: true }), undefined);
  });

  test("reads kubectl restart counts with the time since the last restart", () => {
    const table = parse(
      [
        "NAME                     READY   STATUS    RESTARTS      AGE",
        "web-7d4b9c8f5-abcde      1/1     Running   0             5d2h",
        "db-0                     1/1     Running   2 (3h ago)    10d",
      ].join("\n"),
    );
    assert.deepStrictEqual(
      table.rows.map((row) => row[3]),
      [0, 2],
    );
  });

  test("reads plain numbers in the unit of sizes or durations that their column's name states", () => {
    const read = (text: string) => {
      const table = parseTable(text);
      return [table.columns[1]?.unit, table.rows.map((row) => row[1])];
    };
    assert.deepStrictEqual(read("name,Size (KB)\na,12"), ["bytes", [12_000]]);
    assert.deepStrictEqual(read("name,Memory [MiB]\na,2"), ["bytes", [2 * 1024 ** 2]]);
    assert.deepStrictEqual(read("name,Size (B)\na,12"), ["bytes", [12]]);
    assert.deepStrictEqual(read("name,Latency (ms)\na,1.5"), ["seconds", [0.0015]]);
    // Without the noise of 700 * 0.001.
    assert.deepStrictEqual(read("name,Latency (ms)\na,700"), ["seconds", [0.7]]);
    assert.deepStrictEqual(read("name,Latency (sec)\na,12"), ["seconds", [12]]);
    // A single letter is a unit of time in a column named for durations.
    assert.deepStrictEqual(read("name,Elapsed (s)\na,12"), ["seconds", [12]]);
    assert.deepStrictEqual(read("name,Uptime (m)\na,2"), ["seconds", [120]]);
    assert.deepStrictEqual(read("name,Age [h]\na,2"), ["seconds", [7200]]);
    // Values with their own unit keep it.
    assert.deepStrictEqual(read("name,Latency (ms)\na,1.2s"), ["seconds", [1.2]]);
    // Not billions, a plural, meters, minima or units that only a column of durations has.
    for (const name of [
      "Revenue (B)",
      "File(s)",
      "Distance (m)",
      "Temp (min)",
      "Price (min)",
      "Latency (min)",
      "Time (s)",
      "Height (h)",
      "Width (d)",
    ]) {
      assert.deepStrictEqual(read(`name,${name}\na,12`), [undefined, [12]], name);
    }
    // Minima beside maxima are two columns of plain numbers.
    const temperatures = parseTable("city,Temp (min),Temp (max)\nOslo,-3,5\nRome,8,17");
    assert.deepStrictEqual(temperatures.columns, [
      { name: "city", numeric: false },
      { name: "Temp (min)", numeric: true },
      { name: "Temp (max)", numeric: true },
    ]);
    assert.deepStrictEqual(temperatures.rows[0], ["Oslo", -3, 5]);
  });

  test("reads the CPU of kubectl top in cores, not ages in minutes", () => {
    const pods = parseTable(
      [
        "NAME                     CPU(cores)   MEMORY(bytes)",
        "web-7d4b9c8f5-abcde      250m         128Mi",
        "db-0                     1            1Gi",
        "worker-1                 1500m        512Ki",
      ].join("\n"),
    );
    assert.deepStrictEqual(pods.columns, [
      { name: "NAME", numeric: false },
      { name: "CPU(cores)", numeric: true },
      { name: "MEMORY(bytes)", numeric: true, unit: "bytes" },
    ]);
    assert.deepStrictEqual(
      pods.rows.map((row) => row[1]),
      [0.25, 1, 1.5],
    );
    const nodes = parse(
      [
        "NAME     CPU(cores)   CPU(%)   MEMORY(bytes)   MEMORY(%)",
        "node-1   312m         7%       5120Mi          32%",
      ].join("\n"),
    );
    assert.deepStrictEqual(nodes.rows, [["node-1", 0.312, 7, 5120 * 1024 ** 2, 32]]);
    // A node without metrics.
    const unknown = parseTable(
      [
        "NAME     CPU(cores)   CPU(%)      MEMORY(bytes)   MEMORY(%)",
        "node-1   312m         7%          5120Mi          32%",
        "node-2   <unknown>    <unknown>   <unknown>       <unknown>",
      ].join("\n"),
    );
    assert.deepStrictEqual(unknown.rows[1], ["node-2", null, null, null, null]);
    assert.ok(unknown.columns.slice(1).every((column) => column.numeric));
    const ages = parse(
      ["NAME    READY   STATUS    RESTARTS   AGE", "web-1   1/1     Running   0          5m"].join(
        "\n",
      ),
    );
    assert.deepStrictEqual(ages.rows, [["web-1", "1/1", "Running", 0, 300]]);
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

  test("parses ls -l output into named columns, the name keeping its spaces", () => {
    // GNU ls, with a device file, a symbolic link and a name with spaces.
    const table = parseTable(
      [
        "total 16",
        "-rw-r--r--  1 fred staff  1234 Oct  4 14:02 a.txt",
        "-rw-r--r--. 1 fred staff    56 Feb 12  2025 my notes.md",
        "crw-rw-rw-  1 root root  1,   3 Oct  4 12:36 null",
        "lrwxrwxrwx  1 root root     7 Oct  4 12:36 bin -> usr/bin",
        "drwxr-xr-x+ 3 fred staff  4096 Mar  3  2024 src",
      ].join("\n"),
    );
    assert.deepStrictEqual(table.columns, [
      { name: "Mode", numeric: false },
      { name: "Links", numeric: true },
      { name: "Owner", numeric: false },
      { name: "Group", numeric: false },
      { name: "Size", numeric: true, unit: "bytes" },
      { name: "Modified", numeric: false },
      { name: "Name", numeric: false },
    ]);
    assert.deepStrictEqual(table.rows, [
      ["-rw-r--r--", 1, "fred", "staff", 1234, "Oct 4 14:02", "a.txt"],
      ["-rw-r--r--.", 1, "fred", "staff", 56, "Feb 12 2025", "my notes.md"],
      ["crw-rw-rw-", 1, "root", "root", "1, 3", "Oct 4 12:36", "null"],
      ["lrwxrwxrwx", 1, "root", "root", 7, "Oct 4 12:36", "bin"],
      ["drwxr-xr-x+", 3, "fred", "staff", 4096, "Mar 3 2024", "src"],
    ]);
    // Nor is "total" a title above a table of comma-separated values.
    const comma = parseTable(
      "total 8\n-rw-r--r-- 1 fred fred 220 Oct  4 14:02 sales, 2025.csv\n" +
        "-rw-r--r-- 1 fred fred 512 Oct  4 14:03 sales, 2026.csv",
    );
    assert.strictEqual(comma.note, undefined);
    assert.deepStrictEqual(
      comma.rows.map((row) => row.at(-1)),
      ["sales, 2025.csv", "sales, 2026.csv"],
    );
  });

  test("parses ls -lh output of BSD, other time styles and several directories", () => {
    const columns = (text: string) => parse(text).columns;
    const sizes = (text: string) => parse(text).rows.map((row) => row.at(-3));
    const names = (text: string) => parse(text).rows.map((row) => row.at(-1));
    // macOS, with extended attributes, and "B" for bytes.
    const bsd = [
      "total 24",
      "-rw-r--r--@  1 fred  staff   512B Oct  4 14:02 a b.txt",
      "-rw-r--r--   1 fred  staff   1.5K Oct  4  2025 c.txt",
      "drwxr-xr-x  12 fred  staff   384B Oct  4 14:02 src",
    ].join("\n");
    assert.deepStrictEqual(sizes(bsd), [512, 1536, 384]);
    assert.deepStrictEqual(names(bsd), ["a b.txt", "c.txt", "src"]);
    const longIso = [
      "total 8.0K",
      "-rw-r--r-- 1 fred fred 4.0K 2025-10-04 14:02 2024 report.pdf",
      "-rw-r--r-- 1 fred fred  12M 2025-01-30 09:00 data.csv",
    ].join("\n");
    assert.deepStrictEqual(sizes(longIso), [4096, 12 * 1024 ** 2]);
    assert.deepStrictEqual(names(longIso), ["2024 report.pdf", "data.csv"]);
    assert.deepStrictEqual(
      parse(longIso).rows.map((row) => row[5]),
      ["2025-10-04 14:02", "2025-01-30 09:00"],
    );
    const fullIso = "-rw-r--r-- 1 fred fred 10 2025-10-04 14:02:00.123456789 +0200 a b";
    assert.deepStrictEqual(names(fullIso), ["a b"]);
    // ls -T on BSD, and ls -l of two directories.
    assert.deepStrictEqual(names("-rw-r--r--  1 fred  staff  5 Oct  4 14:02:33 2025 x"), ["x"]);
    const directories = [
      "a:",
      "total 4",
      "-rw-r--r-- 1 fred fred 3 Oct  4 14:02 one",
      "",
      "b:",
      "total 4",
      "-rw-r--r-- 1 fred fred 5 Oct  4 14:02 two",
    ].join("\n");
    assert.deepStrictEqual(names(directories), ["one", "two"]);
    // ls -o leaves out the group.
    assert.deepStrictEqual(columns("-rw-r--r-- 1 fred 1234 Oct  4 14:02 a.txt"), [
      "Mode",
      "Links",
      "Owner",
      "Size",
      "Modified",
      "Name",
    ]);
    // A line that is not a file leaves the generic split.
    assert.strictEqual(
      columns("total 4\n-rw-r--r-- 1 fred fred 3 Oct  4 14:02 one\nfoo bar")[0],
      "Column 1",
    );
  });

  test("names the inodes and blocks that ls -i and -s print before the files", () => {
    const columns = (text: string) => parseTable(text).columns.slice(0, 3);
    const inodes = [
      "total 8",
      " 3934855 -rw-rw-r-- 1 fred fred  220 Oct  4 14:02 a.txt",
      " 3934860 drwxrwxr-x 2 fred fred 4096 Oct  4 14:02 src",
    ].join("\n");
    assert.deepStrictEqual(columns(inodes), [
      { name: "Inode", numeric: true },
      { name: "Mode", numeric: false },
      { name: "Links", numeric: true },
    ]);
    assert.deepStrictEqual(parse(inodes).rows[1]?.slice(-3), [4096, "Oct 4 14:02", "src"]);
    const blocks = [
      "total 8",
      "4 -rw-rw-r-- 1 fred fred  220 Oct  4 14:02 a.txt",
      "4 drwxrwxr-x 2 fred fred 4096 Oct  4 14:02 src",
      "0 lrwxrwxrwx 1 fred fred    5 Oct  4 14:02 b -> a.txt",
    ].join("\n");
    assert.strictEqual(columns(blocks)[0]?.name, "Blocks");
    // A large file's blocks are not taken for inodes, nor sizes with -h.
    assert.strictEqual(
      columns("2097160 -rw-r--r-- 1 fred fred 2147483648 Oct  4 14:02 disk.img")[0]?.name,
      "Blocks",
    );
    assert.deepStrictEqual(columns("4.0K -rw-r--r-- 1 fred fred 220 Oct  4 14:02 a")[0], {
      name: "Blocks",
      numeric: true,
      unit: "bytes",
    });
    // Both, as from ls -lis.
    assert.deepStrictEqual(
      parse("3934855 4 -rw-r--r-- 1 fred fred 220 Oct  4 14:02 a").columns.slice(0, 3),
      ["Inode", "Blocks", "Mode"],
    );
    // Device files, which have no size, and hard links, which share an inode, are ambiguous.
    const devices = [
      "1043 crw-rw-rw- 2 root root 1, 3 Oct  4 12:36 null",
      "1043 crw-rw-rw- 2 root root 1, 3 Oct  4 12:36 null2",
    ].join("\n");
    assert.deepStrictEqual(parse(devices).columns.slice(0, 2), ["Column 1", "Mode"]);
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

  test("keeps a name with a space in the column that it is under, as df on macOS prints it", () => {
    const df = [
      "Filesystem       Size   Used  Avail Capacity  Mounted on",
      "/dev/disk3s1s1  460Gi   10Gi  300Gi       4%  /",
      "devfs           205Ki  205Ki    0Bi     100%  /dev",
      "map auto_home     0Bi    0Bi    0Bi     100%  /System/Volumes/Data/home",
    ].join("\n");
    assert.deepStrictEqual(parse(df).rows[2], [
      "map auto_home",
      0,
      0,
      0,
      100,
      "/System/Volumes/Data/home",
    ]);
    // Words past the columns, as in ps aux, stay in the last.
    assert.deepStrictEqual(parse("USER PID COMMAND\nroot 1 init\nme   2 vim a b").rows[1], [
      "me",
      2,
      "vim a b",
    ]);
  });

  test("reads inodes as counts, as df -h on macOS prints them like sizes", () => {
    const df = "Filesystem  Size iused ifree\n/dev/disk1  460Gi 404k 3.1G\n/dev/disk2  2Gi 12 0";
    assert.deepStrictEqual(parseTable(df).rows[0], ["/dev/disk1", 460 * 1024 ** 3, 404e3, 3.1e9]);
    assert.deepStrictEqual(parseNumber("3.1G", { counts: true }), { value: 3.1e9 });
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

  test("leaves out the groups of columns that vmstat prints above its header", () => {
    const vmstat = [
      "procs -----memory---- ---swap-- -----cpu-----",
      " r  b   free   buff   si   so us sy id wa st",
      " 1  0 123456  12345    0    0  2  1 97  0  0",
    ];
    const columns = ["r", "b", "free", "buff", "si", "so", "us", "sy", "id", "wa", "st"];
    const rows = [[1, 0, 123456, 12345, 0, 0, 2, 1, 97, 0, 0]];
    assert.deepStrictEqual(parse(vmstat.join("\n")), { columns, rows });
    vmstat[0] = "--procs-- -------memory------ ---swap-- --------cpu--------";
    assert.deepStrictEqual(parse(vmstat.join("\n"), "whitespace"), { columns, rows });
  });

  test("splits columns where the parts of the rule under the header are", () => {
    const tasklist = [
      "",
      "Image Name                     PID Session Name        Session#    Mem Usage",
      "========================= ======== ================ =========== ============",
      "System Idle Process              0 Services                   0          8 K",
      "Code.exe                     12345 Console                    1    245,120 K",
    ].join("\r\n");
    assert.deepStrictEqual(parse(tasklist), {
      columns: ["Image Name", "PID", "Session Name", "Session#", "Mem Usage"],
      rows: [
        ["System Idle Process", 0, "Services", 0, 8 * 1024],
        ["Code.exe", 12345, "Console", 1, 245_120 * 1024],
      ],
    });
    // Not where a cell runs into the gap before the next part.
    assert.deepStrictEqual(parse("a  b\n-  -\nxyz 1\nw  2").rows, [
      ["xyz", 1],
      ["w", 2],
    ]);
  });

  test("leaves out what top and cloc print above their tables, and says so", () => {
    const top = [
      "top - 10:00:00 up 1 day,  2:03,  2 users,  load average: 0.52, 0.58, 0.59",
      "Tasks: 312 total,   1 running, 311 sleeping,   0 stopped,   0 zombie",
      "MiB Swap:   2048.0 total,   2048.0 free,      0.0 used.  21005.1 avail Mem",
      "",
      "    PID USER       VIRT    RES  %CPU COMMAND",
      "   1234 fornwall   1.2g   2048  12.5 code",
      "      1 root      27676   512m   0.0 systemd",
    ].join("\n");
    for (const format of ["auto", "whitespace"] as const) {
      const table = parseTable(top, format);
      // Sizes are in KiB, or in larger units after a lowercase letter.
      assert.deepStrictEqual(table.rows, [
        [1234, "fornwall", 1.2 * 1024 ** 3, 2048 * 1024, 12.5, "code"],
        [1, "root", 27676 * 1024, 512 * 1024 ** 2, 0, "systemd"],
      ]);
      assert.deepStrictEqual(
        table.columns.map((column) => column.unit),
        [undefined, undefined, "bytes", "bytes", "%", undefined],
      );
      assert.strictEqual(table.note, "Only the table from line 5 was read, not the text above it.");
    }
    const rule = "-".repeat(60);
    const cloc = [
      "      45 text files.",
      "",
      "github.com/AlDanial/cloc v 1.98  T=0.05 s (1000.0 files/s, 100000.0 lines/s)",
      rule,
      "Language         files     blank   comment      code",
      rule,
      "TypeScript          40      1000       800     12000",
      "JSON                 5         0         0       300",
      rule,
    ].join("\n");
    assert.deepStrictEqual(parse(cloc), {
      columns: ["Language", "files", "blank", "comment", "code"],
      rows: [
        ["TypeScript", 40, 1000, 800, 12000],
        ["JSON", 5, 0, 0, 300],
      ],
    });
    // A line between two rules with as many words as the line above is the first row.
    assert.deepStrictEqual(parse("name value\n----------\na 1\n----------\ntotal 1").rows, [
      ["a", 1],
      ["total", 1],
    ]);
  });

  test("leaves out the size of a data frame that pandas prints below it", () => {
    assert.deepStrictEqual(parse("   a  b\n0  1  x\n1  2  y\n\n[2 rows x 2 columns]\n"), {
      columns: ["Column 1", "a", "b"],
      rows: [
        [0, 1, "x"],
        [1, 2, "y"],
      ],
    });
  });

  test("leaves out the rows that stand for rows left out of long output, and says so", () => {
    const duckdb = parseTable(
      [
        "┌───────┬─────────┐",
        "│   i   │    j    │",
        "│ int64 │ varchar │",
        "├───────┼─────────┤",
        "│     0 │ a       │",
        "│     · │ ·       │",
        "│     · │ ·       │",
        "│  9999 │ b       │",
        "├───────┴─────────┤",
        "│   10000 rows    │",
        "│   (2 shown)     │",
        "└─────────────────┘",
      ].join("\n"),
    );
    assert.deepStrictEqual(duckdb.rows, [
      [0, "a"],
      [9999, "b"],
    ]);
    assert.strictEqual(
      duckdb.note,
      "Only the rows that the output shows were read, not those it left out of its 10000 rows.",
    );
    // Without elided rows, DuckDB tells the size of a table of ten rows or more on one line.
    const rows = Array.from({ length: 10 }, (_, i) => `│ ${i} │ x │`);
    const footer = ["├───┴───┤", "│ 10 rows  2 columns │", "└───────┘"];
    const ten = parseTable(["┌───┬───┐", "│ i │ j │", "├───┼───┤", ...rows, ...footer].join("\n"));
    assert.strictEqual(ten.rows.length, 10);
    assert.strictEqual(ten.note, undefined);
    const pandas = parseTable("     a\n0    1\n..  ..\n999  2\n\n[1000 rows x 1 columns]");
    assert.deepStrictEqual(pandas.rows, [
      [0, 1],
      [999, 2],
    ]);
    assert.match(pandas.note ?? "", /of its 1000 rows\.$/);
    // Polars writes a thousand as "1_000".
    const polars = parseTable(
      [
        "shape: (1_000, 1)",
        "┌─────┐",
        "│ a   │",
        "│ --- │",
        "│ i64 │",
        "╞═════╡",
        "│ 0   │",
        "│ …   │",
        "│ 999 │",
        "└─────┘",
      ].join("\n"),
    );
    assert.deepStrictEqual(polars.rows, [[0], [999]]);
    assert.match(polars.note ?? "", /of its 1,000 rows\.$/);
  });

  test("leaves out the column that stands for columns left out of wide output, and says so", () => {
    const expected = {
      columns: [
        { name: "a", numeric: true },
        { name: "z", numeric: true },
      ],
      rows: [
        [1, 3],
        [4, 6],
      ],
      header: true,
      note: "Only the columns that the output shows were read, not those it left out of its 30 columns.",
    };
    const duckdb = [
      "┌───────┬───┬───────┐",
      "│   a   │ … │   z   │",
      "│ int32 │   │ int32 │",
      "├───────┼───┼───────┤",
      "│     1 │ … │     3 │",
      "│     4 │ … │     6 │",
      "├───────┴───┴───────┤",
      "│ 2 rows  30 columns (2 shown) │",
      "└──────────────────────────────┘",
    ];
    const polars = [
      "shape: (2, 30)",
      "┌─────┬───┬─────┐",
      "│ a   ┆ … ┆ z   │",
      "│ --- ┆   ┆ --- │",
      "│ i64 ┆   ┆ i64 │",
      "╞═════╪═══╪═════╡",
      "│ 1   ┆ … ┆ 3   │",
      "│ 4   ┆ … ┆ 6   │",
      "└─────┴───┴─────┘",
    ];
    for (const lines of [duckdb, polars]) {
      assert.deepStrictEqual(parseTable(lines.join("\n")), expected, lines.join("\n"));
    }
    const pandas = parseTable(
      [
        "      a  ...  z",
        "0     1  ...  3",
        "..   ..  ...  ..",
        "999   4  ...  6",
        "",
        "[1000 rows x 30 columns]",
      ].join("\n"),
    );
    assert.deepStrictEqual(pandas.rows, [
      [0, 1, 3],
      [999, 4, 6],
    ]);
    assert.strictEqual(
      pandas.note,
      "Only the rows and columns that the output shows were read, not those it left out of its 1000 rows and 30 columns.",
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
      "+------+-------+\n| lang | lines |\n+------+-------+\n| ts   |  1200 |\n| css  |   300 |\n+------+-------+\n2 rows in set (0.00 sec)",
      // sqlite3 and psql -A, without a rule.
      "lang|lines\nts|1200\ncss|300\n(2 rows)",
      // Drawn with box-drawing characters: by sqlite3 -box, psql with unicode lines, tabulate's
      // fancy_grid, and DuckDB and Polars, which print the columns' types below their names.
      "┌──────┬───────┐\n│ lang │ lines │\n├──────┼───────┤\n│ ts   │ 1200  │\n│ css  │ 300   │\n└──────┴───────┘",
      " lang │ lines\n──────┼───────\n ts   │  1200\n css  │   300\n(2 rows)",
      "╒══════╤═══════╕\n│ lang │ lines │\n╞══════╪═══════╡\n│ ts   │  1200 │\n├──────┼───────┤\n│ css  │   300 │\n╘══════╧═══════╛",
      "┌─────────┬───────┐\n│  lang   │ lines │\n│ varchar │ int32 │\n├─────────┼───────┤\n│ ts      │  1200 │\n│ css     │   300 │\n└─────────┴───────┘",
      "shape: (2, 2)\n┌──────┬───────┐\n│ lang ┆ lines │\n│ ---  ┆ ---   │\n│ str  ┆ i64   │\n╞══════╪═══════╡\n│ ts   ┆ 1200  │\n│ css  ┆ 300   │\n└──────┴───────┘",
    ]) {
      assert.deepStrictEqual(parse(table), expected, table);
    }
    assert.deepStrictEqual(parse("a | b\n--|--\nx\\|y | 1").rows, [["x|y", 1]]);
    assert.deepStrictEqual(parse("a | b\n--|--\n1 | x\\|").rows, [[1, "x|"]]);
    // An escaped backslash does not escape the pipe after it.
    assert.deepStrictEqual(parse("| a | b |\n|---|---|\n| x\\\\| 1 |").rows, [["x\\\\", 1]]);
    // Rows have the header's width, as in GFM: missing cells are empty, and extra ones left out.
    assert.deepStrictEqual(parse("| a | b |\n|---|---|\n| x | 1 | 9 |\n| y |").rows, [
      ["x", 1],
      ["y", null],
    ]);
    assert.deepStrictEqual(parse("|a|b|\n|-|-|\n||1|").rows, [[null, 1]]);
    // A pipe off the junctions of the rule of an aligned table is text, as is one in a box.
    for (const table of [
      " a   | b\n-----+---\n x|y | 1",
      "+-----+---+\n| a   | b |\n+-----+---+\n| x|y | 1 |\n+-----+---+",
      "| a   | b |\n|-----|---|\n| x|y | 1 |",
      "┌─────┬───┐\n│ a   │ b │\n├─────┼───┤\n│ x|y │ 1 │\n└─────┴───┘",
    ]) {
      assert.deepStrictEqual(parse(table).rows, [["x|y", 1]], table);
    }
    // Emphasis or code around a whole cell, but not around parts of it.
    assert.deepStrictEqual(
      parse("| a | b |\n|---|---|\n| **Total** | **12** |\n| `x` and `y` | `3` |\n| *a*b* | *4* |")
        .rows,
      [
        ["Total", 12],
        ["`x` and `y`", 3],
        ["*a*b*", 4],
      ],
    );
    assert.deepStrictEqual(parse("ts|1200\ncss|300").rows, [
      ["ts", 1200],
      ["css", 300],
    ]);
  });

  test("joins the lines of cells over several lines in tables drawn by sqlite3 and psql", () => {
    const expected = {
      columns: ["lang", "lines", "note"],
      rows: [
        ["ts", 1200, "line one\nline two"],
        ["css", 300, "short"],
        ["js", null, "x"],
      ],
    };
    for (const table of [
      // sqlite3 -box and -table draw a rule between each row and the next when one has a newline.
      [
        "╭──────┬───────┬──────────╮",
        "│ lang │ lines │   note   │",
        "╞══════╪═══════╪══════════╡",
        "│ ts   │  1200 │ line one │",
        "│      │       │ line two │",
        "├──────┼───────┼──────────┤",
        "│ css  │   300 │ short    │",
        "├──────┼───────┼──────────┤",
        "│ js   │       │ x        │",
        "╰──────┴───────┴──────────╯",
      ],
      [
        "+------+-------+----------+",
        "| lang | lines |   note   |",
        "+------+-------+----------+",
        "| ts   |  1200 | line one |",
        "|      |       | line two |",
        "+------+-------+----------+",
        "| css  |   300 | short    |",
        "+------+-------+----------+",
        "| js   |       | x        |",
        "+------+-------+----------+",
      ],
      // psql marks a newline in a cell after its text, with "+" or, in unicode lines, "↵".
      [
        " lang | lines |   note   ",
        "------+-------+----------",
        " ts   |  1200 | line one+",
        "      |       | line two",
        " css  |   300 | short",
        " js   |       | x",
        "(3 rows)",
      ],
      [
        " lang │ lines │   note   ",
        "──────┼───────┼──────────",
        " ts   │  1200 │ line one↵",
        "      │       │ line two",
        " css  │   300 │ short",
        " js   │       │ x",
        "(3 rows)",
      ],
    ]) {
      assert.deepStrictEqual(parse(table.join("\n")), expected, table.join("\n"));
    }
    // In any column, and with "." where psql wraps text, at both ends of the break.
    assert.deepStrictEqual(
      parse(
        [
          "   note   | lines | wrapped ",
          "----------+-------+---------",
          " line one+|  1200 | a long .",
          " line two |       |.note",
          " short    |   300 | x",
        ].join("\n"),
      ).rows,
      [
        ["line one\nline two", 1200, "a long note"],
        ["short", 300, "x"],
      ],
    );
    // A "+" or "." in the text of a cell is not a mark, as psql writes a space after the text.
    assert.deepStrictEqual(parse(" grade | n  \n-------+----\n A+    | 1.\n B     | 2\n").rows, [
      ["A+", 1],
      ["B", 2],
    ]);
    // psql draws no line at the left of the first column, which may be empty.
    assert.deepStrictEqual(parse(" a | b\n---+---\n   | 1\n x | 2").rows, [
      [null, 1],
      ["x", 2],
    ]);
    // A table with a line at the left, under a rule without junctions, has no empty first cell.
    for (const rule of ["----------------", "================"]) {
      for (const right of [" |", ""]) {
        const lines = ["| Name | Score", "| Ann  | 90   ", "| Bob  | 85   "].map((l) => l + right);
        assert.deepStrictEqual(parse([lines[0], rule, ...lines.slice(1)].join("\n")), {
          columns: ["Name", "Score"],
          rows: [
            ["Ann", 90],
            ["Bob", 85],
          ],
        });
      }
    }
    // Marks are read only where a table has a space on each side of the text of a cell.
    assert.deepStrictEqual(parse("No.|name\n---+----\n1  |a\n2  |b"), {
      columns: ["No.", "name"],
      rows: [
        [1, "a"],
        [2, "b"],
      ],
    });
  });

  test("tells rows that sqlite3 draws over several lines from groups of rows between rules", () => {
    /** A table as sqlite3 -table or -box draws it, with a rule for each "-" among the `rows`. */
    const draw = (box: boolean, header: string[], rows: (string[] | "-")[]): string => {
      const lines = [header, ...rows].filter((row) => row !== "-");
      const widths = header.map((_, i) => Math.max(...lines.map((row) => row[i]?.length ?? 0)));
      const [v, h, left, cross, right] = box
        ? ["│", "─", "├", "┼", "┤"]
        : ["|", "-", "+", "+", "+"];
      const rule = (l = left, c = cross, r = right, line = h) =>
        `${l}${widths.map((w) => line.repeat(w + 2)).join(c)}${r}`;
      const row = (cells: string[]) =>
        `${v} ${widths.map((w, i) => (cells[i] ?? "").padEnd(w)).join(` ${v} `)} ${v}`;
      return [
        box ? rule("╭", "┬", "╮") : rule(),
        row(header),
        box ? rule("╞", "╪", "╡", "═") : rule(),
        ...rows.map((cells) => (cells === "-" ? rule() : row(cells))),
        box ? rule("╰", "┴", "╯") : rule(),
      ].join("\n");
    };
    // Each shape: the lines between the header and the bottom rule, and the rows read from them.
    const shapes: [string, (string[] | "-")[], (string | number | null)[][]][] = [
      [
        "sqlite3, a newline in a later column",
        [
          ["ts", "1200", "line one"],
          ["", "", "line two"],
          "-",
          ["css", "300", "short"],
          "-",
          ["js", "", "x"],
        ],
        [
          ["ts", 1200, "line one\nline two"],
          ["css", 300, "short"],
          ["js", null, "x"],
        ],
      ],
      [
        "sqlite3, newlines in every row",
        [["a", "1", "x"], ["", "", "y"], "-", ["b", "2", "z"], ["", "", "w"]],
        [
          ["a", 1, "x\ny"],
          ["b", 2, "z\nw"],
        ],
      ],
      [
        "sqlite3, a newline in the first column, between enough rows of one line",
        [["one", "1"], ["two", ""], "-", ["b", "2"], "-", ["c", "3"], "-", ["d", "4"]],
        [
          ["one\ntwo", 1],
          ["b", 2],
          ["c", 3],
          ["d", 4],
        ],
      ],
      [
        "sqlite3, a newline in the first column of few rows, which is as a group of rows",
        [["one", "1"], ["two", ""], "-", ["b", "2"], "-", ["c", "3"]],
        [
          ["one", 1],
          ["two", null],
          ["b", 2],
          ["c", 3],
        ],
      ],
      [
        "sqlite3, two rows, the first over two lines, which is as rows above a total",
        [["ts", "1200", "line one"], ["", "", "line two"], "-", ["css", "300", "short"]],
        [
          ["ts", 1200, "line one"],
          [null, null, "line two"],
          ["css", 300, "short"],
        ],
      ],
      [
        "groups with missing values",
        [["north", "10"], ["south", ""], "-", ["east", "30"], ["west", ""], "-", ["total", "40"]],
        [
          ["north", 10],
          ["south", null],
          ["east", 30],
          ["west", null],
          ["total", 40],
        ],
      ],
      [
        "groups with missing values in several columns",
        [
          ["north", "1", "3"],
          ["south", "", "4"],
          "-",
          ["east", "2", "5"],
          ["west", "", "6"],
          "-",
          ["total", "3", "18"],
        ],
        [
          ["north", 1, 3],
          ["south", null, 4],
          ["east", 2, 5],
          ["west", null, 6],
          ["total", 3, 18],
        ],
      ],
      [
        "groups named only in their first row",
        [
          ["a", "oslo", "10"],
          ["", "bergen", "20"],
          "-",
          ["b", "rome", "5"],
          ["", "milan", "6"],
          "-",
          ["all", "", "41"],
        ],
        [
          ["a", "oslo", 10],
          [null, "bergen", 20],
          ["b", "rome", 5],
          [null, "milan", 6],
          ["all", null, 41],
        ],
      ],
      [
        "sparse rows above a total",
        [["a", "1", ""], ["b", "", "2"], ["c", "3", ""], "-", ["total", "4", "2"]],
        [
          ["a", 1, null],
          ["b", null, 2],
          ["c", 3, null],
          ["total", 4, 2],
        ],
      ],
      [
        "a group named only in its first row above a total",
        [["a", "1"], ["", "2"], "-", ["t", "3"]],
        [
          ["a", 1],
          [null, 2],
          ["t", 3],
        ],
      ],
      [
        "sparse rows with a rule between each",
        [["a", "1"], "-", ["b", ""], "-", ["c", "3"]],
        [
          ["a", 1],
          ["b", null],
          ["c", 3],
        ],
      ],
      [
        "no rules between rows",
        [
          ["ts", "line one"],
          ["", "line two"],
        ],
        [
          ["ts", "line one"],
          [null, "line two"],
        ],
      ],
    ];
    for (const [shape, rows, expected] of shapes) {
      const header = ["name", "a", "b"].slice(0, rows.find((row) => row !== "-")?.length);
      for (const box of [false, true]) {
        const table = draw(box, header, rows);
        assert.deepStrictEqual(parse(table).rows, expected, `${shape}:\n${table}`);
      }
    }
  });

  test("reads the first Markdown table among text and other tables, and says so", () => {
    const answer = [
      "Here are the line counts:",
      "",
      "| lang | lines |",
      "|------|------:|",
      "| ts   | 1,200 |",
      "| css  |   300 |",
      "",
      "TypeScript dominates.",
    ].join("\n");
    const table = parseTable(answer);
    assert.deepStrictEqual(table.rows, [
      ["ts", 1200],
      ["css", 300],
    ]);
    assert.deepStrictEqual(
      table.columns.map((column) => column.name),
      ["lang", "lines"],
    );
    assert.strictEqual(
      table.note,
      "Only the Markdown table (lines 3\u20136) was read, not the text around it.",
    );
    // Prose directly above the header. As in GFM, a line without a pipe below the table is a row,
    // up to a blank line or the start of another block, but not below the last row, where it is
    // more likely a caption or a footer.
    assert.deepStrictEqual(parse("Results:\na | b\n--|--\nx | 1\ngoes on\ny | 2\nDone.").rows, [
      ["x", 1],
      ["goes on", null],
      ["y", 2],
    ]);
    for (const text of [
      "| a | b |\n|---|---|\n| x | 1 |\nTotal rows: 1",
      "| a |\n|---|\n| x |\ny",
    ]) {
      const table = parseTable(text);
      assert.strictEqual(table.rows.length, text.includes("Total") ? 1 : 2, text);
    }
    assert.strictEqual(
      parseTable("| a | b |\n|---|---|\n| x | 1 |\nSource: a survey").note,
      "Only the Markdown table (lines 1\u20133) was read, not the text around it.",
    );
    for (const below of [
      "Done.",
      "",
      "> Done.",
      "## Done",
      "- Done",
      "1. Done",
      "```",
      "***",
      "<p>",
    ]) {
      const text = `Results:\na | b\n--|--\nx | 1\n${below}\nDone.`;
      const table = parseTable(text);
      assert.deepStrictEqual(table.rows, [["x", 1]], text);
      assert.strictEqual(
        table.note,
        "Only the Markdown table (lines 2\u20134) was read, not the text around it.",
        text,
      );
    }
    assert.strictEqual(
      parseTable(`${answer}\n\n| a | b |\n|---|---|\n| y | 2 |`).note,
      "The data has 2 Markdown tables; only the first (lines 3\u20136) was read.",
    );
    // Rows that the table left out are noted too.
    assert.strictEqual(
      parseTable("Top files:\n| file | lines |\n|---|---|\n| a | 1 |\n| ... | ... |").note,
      "Only the Markdown table (lines 2\u20135) was read, not the text around it. Only the rows " +
        "that the output shows were read, not those it left out.",
    );
    // A table alone has no note, and a delimiter row needs as many cells as the header.
    assert.strictEqual(parseTable("| a | b |\n|---|---|\n| x | 1 |").note, undefined);
    assert.strictEqual(
      parseTable("intro\n| a | b | c |\n|---|---|\n| x | 1 | 2 |").note,
      undefined,
    );
  });

  test("leaves out titles and comments above delimited values, and says so", () => {
    const rows = [
      ["a", 1.5],
      ["b", 2],
    ];
    for (const [text, format] of [
      ["Sales by region\nregion,sales\na,1.5\nb,2", "auto"],
      ["# ------\n# Audience Overview\n#\n\nregion;sales\na;1,5\nb;2", "auto"],
      ["Sales by region\nregion\tsales\na\t1.5\nb\t2", "tsv"],
      ["Sales by region\nregion,sales\na,1.5\nb,2", "csv"],
    ] as const) {
      const table = parseTable(text, format);
      assert.deepStrictEqual(table.rows, rows, text);
      assert.match(
        table.note ?? "",
        /^Only the table from line \d was read, not the text above it\.$/,
      );
    }
    assert.throws(
      () => parseTable('Sales by region\nregion,sales\n"a,1'),
      /starts on line 3, column 1,/,
    );
    assert.strictEqual(
      parseTable("Sales by region\nregion,sales\na,1.5\n...\nb,2").note,
      "Only the table from line 2 was read, not the text above it. Only the rows that the " +
        "output shows were read, not those it left out.",
    );
    // Lines of text, such as commit subjects, a single one of which has a comma.
    const log = "a1b2c3 Fix the parser\nd4e5f6 Add tests, docs\n0a0b0c Bump version";
    assert.strictEqual(parseTable(log).note, undefined);
    // A single column of decimal commas, and a header aligned with the columns, are no titles.
    assert.deepStrictEqual(parse("value\n1,5\n2,5").rows, [[1.5], [2.5]]);
    assert.deepStrictEqual(parse("NAME  PORTS\nweb   80, 443\ndb    5432, 5433").rows, [
      ["web", "80, 443"],
      ["db", "5432, 5433"],
    ]);
  });

  test("parses git diff --stat output as files and their numbers of changed lines", () => {
    const stat = [
      " README.md                    |   3 +-",
      " src/{old => new}/prompt.ts   | 149 +++++++++++++++++++++-----",
      " images/logo.png              | Bin 0 -> 1234 bytes",
      " scripts/run.sh               |   0",
      " 4 files changed, 120 insertions(+), 32 deletions(-)",
    ].join("\n");
    assert.deepStrictEqual(parse(stat), {
      columns: ["File", "Changes"],
      rows: [
        ["README.md", 3],
        ["src/{old => new}/prompt.ts", 149],
        ["images/logo.png", null],
        ["scripts/run.sh", 0],
      ],
    });
    // Without the summary, the bars tell it apart from a table drawn with pipes.
    assert.deepStrictEqual(parse("a.ts | 12 ++++--\nb.ts | 3 +++").rows, [
      ["a.ts", 12],
      ["b.ts", 3],
    ]);
    assert.deepStrictEqual(parse("a | 12\nb | 3").rows, [
      ["a", 12],
      ["b", 3],
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

  test("keeps rows of single dashes, unless they underline one-letter names", () => {
    const missing = [null, null];
    assert.deepStrictEqual(parse("x  1  2\n-  -  -\ny  3  4"), {
      columns: ["Column 1", "Column 2", "Column 3"],
      rows: [
        ["x", 1, 2],
        ["-", ...missing],
        ["y", 3, 4],
      ],
    });
    assert.deepStrictEqual(parse("- - -\nx 1 2").rows, [
      ["-", ...missing],
      ["x", 1, 2],
    ]);
    assert.deepStrictEqual(parse("name  size\na     1\n-     -\nb     2").rows, [
      ["a", 1],
      ["-", null],
      ["b", 2],
    ]);
    assert.deepStrictEqual(parse("x\t1\n-\t-\ny\t2").rows, [
      ["x", 1],
      ["-", null],
      ["y", 2],
    ]);
    assert.deepStrictEqual(parse("a b\n- -\n1 2"), { columns: ["a", "b"], rows: [[1, 2]] });
    assert.deepStrictEqual(parse("a\tb\n-\t-\n1\t2"), { columns: ["a", "b"], rows: [[1, 2]] });
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

  test("leaves out the colors and links of terminal output", () => {
    const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
    assert.deepStrictEqual(
      parse(
        `\x1b[1mdir\x1b[0m  \x1b[1;4msize\x1b[m\n${link("file:///src", "src")}   \x1b[38;5;2m12\x1b[0m\ntest  3`,
      ),
      {
        columns: ["dir", "size"],
        rows: [
          ["src", 12],
          ["test", 3],
        ],
      },
    );
  });

  test("uses a header for whitespace output with numeric columns", () => {
    assert.deepStrictEqual(parse("dir size\nsrc 12\ntest 3").columns, ["dir", "size"]);
  });

  test("parses 100,000 rows", function () {
    // Takes about half a second, or longer on a busy machine; quadratic time would take minutes.
    this.timeout(10_000);
    const lines = Array.from({ length: 100_000 }, (_, i) => `row ${i} /a`);
    assert.strictEqual(parse(lines.join("\n")).rows.length, 100_000);
    assert.strictEqual(parse(lines.join("\n").replaceAll(" ", ",")).rows.length, 100_000);
    const df = parse(["Name Size Mounted on", ...lines].join("\n"));
    assert.deepStrictEqual(df.columns, ["Name", "Size", "Mounted on"]);
  });

  test("names 100,000 equally named columns", () => {
    const columns = parse(`${"x,".repeat(100_000)}x\n${"1,".repeat(100_000)}1`).columns;
    assert.strictEqual(columns.length, 100_001);
    assert.strictEqual(columns[100_000], "x (100001)");
  });

  test("parses a very wide header with more words than the columns below it", () => {
    const words = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
    const table = parse(`${words(60_000, "h")}\n${words(30_000, "")}`);
    assert.strictEqual(table.rows.length, 1);
    // The last column takes the words left over.
    assert.strictEqual(table.columns.length, 30_000);
    assert.ok(table.columns[29_999]?.startsWith("h29999 h30000 "));
  });

  test("parses a long line that almost is a rule", () => {
    assert.strictEqual(parse(`a 1\n${"-".repeat(1_000_000)}x 2`).rows.length, 2);
  });

  test("parses a line of many spaces below a line with pipes", () => {
    const spaces = " ".repeat(1_000_000);
    assert.strictEqual(parse(`a|b\n${spaces}x|1\ny|2`).rows.length, 2);
    assert.strictEqual(parse(`a|b\n--|--${spaces}x|\ny|2`).rows.length, 2);
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

  test("reads JSON Lines with any line endings, and says on which line of the text one fails", () => {
    for (const newline of ["\n", "\r\n", "\r"]) {
      const lines = ['{"name": "a", "n": 1}', "", '{"name": "b", "n": 2}', ""];
      assert.deepStrictEqual(parse(lines.join(newline)), {
        columns: ["name", "n"],
        rows: [
          ["a", 1],
          ["b", 2],
        ],
      });
      assert.throws(
        () => parse(['{"n": 1}', "", '{"n": }'].join(newline)),
        /The JSON value on line 3 is not valid/,
      );
    }
    assert.throws(() => parse('{"n": 1}\n\n{"n": 2}\n\n{"n": }'), /value on line 5 /);
    assert.throws(() => parse('\n\n{"n": 1}\n\n{"n": '), /value on line 5 /);
  });

  test("reads JSON values over several lines, as jq prints them", () => {
    const values = ['{\n  "name": "a } [ \\"",\n  "n": 1\n}', '{\n  "name": "b",\n  "n": 2\n}'];
    assert.deepStrictEqual(parse(values.join("\n")), {
      columns: ["name", "n"],
      rows: [
        ['a } [ "', 1],
        ["b", 2],
      ],
    });
    assert.deepStrictEqual(parse("1\n2", "json"), { columns: ["value"], rows: [[1], [2]] });
    assert.throws(() => parse(`${values[0]}\n{\n  "n":\n}`), /value on line 5 /);
  });

  test("reads NaN and Infinity in JSON, as Python writes them, as empty", () => {
    const lines = '{"k": "NaN", "v": NaN}\n{"k": "Infinity", "v": -Infinity}\n{"k": "b", "v": 2}';
    const expected = {
      columns: ["k", "v"],
      rows: [
        ["NaN", null],
        ["Infinity", null],
        ["b", 2],
      ],
    };
    assert.deepStrictEqual(parse(lines), expected);
    assert.deepStrictEqual(parse(`[${lines.replaceAll("\n", ", ")}]`), expected);
    // In linear time, also with a string left open: each quote in it may not start another.
    for (const end of ["", "\\"]) {
      assert.throws(() => parse(`NaN "${'\\"'.repeat(500_000)}${end}`, "json"), /not valid JSON/);
    }
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
    // What was left out beside the rows is noted, after what an envelope left out.
    assert.strictEqual(
      parseTable('{"items": [{"k": "a"}], "count": 1}').note,
      'Only "items" was read, not "count" beside it.',
    );
    assert.strictEqual(
      parseTable('{"status": "ok", "data": {"items": [{"k": "a"}], "count": 1}}').note,
      'Only "data" was read, not "status" beside it. Only "items" was read, not "count" beside it.',
    );
    assert.strictEqual(parseTable('{"items": [{"k": "a"}]}').note, undefined);
    assert.deepStrictEqual(parse('{"label": ["a", "b"], "count": [1, 2]}'), {
      columns: ["label", "count"],
      rows: [
        ["a", 1],
        ["b", 2],
      ],
    });
  });

  test("flattens nested JSON objects into dotted column names", () => {
    assert.deepStrictEqual(
      parse('[{"name": "a", "cpu": {"user": 1, "io": {"wait": 2}}}, {"name": "b", "cpu": {}}]'),
      {
        columns: ["name", "cpu.user", "cpu.io.wait", "cpu"],
        rows: [
          ["a", 1, 2, null],
          ["b", null, null, "{}"],
        ],
      },
    );
  });

  test("looks into JSON objects that wrap a single object", () => {
    assert.deepStrictEqual(
      parse('{"data": {"repo": {"issues": [{"title": "x", "author": {"login": "a"}}]}}}'),
      { columns: ["title", "author.login"], rows: [["x", "a"]] },
    );
    // In an envelope, beside plain values about the answer, as the Prometheus API answers.
    const prometheus = parseTable(
      JSON.stringify({
        status: "success",
        data: {
          resultType: "vector",
          result: [{ metric: { job: "api" }, value: [1735689600, "0.5"] }],
        },
      }),
    );
    assert.deepStrictEqual(prometheus.rows, [["api", '[1735689600,"0.5"]']]);
    assert.strictEqual(
      prometheus.note,
      'Only "data" was read, not "status" beside it. Only "result" was read, not "resultType" beside it.',
    );
    // Or beside plain values about a map of records, as npm ls --json answers, but only the
    // outermost: the dependencies of a single dependency are not read in its place.
    const npm = (dependencies: object) =>
      parseTable(JSON.stringify({ version: "1.0.0", name: "app", dependencies }));
    const two = npm({ a: { version: "1.0.0" }, b: { version: "2.1.0" } });
    assert.deepStrictEqual(two.rows, [
      ["a", "1.0.0"],
      ["b", "2.1.0"],
    ]);
    assert.strictEqual(two.note, 'Only "dependencies" was read, not "version", "name" beside it.');
    const one = npm({ a: { version: "1.0.0", dependencies: { b: { version: "2.1.0" } } } });
    assert.deepStrictEqual(
      one.columns.map((column) => column.name),
      ["name", "version", "dependencies.b.version"],
    );
    assert.deepStrictEqual(one.rows, [["a", "1.0.0", "2.1.0"]]);
    // A record with a nested object is not an envelope, as a single GitHub repository's owner.
    for (const record of [
      { id: 1, name: "x", stargazers_count: 10, owner: { login: "y", id: 2 } },
      { cpu: 5, mem: 7, disk: { used: 1, free: 2 } },
    ]) {
      assert.throws(() => parse(JSON.stringify(record)), /The JSON object must map names/);
    }
    assert.deepStrictEqual(parse('{"stats": {"ts": 120, "css": 30}}'), {
      columns: ["name", "value"],
      rows: [
        ["ts", 120],
        ["css", 30],
      ],
    });
  });

  test("parses deeply nested JSON objects without running out of stack", () => {
    const nested = (depth: number, inner: string) =>
      `${'{"a":'.repeat(depth)}${inner}${"}".repeat(depth)}`;
    assert.deepStrictEqual(parse(nested(100_000, '{"x": 1, "y": 2}')).columns, ["name", "value"]);
    // Objects deeper than ten levels stay JSON text.
    const table = parse(`[${nested(100_000, "1")}]`);
    assert.deepStrictEqual(table.columns, [Array(10).fill("a").join(".")]);
    assert.strictEqual(table.rows[0]?.[0], nested(99_990, "1"));
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

  test("names missing and duplicate header columns, without taking the names of others", () => {
    assert.deepStrictEqual(parse(",x,x\na,1,2").columns, ["Column 1", "x", "x (2)"]);
    const table = parseTable(",x,x,x (2),Column 1\na,1,2,3,4");
    assert.deepStrictEqual(
      table.columns.map(({ name }) => name),
      ["Column 1 (2)", "x", "x (3)", "x (2)", "Column 1"],
    );
    assert.strictEqual(table.rows[0]?.[findColumn(table, "x (2)", "value")], 3);
    assert.strictEqual(table.rows[0]?.[findColumn(table, "Column 1", "value")], 4);
  });

  test("generated JSON row keys do not rename existing value columns", () => {
    const row = { " name ": "A", key: 42, "key (2)": 99 };
    const table = parseTable(JSON.stringify({ first: row, second: row }));
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
    // As pandas writes a pivot table, with an empty corner.
    assert.deepStrictEqual(parse(",2024,2025\nNorth,10,14").columns, ["Column 1", "2024", "2025"]);
    assert.deepStrictEqual(parse("country,2020,2021,2022\nNorway,5.4,5.4,5.5").columns, [
      "country",
      "2020",
      "2021",
      "2022",
    ]);
    // A single year of recent times, above numbers of another order of magnitude.
    assert.deepStrictEqual(parse("region,2024\nNorth,10\nSouth,20"), {
      columns: ["region", "2024"],
      rows: [
        ["North", 10],
        ["South", 20],
      ],
    });
    assert.deepStrictEqual(parse("region,2024\nNorth,45000\nSouth,-38000").columns, [
      "region",
      "2024",
    ]);
    assert.deepStrictEqual(parse("Jan,2034\nFeb,1840\nMar,950"), {
      columns: ["Column 1", "Column 2"],
      rows: [
        ["Jan", 2034],
        ["Feb", 1840],
        ["Mar", 950],
      ],
    });
    assert.deepStrictEqual(parse("Alice,1990\nBob,1985").columns, ["Column 1", "Column 2"]);
    assert.deepStrictEqual(parse("apples,1500\npears,300").columns, ["Column 1", "Column 2"]);
  });

  test("preserves original inferred header spelling while normalizing ragged rows", () => {
    assert.deepStrictEqual(parse("region,02024,2025.0\nNorth,10\nSouth,20,18"), {
      columns: ["region", "02024", "2025.0"],
      rows: [
        ["North", 10, null],
        ["South", 20, 18],
      ],
    });
  });

  test("treats a first row without a numeric column below it as data", () => {
    const table = parseTable("a,b\nc,d");
    assert.strictEqual(table.header, false);
    assert.deepStrictEqual(table.rows, [
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("detects a CSV header above columns of categories", () => {
    assert.deepStrictEqual(parse("name;city\nAlice;Paris\nBob;Rome\nCarl;Paris"), {
      columns: ["name", "city"],
      rows: [
        ["Alice", "Paris"],
        ["Bob", "Rome"],
        ["Carl", "Paris"],
      ],
    });
    // A first row that recurs in its column, or has an empty cell, is data.
    for (const text of ["Rome,x\nParis,y\nRome,y", ",city\nAlice,Paris\nBob,Paris"]) {
      assert.strictEqual(parseTable(text).header, false, text);
    }
    // Command output of text only rarely has a header.
    assert.strictEqual(parseTable("Bob\tFix\nAlice\tAdd\nAlice\tTest").header, false);
  });

  test("column inference includes the first data row and excludes inferred headers", () => {
    const cases = [
      { records: [[1], ["text"]], header: false, numeric: true, rows: [[1], ["text"]] },
      { records: [["text"], [1]], header: true, numeric: true, rows: [[1]] },
      {
        records: [
          [1, "N/A"],
          [2, 3],
        ],
        header: false,
        numeric: true,
        rows: [
          [1, null],
          [2, 3],
        ],
      },
      {
        records: [
          ["label", "N/A"],
          ["a", 3],
        ],
        header: true,
        numeric: true,
        rows: [["a", 3]],
      },
      { records: [["N/A"]], header: false, numeric: false, rows: [["N/A"]] },
      { records: [[7]], header: false, numeric: true, rows: [[7]] },
      {
        records: [
          ["person", 2024, 2025],
          ["Alice", 2023, 2024],
        ],
        header: false,
        numeric: true,
        rows: [
          ["person", 2024, 2025],
          ["Alice", 2023, 2024],
        ],
      },
    ];
    for (const { records, header, numeric, rows } of cases) {
      const table = parseTable(JSON.stringify(records));
      assert.strictEqual(table.header, header);
      assert.strictEqual(table.columns.at(-1)?.numeric, numeric);
      assert.deepStrictEqual(table.rows, rows);
    }
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
        "Greenland,#VALUE!,0.06,#DIV/0!,#REF!",
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
      ["Greenland", null, 0.06, null, "#REF!"],
    ]);
    // Infinities, which no chart can place, as pandas, R and JavaScript write them.
    assert.deepStrictEqual(parse("k,v\na,1\nb,inf\nc,-Inf\nd,Infinity\ne,2").rows, [
      ["a", 1],
      ["b", null],
      ["c", null],
      ["d", null],
      ["e", 2],
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
    // Lines and columns are counted in the whole text, not from the start of the value.
    assert.throws(
      () => parseTable('[\n  {"a": 1,}\n]'),
      /^Error: The data is not valid JSON: Expected double-quoted property name on line 2, column 11\.$/,
    );
    assert.throws(
      () => parseTable('{"a": 1}\n{\n  "a": 2,\n}'),
      /^Error: The JSON value on line 2 is not valid JSON: Expected double-quoted property name on line 4, column 1\.$/,
    );
    // V8 gives text around an unexpected token rather than its position.
    for (const [json, place] of [
      ['[\n  {"a": 1},\n  {"a": x}\n]', "'x' on line 3, column 9"],
      ['{"a": [1, {"b": 2}, ]}', "']' on line 1, column 21"],
      ['{"a": tru}', "'}' on line 1, column 10"],
      [`[\n${'"long text", '.repeat(10)}nope]`, "'o' on line 2, column 132"],
    ] as const) {
      assert.throws(
        () => parseTable(json),
        new RegExp(`^Error: The data is not valid JSON: Unexpected token ${place}\\.$`),
        json,
      );
    }
    assert.throws(
      () => parseTable('{"a": 1}\n{"a": [1,\n2,]}'),
      /^Error: The JSON value on line 2 is not valid JSON: Unexpected token '\]' on line 3, column 3\.$/,
    );
    // The error in JSON with NaN or Infinity, as Python writes it, is not the first of them.
    assert.throws(
      () => parseTable('{"x": 1, "y": NaN, "z": bad}'),
      /^Error: The data is not valid JSON: Unexpected token 'b' on line 1, column 25\.$/,
    );
    assert.throws(
      () => parseTable('[{"a": NaN}, {"a": -Infinity, "b" 2}]'),
      /^Error: The data is not valid JSON: Expected ':' after property name on line 1, column 35\.$/,
    );
    assert.throws(
      () => parseTable('{"a": NaN}\n{"a": Infinity, }'),
      /^Error: The JSON value on line 2 is not valid JSON: Expected double-quoted property name on line 2, column 17\.$/,
    );
    assert.throws(() => parseTable("[]"), /array is empty/);
    assert.throws(() => parseTable('{"data": []}'), /array is empty/);
    assert.throws(() => parseTable("[{}]"), /holds no values/);
    assert.throws(
      () => parseTable("| a | b |\n|---|---|"),
      /^Error: The data has a header \("a", "b"\) but no rows below it\.$/,
    );
    assert.throws(
      () => parseTable(`${"|a".repeat(10)}|\n${"|-".repeat(10)}|`),
      /\("a", "a \(2\)", "a \(3\)", "a \(4\)", "a \(5\)", 5 more\) but no rows/,
    );
    // Quoted line breaks count as lines, however they are written.
    for (const newline of ["\n", "\r", "\r\n"]) {
      assert.throws(
        () => parseTable(["a,b", '"x', 'y",1', '"z"q,2'].join(newline), "csv"),
        /on line 4, column 4\./,
      );
    }
    assert.throws(
      () => parseTable('[{"a": 1}, {"a": 2}, [3]]'),
      /^Error: The JSON array mixes kinds of items: item 1 is an object, but item 3 is an array\./,
    );
    assert.throws(() => parseTable("1", "json"), /^Error: The JSON is a plain value, not an array/);
    assert.throws(
      () => parseTable('a,b\nc,"d\ne,f', "csv"),
      /^Error: The quoted field that starts on line 2, column 3, is not closed\. A quote in a quoted field is written twice, as in "say ""hi"""\.$/,
    );
  });
});
