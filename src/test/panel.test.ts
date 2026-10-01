import * as assert from "node:assert";
import { clickToAskQuery } from "../panel";

suite("panel", () => {
  test("clickToAskQuery replaces {label}", () => {
    assert.strictEqual(
      clickToAskQuery("Explain {label}, and how {label} is tested", "Parser"),
      "Explain Parser, and how Parser is tested",
    );
  });

  test("clickToAskQuery appends the label when there is no placeholder", () => {
    assert.strictEqual(
      clickToAskQuery("Tell me more about", "Parser"),
      'Tell me more about "Parser"',
    );
  });
});
