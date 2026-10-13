import * as assert from "node:assert";
import { parseNumber, scale } from "../dataNumber";

suite("dataNumber", () => {
  test("reads plain, grouped, percent, exponent and size numbers", () => {
    const cases: [string, number, string?][] = [
      ["42", 42],
      [" -3 ", -3],
      ["12.5", 12.5],
      [".5", 0.5],
      ["1,234", 1234],
      ["1,234,567.5", 1234567.5],
      ["1e3", 1000],
      ["12.5%", 12.5, "%"],
      ["1.5K", 1500],
      ["150k", 150_000],
      ["12M", 12e6],
      ["1.2B", 1.2e9],
      ["1.2bn", 1.2e9],
      ["4T", 4e12],
      ["3G", 3 * 1024 ** 3, "bytes"],
      ["2KiB", 2048, "bytes"],
      ["128Mi", 128 * 1024 ** 2, "bytes"],
      ["0Bi", 0, "bytes"],
      ["1.5kB", 1500, "bytes"],
      ["187MB", 187e6, "bytes"],
      ["2GB", 2e9, "bytes"],
      ["$1,234.50", 1234.5],
      ["-€5", -5],
      ["$-5", -5],
      ["2 (3h ago)", 2],
      ["\u22124", -4],
    ];
    for (const [text, value, unit] of cases) {
      assert.deepStrictEqual(parseNumber(text), unit === undefined ? { value } : { value, unit });
    }
    // In a column of sizes, as du -h and ls -lh print them.
    for (const [text, value] of [
      ["0B", 0],
      ["1.5K", 1536],
      ["1,500M", 1500 * 1024 ** 2],
      ["4T", 4 * 1024 ** 4],
      ["150k", 150_000],
    ] as const) {
      assert.deepStrictEqual(parseNumber(text, { sizes: true }), { value, unit: "bytes" });
    }
  });

  test("leaves text that is not a number alone", () => {
    for (const text of [
      "",
      "-",
      "abc",
      "1.2.3",
      "12,34",
      // Lists, or rows of CSV, rather than digits grouped as in India.
      "1,10,100",
      "0,10,100",
      "1,5M",
      "2024-01-05",
      "1 234",
      "e3",
      "12X",
      "NaN",
      "$",
      "5 $ 5",
      "Paris",
      "Infinity",
      "K",
      "ms",
      "%",
    ]) {
      assert.strictEqual(parseNumber(text), undefined, text);
    }
  });

  test("rejects numbers too large to hold, also after converting byte units", () => {
    for (const value of ["1e309", "1e308K", "-1e308MB", "1e300EiB", "9".repeat(400)]) {
      assert.strictEqual(parseNumber(value), undefined, value);
    }
  });

  test("rejects durations and millicores that exceed the numeric range", () => {
    const huge = "9".repeat(400);
    for (const suffix of ["ms", "s", "h", "d", ":00"]) {
      assert.strictEqual(parseNumber(`${huge}${suffix}`, { durations: true }), undefined);
    }
    assert.strictEqual(parseNumber(`${huge}m`, { millicores: true }), undefined);
    assert.strictEqual(parseNumber(`${"9".repeat(305)}d`, { durations: true }), undefined);
  });

  test("unit scaling rejects overflow and does not introduce it by rounding", () => {
    assert.throws(() => scale(1e308, 1000), /converted value exceeds the numeric range/);
    assert.strictEqual(scale(Number.MAX_VALUE / 10, 10), Number.MAX_VALUE);
    assert.strictEqual(scale(700, 0.001), 0.7);
  });

  test("reads dots between thousands in a column of decimal commas", () => {
    assert.deepStrictEqual(parseNumber("1.234", { decimalComma: true }), { value: 1234 });
    assert.deepStrictEqual(parseNumber("1.5", { decimalComma: true }), { value: 1.5 });
  });
});
