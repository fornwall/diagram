// Precise, actionable descriptions of JSON syntax errors, for the model to repair its output.

import { errorMessage } from "../protocol";

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
/** What a model may write as a number, such as 0x1F, +1, .5, 5., 05 or -Infinity. */
const NUMBER_LIKE = /[-+.\w]+/y;
/** A JavaScript function, as models write formatters. */
const FUNCTION = /(?:async\s+)?(?:function\b|(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>)/y;

function matchAt(pattern: RegExp, text: string, index: number): string | undefined {
  pattern.lastIndex = index;
  return pattern.exec(text)?.[0];
}

/** A character as quoted in a message, with its code point if it may be invisible. */
function quote(char: string): string {
  const code = char.charCodeAt(0);
  return code < 0x20 || code > 0x7e
    ? `${JSON.stringify(char)} (U+${code.toString(16).toUpperCase().padStart(4, "0")})`
    : JSON.stringify(char);
}

function lineAndColumn(text: string, position: number): { line: number; column: number } {
  const before = text.slice(0, position);
  return { line: before.split("\n").length, column: position - before.lastIndexOf("\n") };
}

interface OpenBracket {
  close: "}" | "]";
  position: number;
}

/** A strict JSON scanner that only locates the first syntax error and explains it. */
class Scanner {
  private index = 0;
  /** The objects and arrays that are open, innermost last. */
  private readonly open: OpenBracket[] = [];

  constructor(private readonly text: string) {}

  scan(): void {
    this.whitespace();
    if (this.text.startsWith("```", this.index)) {
      this.fail(
        'Remove the code fence around the option: the source must be the JSON object alone, starting with "{"',
      );
    }
    this.value();
    this.whitespace();
    const char = this.text.charAt(this.index);
    if (char === "/") {
      this.failJavaScript("Comments are not allowed in JSON");
    }
    if (char) {
      this.fail(
        `Unexpected ${quote(char)} after the end of the JSON value: only one top-level object is ` +
          'allowed, so check for a "}" that closes it too early',
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

  private unexpected(what: string): never {
    const char = this.text.charAt(this.index);
    const word = matchAt(IDENTIFIER, this.text, this.index);
    if (char === "") {
      const close = this.open
        .map((bracket) => bracket.close)
        .reverse()
        .join("");
      this.fail(
        `Unexpected end of input while expecting ${what}: the JSON is incomplete` +
          (close ? `, with "${close}" left to close` : ""),
      );
    }
    if (char === "'" || char === "`") {
      this.failJavaScript(
        `Strings and property names must use double quotes, not ${char === "'" ? "single quotes" : "backticks"}`,
      );
    }
    if ("“”‘’".includes(char)) {
      this.fail(
        'Strings and property names must use straight double quotes ("), not typographic ones',
      );
    }
    if (char === "/") {
      this.failJavaScript("Comments are not allowed in JSON");
    }
    if (matchAt(FUNCTION, this.text, this.index)) {
      this.failJavaScript(
        'JavaScript functions are not allowed in JSON; use a string template such as "{b}: {c}" for formatters',
      );
    }
    if (word === "undefined" || word === "NaN" || word === "Infinity") {
      this.failJavaScript(`${word} is not valid JSON; use null or a number`);
    }
    if (word === "True" || word === "False" || word === "None") {
      this.fail(`${word} is not valid JSON; use true, false or null`);
    }
    if (word === "new") {
      this.failJavaScript(
        'JavaScript expressions such as "new …" are not allowed in JSON; write dates as strings ' +
          'such as "2026-01-31", and gradients as objects such as {"type": "linear", "x": 0, ' +
          '"y": 0, "x2": 0, "y2": 1, "colorStops": [{"offset": 0, "color": "…"}, ...]}',
      );
    }
    const found = word ? `"${word}"` : quote(char);
    if (this.open.length === 0) {
      this.fail(`Unexpected ${found}: the source must be the JSON object alone, starting with "{"`);
    }
    this.fail(
      `Unexpected ${found} while expecting ${what}${word ? "; strings must be in double quotes" : ""}`,
    );
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
    } else if (this.text.startsWith("...", this.index) || char === "…") {
      this.fail('Write out all values: JSON has no placeholders such as "..."');
    } else if (char !== "" && "-+.0123456789".includes(char)) {
      this.number();
    } else {
      const word = matchAt(IDENTIFIER, this.text, this.index);
      if (word !== "true" && word !== "false" && word !== "null") {
        this.unexpected("a value");
      }
      this.index += word.length;
    }
  }

  private object(): void {
    this.open.push({ close: "}", position: this.index });
    this.index++; // {
    this.whitespace();
    if (this.text.charAt(this.index) === "}") {
      this.close();
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
        const word = matchAt(IDENTIFIER, this.text, this.index);
        if (word) {
          this.failJavaScript(
            `Property names must be in double quotes: write "${word}" instead of ${word}`,
          );
        }
        this.unexpected("a property name in double quotes");
      }
      this.whitespace();
      if (this.text.charAt(this.index) !== ":") {
        this.unexpected('":" after the property name');
      }
      this.index++;
      this.value();
      if (this.separator("}")) {
        return;
      }
    }
  }

  private array(): void {
    this.open.push({ close: "]", position: this.index });
    this.index++; // [
    this.whitespace();
    if (this.text.charAt(this.index) === "]") {
      this.close();
      return;
    }
    for (;;) {
      this.whitespace();
      if (this.text.charAt(this.index) === "]") {
        this.failJavaScript('Trailing comma before "]" is not allowed in JSON', this.lastComma());
      }
      this.value();
      if (this.separator("]")) {
        return;
      }
    }
  }

  /**
   * Skips the "," after a property value or array element, or the bracket that closes the object
   * or array, returning whether it was closed.
   */
  private separator(close: "}" | "]"): boolean {
    this.whitespace();
    const char = this.text.charAt(this.index);
    if (char === ",") {
      this.index++;
      return false;
    }
    if (char === close) {
      this.close();
      return true;
    }
    const [container, item] = close === "}" ? ["object", "property"] : ["array", "element"];
    if (char === "}" || char === "]") {
      const opened = this.open.at(-1)?.position ?? 0;
      const { line, column } = lineAndColumn(this.text, opened);
      this.fail(
        `Unexpected "${char}": the ${container} opened at line ${line}, column ${column} must be closed with "${close}" first`,
      );
    }
    const value =
      /["{[\-\d]/.test(char) || /^(?:true|false|null)\b/.test(this.text.slice(this.index));
    if (value) {
      this.fail(`Missing "," before this ${item}`);
    }
    this.unexpected(
      `"," or "${close}" after the ${close === "}" ? "property value" : "array element"}`,
    );
  }

  private close(): void {
    this.open.pop();
    this.index++;
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
    const token = matchAt(NUMBER_LIKE, this.text, this.index) ?? "";
    if (matchAt(NUMBER, this.text, this.index) !== token) {
      if (token === "-Infinity" || token === "+Infinity") {
        this.failJavaScript(`${token} is not valid JSON; use null or a number`);
      }
      this.fail(
        `Invalid number ${token}: JSON numbers are decimal, without a leading "+" or zeros, and ` +
          'with digits on both sides of a "."',
      );
    }
    this.index += token.length;
  }
}

/** The line of the error position with a caret under it, cropped around long lines. */
function excerpt(text: string, position: number, line: number): string {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1;
  const lineEnd = text.indexOf("\n", position);
  const content = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).replace(/\r$/, "");
  const column = position - lineStart;
  const width = 100;
  const start =
    content.length > width ? Math.max(0, Math.min(column - width / 2, content.length - width)) : 0;
  const before = `${start > 0 ? "…" : ""}${content.slice(start, column)}`;
  const shown = `${start > 0 ? "…" : ""}${content.slice(start, start + width)}${
    start + width < content.length ? "…" : ""
  }`;
  const gutter = `${line} | `;
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
      const { line, column } = lineAndColumn(text, found.position);
      return (
        `The ECharts option is not valid JSON: ${found.message} (line ${line}, column ${column}).\n` +
        excerpt(text, found.position, line) +
        (found.javaScript
          ? "\nWrite the option as strict JSON: double-quoted property names and strings, no " +
            "comments, no trailing commas and no functions."
          : "")
      );
    }
  }
  // The scanner and JSON.parse disagree, e.g. on nesting too deep for either.
  return `The ECharts option is not valid JSON: ${errorMessage(error)}`;
}
