// Precise, actionable descriptions of the syntax errors of an ECharts option source, which may be
// written as JSON or as a JavaScript object literal, for the model to repair its output.

import { errorMessage } from "../protocol";

class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
    /**
     * Whether the problem is only that JSON lacks this JavaScript syntax, which is allowed when
     * the source is written as JavaScript, so that such a complaint is never the real error.
     */
    readonly javaScript: boolean,
  ) {
    super(message);
  }
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
/** What a model may write as a number, such as 0x1F, +1, .5, 5., 05 or -Infinity. */
const NUMBER_LIKE = /[-+.\w]+/y;
/** The number forms that JavaScript accepts and JSON does not, with "_" separators throughout. */
const JAVASCRIPT_NUMBERS = [
  // Hexadecimal, binary and octal integers, each with an optional BigInt "n".
  /^[-+]?0[xX][\da-fA-F]+(?:_[\da-fA-F]+)*n?$/,
  /^[-+]?0[bB][01]+(?:_[01]+)*n?$/,
  /^[-+]?0[oO][0-7]+(?:_[0-7]+)*n?$/,
  // A decimal BigInt, which has no fraction and no exponent.
  /^[-+]?(?:0|[1-9]\d*(?:_\d+)*)n$/,
  // A decimal with a "+" sign, a leading or trailing "." or an exponent, but no leading zero,
  // which would be a legacy octal that strict mode rejects as well.
  /^[-+]?(?!0[\d_])(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][-+]?\d+(?:_\d+)*)?$/,
];
const FUNCTION = /\s*(?:async\s+)?(?:function\s*[\w$]*\s*\(|(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>)/y;

function matchAt(pattern: RegExp, text: string, index: number): string | undefined {
  pattern.lastIndex = index;
  return pattern.exec(text)?.[0];
}

/** Whether the text starts a JavaScript function at the index, as models write formatters. */
export const isFunctionAt = (text: string, index = 0) =>
  matchAt(FUNCTION, text, index) !== undefined;

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
        "Remove the code fence around the option: the source must be the option object alone, " +
          "as JSON or as a JavaScript object literal",
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
    if (isFunctionAt(this.text, this.index)) {
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
      this.fail(
        `Unexpected ${found}: write the option object itself, as JSON or as a JavaScript object ` +
          "literal, with no assignment or statement around it",
        this.index,
        // A JavaScript source may be a parenthesized expression, such as an immediately called
        // function, so a "(" here is not the error.
        char === "(",
      );
    }
    this.fail(
      `Unexpected ${found} while expecting ${what}${word ? "; strings must be in double quotes" : ""}`,
    );
  }

  private value(): void {
    this.whitespace();
    const char = this.text.charAt(this.index);
    if (char === "{" || char === "[") {
      this.container(char === "{" ? "}" : "]");
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

  private container(close: "}" | "]"): void {
    this.open.push({ close, position: this.index });
    this.index++;
    this.whitespace();
    if (this.text.charAt(this.index) === close) {
      this.close();
      return;
    }
    for (;;) {
      this.whitespace();
      const char = this.text.charAt(this.index);
      if (char === close) {
        this.failJavaScript(
          `Trailing comma before "${close}" is not allowed in JSON`,
          this.lastComma(),
        );
      }
      if (close === "}") {
        if (char !== '"') {
          const word = matchAt(IDENTIFIER, this.text, this.index);
          if (word) {
            this.failJavaScript(
              `Property names must be in double quotes: write "${word}" instead of ${word}`,
            );
          }
          this.unexpected("a property name in double quotes");
        }
        this.string();
        this.whitespace();
        if (this.text.charAt(this.index) !== ":") {
          this.unexpected('":" after the property name');
        }
        this.index++;
      }
      this.value();
      if (this.separator(close)) {
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
        this.index,
        // JavaScript accepts .5, 0x1F or 1_000, so only a form it rejects too, such as the legacy
        // octal 05, is the error of a JavaScript source.
        JAVASCRIPT_NUMBERS.some((form) => form.test(token)),
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

/**
 * Describes a source that neither parses as JSON nor evaluates as a JavaScript expression. The
 * engine reports no position for a `new Function` syntax error, so the scanner locates it instead,
 * unless it only complains about JavaScript syntax, which is allowed here.
 */
export function describeSourceError(
  text: string,
  jsonError: unknown,
  scriptError: unknown,
): string {
  try {
    new Scanner(text).scan();
  } catch (found) {
    if (found instanceof JsonSyntaxError) {
      if (found.javaScript) {
        return describeScriptError(scriptError);
      }
      const { line, column } = lineAndColumn(text, found.position);
      return (
        `The ECharts option could not be parsed: ${found.message} (line ${line}, column ${column}).\n` +
        excerpt(text, found.position, line)
      );
    }
  }
  // The scanner and JSON.parse disagree, e.g. on nesting too deep for either.
  return `The ECharts option could not be parsed as JSON or as JavaScript: ${errorMessage(jsonError)}`;
}

/** Describes a source that failed to evaluate as JavaScript, which carries no position. */
function describeScriptError(error: unknown): string {
  if (error instanceof SyntaxError) {
    return (
      "The ECharts option is neither valid JSON nor a valid JavaScript object literal: " +
      `${errorMessage(error)}. Write it as one object, as JSON or as JavaScript when a callback ` +
      "needs a function."
    );
  }
  return (
    `The ECharts option threw while being evaluated as JavaScript: ${errorMessage(error)}. ` +
    "The option is evaluated on its own, with no libraries in scope, so write values out: " +
    'gradients as objects such as {"type": "linear", "x": 0, "y": 0, "x2": 0, "y2": 1, ' +
    '"colorStops": [{"offset": 0, "color": "…"}, ...]}.'
  );
}
