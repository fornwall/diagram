import * as assert from "node:assert";
import { describeTable, findColumn } from "../chartColumns";
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
