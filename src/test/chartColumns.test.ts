import * as assert from "node:assert";
import { defaultValueColumns, describeTable, findColumn, findColumns } from "../chartColumns";
import { parseTable } from "../data";

suite("chartColumns", () => {
  test("finds a column by its exact name first, and otherwise ignoring case and spaces", () => {
    const table = parseTable('[{"Value": 1, "value": 2}]');
    assert.strictEqual(findColumn(table, "value", "value"), 1);
    assert.strictEqual(findColumn(table, " VALUE ", "filter"), 0);
    assert.throws(
      () => findColumn(table, "missing", "facet"),
      /Unknown facet column.*Value.*value/,
    );
  });

  test("resolves wide selections with exact names before loose matches and rejects duplicates", () => {
    let reads = 0;
    const columns = Array.from({ length: 3000 }, (_, i) => ({
      get name() {
        reads++;
        return `field ${i}`;
      },
      numeric: true,
    }));
    columns.push({ name: "FIELD 0", numeric: true });
    const table = { columns, rows: [columns.map((_, i) => i)], header: true };
    const names = columns.map(({ name }) => name).reverse();
    reads = 0;
    assert.deepStrictEqual(
      findColumns(table, names, "valueColumns"),
      [...columns.keys()].reverse(),
    );
    assert.ok(
      reads <= columns.length * 4,
      `${reads} column names read for ${names.length} selections`,
    );
    assert.deepStrictEqual(findColumns(table, ["FIELD 0", " field 1 "], "labelColumn"), [3000, 1]);
    reads = 0;
    assert.deepStrictEqual(findColumns(table, [], "labelColumn"), []);
    assert.deepStrictEqual(findColumns(table, ["field 0"], "labelColumn"), [0]);
    assert.strictEqual(reads, 1);
    assert.throws(
      () => findColumns(table, ["field 0", " field 0 "], "valueColumns"),
      /"valueColumns" names the column "field 0" twice/,
    );
    assert.throws(
      () => findColumns(table, ["missing"], "labelColumn"),
      /Unknown label column "missing"/,
    );
  });

  test("infers values without repeatedly scanning a wide selection of label columns", () => {
    const columns = Array.from({ length: 1000 }, (_, i) => ({
      name: `field ${i}`,
      numeric: true,
    }));
    const table = { columns, rows: [columns.map((_, i) => i)], header: true };
    let reads = 0;
    const labels = new Proxy(
      [...columns.keys()].filter((i) => i % 2 === 0),
      {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) reads++;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    assert.deepStrictEqual(
      defaultValueColumns(table, labels, 1),
      [...columns.keys()].filter((i) => i % 2 !== 0),
    );
    assert.ok(reads <= labels.length * 2, `${reads} reads of ${labels.length} label columns`);
  });

  test("describes a table by its columns and first rows", () => {
    const table = parseTable(
      [
        "dir,size,share,note",
        "a,1K,1%,",
        "b,2,2%,",
        "c,3,3%,",
        "d,4,4%,",
        "e,5,5%,",
        "f,6,6%,",
      ].join("\n"),
    );
    assert.strictEqual(
      describeTable(table),
      [
        '6 rows; columns: "dir" (text), "size" (in bytes), "share" (percentages), "note" (empty)',
        "First 5 rows:",
        '["a",1024,1,null]',
        '["b",2,2,null]',
        '["c",3,3,null]',
        '["d",4,4,null]',
        '["e",5,5,null]',
      ].join("\n"),
    );
    assert.strictEqual(
      describeTable(parseTable("x\n1")),
      '1 row; columns: "x" (numbers)\nRows:\n[1]',
    );
    assert.match(
      describeTable({ columns: [{ name: "x", numeric: true }], rows: [[null]], header: true }),
      /"x" \(empty\)/,
    );
    assert.strictEqual(
      describeTable(parseTable("Sizes:\n| x |\n|---|\n| 1 |")),
      '1 row; columns: "x" (numbers)\nOnly the Markdown table (lines 2–4) was read, not the text around it.\nRows:\n[1]',
    );
  });

  test("shortens long text when describing a table", () => {
    const long = "x".repeat(10_000);
    const table = parseTable(
      `title,body,n\n${Array.from({ length: 6 }, (_, i) => `t${i},${long},${i}`).join("\n")}\nt,${long},${long}`,
    );
    const description = describeTable(table);
    assert.ok(description.length < 2_000, `${description.length} characters`);
    assert.match(description, /\["t0","x{100}…",0\]/);
    assert.match(description, /"n" \(numbers, 1 text cell: "x{40}…"\)/);
  });

  test("lists the first 60 columns of a wide table, and how many more there are", () => {
    const names = Array.from({ length: 3000 }, (_, i) => `column ${i}`);
    const table = parseTable(`${names.join(",")}\n${names.map((_, i) => i).join(",")}`);
    const description = describeTable(table);
    assert.ok(description.length < 3_000, `${description.length} characters`);
    assert.match(description, /"column 59" \(numbers\), and 2,940 more\nRows, in their first 60 /);
    assert.match(description, /\n\[0,1,2,.*,59\]$/);
    assert.throws(
      () => findColumn(table, "missing", "label"),
      (error: Error) => /"column 59", and 2,940 more\.$/.test(error.message),
    );
    // A name past the listed ones comes up among those most like the one asked for.
    assert.throws(
      () => findColumn(table, "Column_2999", "label"),
      (error: Error) =>
        /and 2,940 more\. Of the others, these are named most like it: "column 2999", "column 60", /.test(
          error.message,
        ),
    );
  });

  test("points out the text cells of numeric columns when describing a table", () => {
    assert.match(
      describeTable(parseTable("size,file\n1,a\n1;5X,b\n3,c")),
      /"size" \(numbers, 1 text cell: "1;5X"\), "file" \(text\)/,
    );
    assert.match(
      describeTable(parseTable("n\n1\n2\n3\n4\n5\na\nb\nc\nd")),
      /"n" \(numbers, 4 text cells: "a", "b", "c", …\)/,
    );
  });
});
