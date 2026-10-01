// Precise, actionable descriptions of JSON syntax errors, for the model to repair its output.

class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
    /** Whether the text uses JavaScript syntax that JSON lacks, a typical mistake of models. */
    readonly javaScript: boolean,
  ) {
    super(message);
  }
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

  private fail(problem: string, position = this.index, javaScript = false): never {
    throw new JsonSyntaxError(problem, position, javaScript);
  }

  private failJavaScript(problem: string, position = this.index): never {
    this.fail(problem, position, true);
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

  private unexpected(what: string, word = this.word()): never {
    const char = this.text.charAt(this.index);
    if (char === "") {
      this.fail(`Unexpected end of input while expecting ${what}: the JSON is incomplete`);
    }
    if (char === "'") {
      this.failJavaScript("Strings and property names must use double quotes, not single quotes");
    }
    if (char === "/") {
      this.failJavaScript("Comments are not allowed in JSON");
    }
    if (word === "function" || this.text.startsWith("=>", this.index)) {
      this.failJavaScript(
        'JavaScript functions are not allowed in JSON; use a string template such as "{b}: {c}" for formatters',
      );
    }
    if (word === "undefined" || word === "NaN" || word === "Infinity") {
      this.failJavaScript(`${word} is not valid JSON; use null or a number`);
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
    } else {
      const word = this.word();
      if (word !== "true" && word !== "false" && word !== "null") {
        this.unexpected("a value", word);
      }
      this.index += word.length;
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
        this.failJavaScript('Trailing comma before "}" is not allowed in JSON', this.lastComma());
      } else {
        const word = this.word();
        if (word) {
          this.failJavaScript(
            `Property names must be in double quotes: write "${word}" instead of ${word}`,
          );
        }
        this.unexpected("a property name in double quotes", word);
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
        this.failJavaScript('Trailing comma before "]" is not allowed in JSON', this.lastComma());
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
        if (!escaped || !'"\\/bfnrt'.includes(escaped)) {
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

/** The line of the error position with a caret under it, cropped around long lines. */
function excerpt(text: string, position: number): string {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1;
  const lineEnd = text.indexOf("\n", position);
  const content = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  const column = position - lineStart;
  const width = 100;
  const start =
    content.length > width ? Math.max(0, Math.min(column - width / 2, content.length - width)) : 0;
  const before = `${start > 0 ? "…" : ""}${content.slice(start, column)}`;
  const shown = `${start > 0 ? "…" : ""}${content.slice(start, start + width)}${
    start + width < content.length ? "…" : ""
  }`;
  const gutter = `${text.slice(0, lineStart).split("\n").length} | `;
  // Tabs stay tabs below the line, so that the caret lines up whatever the tab width.
  const indent = before.replace(/[^\t]/g, " ");
  return `${gutter}${shown}\n${" ".repeat(gutter.length - 2)}| ${indent}^`;
}

/** Describes why `text` is not valid JSON, given the error thrown by JSON.parse. */
export function describeJsonError(text: string, error: unknown): string {
  try {
    new Scanner(text).scan();
  } catch (found) {
    if (found instanceof JsonSyntaxError) {
      const before = text.slice(0, found.position);
      const line = before.split("\n").length;
      const column = found.position - before.lastIndexOf("\n");
      return (
        `The ECharts option is not valid JSON: ${found.message} (line ${line}, column ${column}).\n` +
        excerpt(text, found.position) +
        (found.javaScript
          ? "\nWrite the option as strict JSON: double-quoted property names and strings, no " +
            "comments, no trailing commas and no functions."
          : "")
      );
    }
  }
  // The scanner and JSON.parse disagree, e.g. on nesting too deep for either.
  return `The ECharts option is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
}
