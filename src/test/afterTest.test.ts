import * as assert from "node:assert";
import { assertLinearTime } from "./afterTest";

suite("afterTest", () => {
  test("tells quadratic time from linear also of a size that takes well under a millisecond", () => {
    // Each pair of a size's items, of a tenth of a millisecond at 320, beside which the millisecond
    // more that the bound allows would hide the sixteen times as long at 1280.
    const pairs = (size: number) => () => {
      let sum = 0;
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) sum += i ^ j;
      }
      return sum;
    };
    assert.throws(() => assertLinearTime(pairs, 320), /ms for size \d+, but .* ms for \d+$/);
  });
});
