import * as assert from "node:assert";

/** The message of what `use(input)` throws, failing the test if it accepts the input. */
export function thrown<T>(use: (input: T) => unknown, input: T): string {
  try {
    use(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail(`${JSON.stringify(input)} was accepted`);
}
