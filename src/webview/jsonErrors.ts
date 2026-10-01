// Precise, actionable descriptions of JSON syntax errors, for the model to repair its output.

class JsonSyntaxError {
  constructor(
    readonly position: number,
    readonly problem: string,
  ) {}
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** A strict JSON scanner that only locates the first syntax error and explains it. */
class Scanner {
  private index = 0;

  constructor(private readonly text: string) {}

  scan(): void {
    this.value();
    this.whitespace();
    if (this.index < this.text.length) {
      this.fail(
        "Unexpected content after the end of the JSON value (only one top-level object is allowed)",
      );
    }
  }

  private fail(problem: string, position = this.index): never {
    throw new JsonSyntaxError(position, problem);
  }

  private whitespace(): void {
    while (this.index < this.text.length && " \t\n\r".includes(this.text.charAt(this.index))) {
      this.index++;
    }
  }

  private word(): string | undefined {
    IDENTIFIER.lastIndex = this.index;
    return IDENTIFIER.exec(this.text)?.[0];
  }

  private unexpected(what: string): never {
    const char = this.text.charAt(this.index);
    if (char === "") {
      this.fail(`Unexpected end of input while expecting ${what}: the JSON is incomplete`);
    }
    if (char === "'") {
      this.fail("Strings and property names must use double quotes, not single quotes");
    }
    if (char === "/") {
      this.fail("Comments are not allowed in JSON");
    }
    const word = this.word();
    if (word === "function" || this.text.startsWith("=>", this.index)) {
      this.fail(
        'JavaScript functions are not allowed in JSON; use a string template such as "{b}: {c}" for formatters',
      );
    }
    if (word === "undefined" || word === "NaN" || word === "Infinity") {
      this.fail(`${word} is not valid JSON; use null or a number`);
    }
    if (word) {
      this.fail(`Unexpected "${word}" while expecting ${what}; strings must be in double quotes`);
    }
    this.fail(`Unexpected character ${JSON.stringify(char)} while expecting ${what}`);
  }

  private value(): void {
    this.whitespace();
    const char = this.text.charAt(this.index);
    if (char === "{") {
      this.object();
    } else if (char === "[") {
      this.array();
    } else if (char === '"') {
      this.string();
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      this.number();
    } else if (["true", "false", "null"].includes(this.word() ?? "")) {
      this.index += (this.word() ?? "").length;
    } else {
      this.unexpected("a value");
    }
  }

  private object(): void {
    this.index++; // {
    this.whitespace();
    if (this.text.charAt(this.index) === "}") {
      this.index++;
      return;
    }
    for (;;) {
      this.whitespace();
      const char = this.text.charAt(this.index);
      if (char === '"') {
        this.string();
      } else if (char === "}") {
        this.fail('Trailing comma before "}" is not allowed in JSON', this.lastComma());
      } else {
        const word = this.word();
        if (word) {
          this.fail(`Property names must be in double quotes: write "${word}" instead of ${word}`);
        }
        this.unexpected("a property name in double quotes");
      }
      this.whitespace();
      if (this.text.charAt(this.index) !== ":") {
        this.unexpected('":" after the property name');
      }
      this.index++;
      this.value();
      this.whitespace();
      const next = this.text.charAt(this.index);
      if (next === ",") {
        this.index++;
      } else if (next === "}") {
        this.index++;
        return;
      } else {
        this.unexpected('"," or "}" after the property value (missing comma or closing brace?)');
      }
    }
  }

  private array(): void {
    this.index++; // [
    this.whitespace();
    if (this.text.charAt(this.index) === "]") {
      this.index++;
      return;
    }
    for (;;) {
      this.whitespace();
      if (this.text.charAt(this.index) === "]") {
        this.fail('Trailing comma before "]" is not allowed in JSON', this.lastComma());
      }
      this.value();
      this.whitespace();
      const next = this.text.charAt(this.index);
      if (next === ",") {
        this.index++;
      } else if (next === "]") {
        this.index++;
        return;
      } else {
        this.unexpected('"," or "]" after the array element (missing comma or closing bracket?)');
      }
    }
  }

  private lastComma(): number {
    const comma = this.text.lastIndexOf(",", this.index);
    return comma >= 0 ? comma : this.index;
  }

  private string(): void {
    const start = this.index;
    this.index++; // "
    for (;;) {
      const char = this.text.charAt(this.index);
      if (char === "") {
        this.fail("Unterminated string: missing the closing double quote", start);
      }
      if (char === '"') {
        this.index++;
        return;
      }
      if (char === "\\") {
        const escaped = this.text.charAt(this.index + 1);
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.index + 2, this.index + 6))) {
            this.fail("Invalid \\u escape in string: expected four hexadecimal digits");
          }
          this.index += 6;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escaped) || escaped === "") {
          this.fail(`Invalid escape "\\${escaped}" in string`);
        }
        this.index += 2;
        continue;
      }
      if (char < " ") {
        this.fail('Unescaped line break or control character in string; write "\\n" instead');
      }
      this.index++;
    }
  }

  private number(): void {
    NUMBER.lastIndex = this.index;
    const match = NUMBER.exec(this.text);
    if (!match) {
      this.fail("Invalid number");
    }
    this.index += match[0].length;
  }
}

function lineAndColumn(text: string, position: number): { line: number; column: number } {
  const before = text.slice(0, position);
  const line = before.split("\n").length;
  const column = position - (before.lastIndexOf("\n") + 1) + 1;
  return { line, column };
}

/** The offending line with a caret under the error position, cropped around long lines. */
function excerpt(text: string, line: number, column: number): string {
  const content = text.split("\n")[line - 1] ?? "";
  const width = 100;
  let start = 0;
  if (content.length > width) {
    start = Math.max(0, Math.min(column - 1 - width / 2, content.length - width));
  }
  const shown = `${start > 0 ? "…" : ""}${content.slice(start, start + width)}${
    start + width < content.length ? "…" : ""
  }`;
  const gutter = `${line} | `;
  const caretOffset = column - 1 - start + (start > 0 ? 1 : 0);
  return `${gutter}${shown}\n${" ".repeat(gutter.length - 2)}| ${" ".repeat(Math.max(0, caretOffset))}^`;
}

/** Describes why `text` is not valid JSON, given the error thrown by JSON.parse. */
export function describeJsonError(text: string, error: unknown): string {
  let position: number | undefined;
  let problem: string | undefined;
  try {
    new Scanner(text).scan();
  } catch (located) {
    if (located instanceof JsonSyntaxError) {
      position = located.position;
      problem = located.problem;
    }
  }
  const native = error instanceof Error ? error.message : String(error);
  if (position === undefined) {
    const match = /position (\d+)/.exec(native);
    position = match ? Number(match[1]) : text.length;
  }
  const { line, column } = lineAndColumn(text, position);
  return (
    `The ECharts option is not valid JSON: ${problem ?? native} (line ${line}, column ${column}).\n` +
    `${excerpt(text, line, column)}\n` +
    "Write the option as strict JSON: double-quoted property names and strings, no comments, " +
    "no trailing commas and no functions."
  );
}
