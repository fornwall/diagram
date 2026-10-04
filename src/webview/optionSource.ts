// Turns the source of an ECharts option into a value: JSON, or a JavaScript expression when a
// callback needs a function. A source that is neither gets an error that says where it is wrong,
// for the model to repair its output.

import { errorMessage } from "../protocol";

/**
 * The source as a value: JSON when it parses, otherwise evaluated as a JavaScript expression. The
 * brackets make a leading "{" an object literal rather than a block, and a top-level "," a list
 * of values rather than a sequence expression that would throw all but the last of them away; the
 * line breaks keep a trailing "//" comment from swallowing the closing bracket. Only the webview
 * evaluates a source, inside its sandboxed iframe.
 */
export function evaluateSource(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    // Evaluated as JavaScript instead.
  }
  let values: unknown[];
  try {
    values = (new Function(`"use strict"; return ([\n${source}\n]);`) as () => unknown[])();
  } catch (error) {
    throw new Error(describeError(source, error));
  }
  if (values.length === 1) {
    return values[0];
  }
  throw new Error(
    values.length === 0
      ? 'The ECharts option is empty. Write the option object, e.g. {"series": [{"type": "bar", ' +
          '"data": [5, 20, 36]}], "xAxis": {"type": "category", "data": ["A", "B", "C"]}, ' +
          '"yAxis": {"type": "value"}}.'
      : `The ECharts option source holds ${values.length} top-level values separated by ",": ` +
          'only one top-level object is allowed, so check for a "}" that closes it too early.',
  );
}

/**
 * V8 compiles the function above as "function anonymous(\n) {\n" and its body, whose first line
 * comes before the source as well, in what its stack frames refer to.
 */
const LINES_BEFORE_SOURCE = 3;

/** Describes why a source neither parses as JSON nor evaluates as JavaScript. */
function describeError(text: string, error: unknown): string {
  let found: SourceError | undefined;
  try {
    new Scanner(text).scan();
  } catch (thrown) {
    // UNCHECKED, or a stack overflow on deeply nested input: the engine's message has to do.
    if (thrown instanceof SourceError) found = thrown;
  }
  if (found) {
    return `The ECharts option could not be parsed: ${found.message}${located(text, found.position)}`;
  }
  if (error instanceof SyntaxError) {
    // The engine reports no position for a syntax error in new Function.
    return (
      "The ECharts option is neither valid JSON nor a valid JavaScript object literal: " +
      `${errorMessage(error)}. Write it as one object, as JSON or as JavaScript when a callback ` +
      "needs a function."
    );
  }
  const match = error instanceof Error ? /<anonymous>:(\d+):(\d+)\)/.exec(error.stack ?? "") : null;
  const position = match
    ? offsetOf(text, Number(match[1]) - LINES_BEFORE_SOURCE, Number(match[2]))
    : undefined;
  const hint =
    error instanceof ReferenceError
      ? " The option is evaluated on its own, with no libraries or variables in scope: write " +
        'text in quotes, and values out, such as gradients as {"type": "linear", "x": 0, "y": 0, ' +
        '"x2": 0, "y2": 1, "colorStops": [{"offset": 0, "color": "…"}, ...]}.'
      : "";
  const message = `The ECharts option threw while being evaluated as JavaScript: ${errorMessage(error)}`;
  if (position === undefined) {
    return `${message}.${hint}`;
  }
  const where = located(text, position);
  const lineBreak = where.indexOf("\n");
  return `${message}${where.slice(0, lineBreak)}${hint}${where.slice(lineBreak)}`;
}

function lineAndColumn(text: string, position: number) {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1;
  return {
    lineStart,
    line: text.slice(0, lineStart).split("\n").length,
    column: position - lineStart + 1,
  };
}

/** " (line L, column C)." and, on the next lines, the source line with a caret under the position. */
function located(text: string, position: number): string {
  const { lineStart, line, column } = lineAndColumn(text, position);
  return ` (line ${line}, column ${column}).\n${excerpt(text, position, lineStart, line)}`;
}

/** The offset of a 1-based line and column, if the source has them. */
function offsetOf(text: string, line: number, column: number): number | undefined {
  let start = 0;
  for (let each = 1; each < line; each++) {
    start = text.indexOf("\n", start) + 1;
    if (start === 0) return undefined;
  }
  const end = text.indexOf("\n", start);
  return line >= 1 && column >= 1 && start + column - 1 <= (end < 0 ? text.length : end)
    ? start + column - 1
    : undefined;
}

/** The line of the position with a caret under it, cropped around long lines. */
function excerpt(text: string, position: number, lineStart: number, line: number): string {
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

class SourceError {
  constructor(
    readonly message: string,
    readonly position: number,
  ) {}
}

/** Thrown where the source goes beyond literal syntax, such as a function, which only the engine checks. */
const UNCHECKED = Symbol("unchecked");

const IDENTIFIER = /[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*/uy;
const IDENTIFIER_START = /[\p{ID_Start}$_]/u;
/** The numbers of JavaScript: hexadecimal, binary, octal, BigInt and decimal, with "_" separators. */
const NUMBER =
  /0[xX][\da-fA-F](?:_?[\da-fA-F])*n?|0[bB][01](?:_?[01])*n?|0[oO][0-7](?:_?[0-7])*n?|(?:0|[1-9](?:_?\d)*)n|(?:(?:0|[1-9](?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][-+]?\d(?:_?\d)*)?/y;
const LINE_COMMENT = /\/\/[^\n\r\u2028\u2029]*/y;
/** What makes the preceding value part of an expression, such as a call, a member or an operator. */
const OPERATOR = /[-+*/%?.&|^<>=!([`]|(?:in|instanceof)(?![\p{ID_Continue}$])/uy;
/** A placeholder "..." in place of values, rather than a spread. */
const PLACEHOLDER_END = /\s*(?:[,\]}]|$)/y;
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

/**
 * Locates the first syntax error of a source written as JSON or as a JavaScript object literal,
 * which may use comments, unquoted keys, single quotes and trailing commas. It gives up (throwing
 * UNCHECKED) where the source goes beyond literals, as a function, a variable or an operator does.
 */
class Scanner {
  private index = 0;
  /** The objects and arrays that are open, innermost last. */
  private readonly open: { close: "}" | "]"; position: number }[] = [];

  constructor(private readonly text: string) {}

  scan(): void {
    this.space();
    if (this.text.startsWith("```", this.index)) {
      this.fail(
        "Remove the code fence around the option: the source must be the option object alone, " +
          "as JSON or as a JavaScript object literal",
      );
    }
    for (;;) {
      this.value();
      this.space();
      if (this.char() === "") return;
      if (this.char() !== ",") {
        this.operator();
        this.fail(
          `Unexpected ${this.found()} after the end of the option: only one top-level object is ` +
            'allowed, so check for a "}" that closes it too early',
        );
      }
      // More values, which evaluate: evaluateSource says how many there are.
      this.index++;
      this.space();
      if (this.char() === "") return;
    }
  }

  private char(): string {
    return this.text.charAt(this.index);
  }

  private found(): string {
    const word = matchAt(IDENTIFIER, this.text, this.index);
    return word ? `"${word}"` : quote(this.char());
  }

  private fail(problem: string, position = this.index): never {
    throw new SourceError(problem, position);
  }

  /** Gives up at an operator after a value, which makes the value part of an expression. */
  private operator(): void {
    if (matchAt(OPERATOR, this.text, this.index) !== undefined) throw UNCHECKED;
  }

  private space(): void {
    for (;;) {
      const char = this.char();
      if (char !== "" && /\s/.test(char)) {
        this.index++;
      } else if (this.text.startsWith("//", this.index)) {
        this.index += matchAt(LINE_COMMENT, this.text, this.index)?.length ?? 2;
      } else if (this.text.startsWith("/*", this.index)) {
        const end = this.text.indexOf("*/", this.index + 2);
        if (end < 0) this.fail('Unterminated comment: missing the closing "*/"');
        this.index = end + 2;
      } else {
        return;
      }
    }
  }

  private unexpected(what: string): never {
    const char = this.char();
    if (char === "") {
      const close = this.open
        .map((bracket) => bracket.close)
        .reverse()
        .join("");
      this.fail(
        `Unexpected end of input while expecting ${what}: the option is incomplete` +
          (close ? `, with "${close}" left to close` : ""),
      );
    }
    if ("“”‘’".includes(char)) {
      this.fail('Strings and property names must use straight quotes ("), not typographic ones');
    }
    // A parenthesized expression, a regular expression or an operator.
    if ("(/!~".includes(char)) throw UNCHECKED;
    this.fail(`Unexpected ${this.found()} while expecting ${what}`);
  }

  private value(): void {
    this.space();
    const char = this.char();
    if (char === "{" || char === "[") {
      this.container(char === "{" ? "}" : "]");
    } else if (char === '"' || char === "'") {
      this.string(char);
    } else if (char === "`") {
      this.template();
    } else if (this.text.startsWith("...", this.index) || char === "…") {
      const end = this.index + (char === "…" ? 1 : 3);
      if (char === "…" || matchAt(PLACEHOLDER_END, this.text, end) !== undefined) {
        this.fail('Write out all values: there are no placeholders such as "..."');
      }
      throw UNCHECKED; // A spread.
    } else if (char === "-" || char === "+") {
      this.index++;
      this.space();
      if (matchAt(IDENTIFIER, this.text, this.index) === "Infinity") {
        this.index += "Infinity".length;
      } else if (/[\d.]/.test(this.char())) {
        this.number();
      } else {
        throw UNCHECKED; // The sign of an expression.
      }
    } else if (/[\d.]/.test(char)) {
      this.number();
    } else {
      const word = matchAt(IDENTIFIER, this.text, this.index);
      if (word === undefined) this.unexpected("a value");
      this.word(word);
    }
  }

  private word(word: string): void {
    if (["true", "false", "null", "undefined", "NaN", "Infinity"].includes(word)) {
      this.index += word.length;
      return;
    }
    if (word === "True" || word === "False" || word === "None") {
      this.fail(`${word} is not valid JSON or JavaScript; use true, false or null`);
    }
    const assigned = /\s*=(?![=>])/y;
    if (
      this.open.length === 0 &&
      (/^(?:const|let|var|export|import|return)$/.test(word) ||
        matchAt(assigned, this.text, this.index + word.length) !== undefined)
    ) {
      this.fail(
        `Unexpected "${word}": write the option object itself, as JSON or as a JavaScript object ` +
          "literal, with no assignment or statement around it",
      );
    }
    throw UNCHECKED; // A variable, a function, a "new" expression, …
  }

  private container(close: "}" | "]"): void {
    this.open.push({ close, position: this.index });
    this.index++;
    for (;;) {
      this.space();
      const char = this.char();
      if (char === close) {
        // Also after a trailing comma, which JavaScript allows.
        this.open.pop();
        this.index++;
        return;
      }
      if (close === "]" && char === ",") {
        // An array hole, which JavaScript allows too.
        this.index++;
        continue;
      }
      if (close === "}") {
        this.property();
      }
      this.value();
      if (this.separator(close)) {
        return;
      }
    }
  }

  /** Skips a property name and the ":" after it. */
  private property(): void {
    const char = this.char();
    let name: string | undefined;
    if (char === '"' || char === "'") {
      this.string(char);
    } else if (/[\d.]/.test(char)) {
      this.number();
    } else {
      name = matchAt(IDENTIFIER, this.text, this.index);
      if (name === undefined) {
        // A computed name, a spread or a generator method.
        if (char === "[" || char === "*" || this.text.startsWith("...", this.index)) {
          throw UNCHECKED;
        }
        this.unexpected("a property name");
      }
      this.index += name.length;
    }
    this.space();
    const next = this.char();
    if (next === ":") {
      this.index++;
      return;
    }
    // A method, a shorthand property or an accessor: JavaScript, but no literal to check.
    if (
      next === "(" ||
      (name !== undefined &&
        (next === "," ||
          next === "}" ||
          (/^(?:get|set|async)$/.test(name) && /["'[\p{ID_Start}$_*]/u.test(next))))
    ) {
      throw UNCHECKED;
    }
    this.unexpected('":" after the property name');
  }

  /**
   * Skips the "," after a property value or array element, or the bracket that closes the object
   * or array, returning whether it was closed.
   */
  private separator(close: "}" | "]"): boolean {
    this.space();
    const char = this.char();
    if (char === ",") {
      this.index++;
      return false;
    }
    if (char === close) {
      this.open.pop();
      this.index++;
      return true;
    }
    const [container, item] = close === "}" ? ["object", "property"] : ["array", "element"];
    if (char === "}" || char === "]") {
      const { line, column } = lineAndColumn(this.text, this.open.at(-1)?.position ?? 0);
      this.fail(
        `Unexpected "${char}": the ${container} opened at line ${line}, column ${column} must be closed with "${close}" first`,
      );
    }
    this.operator();
    if (/["'{\d]/.test(char) || IDENTIFIER_START.test(char)) {
      this.fail(`Missing "," before this ${item}`);
    }
    this.unexpected(
      `"," or "${close}" after the ${close === "}" ? "property value" : "array element"}`,
    );
  }

  private string(quoteChar: string): void {
    const start = this.index;
    const missing = `missing the closing ${quoteChar === '"' ? "double" : "single"} quote`;
    this.index++;
    for (;;) {
      const char = this.char();
      if (char === quoteChar) {
        this.index++;
        return;
      }
      if (char === "") {
        this.fail(`Unterminated string: ${missing}`, start);
      }
      if (char === "\n" || char === "\r") {
        this.fail(
          `Unterminated string: ${missing} before the end of the line; write a line break in a ` +
            'string as "\\n"',
          start,
        );
      }
      if (char === "\\") {
        this.escape();
      } else {
        this.index++;
      }
    }
  }

  /** Skips an escape sequence, rejecting the ones that strict mode JavaScript rejects. */
  private escape(): void {
    const at = this.index;
    const escaped = this.text.charAt(at + 1);
    this.index += 2;
    if (escaped === "u") {
      const digits = matchAt(/[\da-fA-F]{4}|\{[\da-fA-F]+\}/y, this.text, this.index);
      if (digits === undefined) {
        this.fail('Invalid escape: write "\\u" with four hexadecimal digits, as in "\\u00e9"', at);
      }
      this.index += digits.length;
    } else if (escaped === "x") {
      if (matchAt(/[\da-fA-F]{2}/y, this.text, this.index) === undefined) {
        this.fail('Invalid escape: write "\\x" with two hexadecimal digits, as in "\\x41"', at);
      }
      this.index += 2;
    } else if (/[1-9]/.test(escaped) || (escaped === "0" && /\d/.test(this.char()))) {
      this.fail(
        `Invalid escape "\\${escaped}": there are no octal escapes; write "\\u" with four ` +
          "hexadecimal digits instead",
        at,
      );
    } else if (escaped === "\r" && this.char() === "\n") {
      // A line continuation.
      this.index++;
    }
  }

  private template(): void {
    const start = this.index;
    this.index++;
    for (;;) {
      const char = this.char();
      if (char === "`") {
        this.index++;
        return;
      }
      if (char === "") {
        this.fail("Unterminated template literal: missing the closing backtick", start);
      }
      if (this.text.startsWith("${", this.index)) throw UNCHECKED;
      this.index += char === "\\" ? 2 : 1;
    }
  }

  private number(): void {
    const number = matchAt(NUMBER, this.text, this.index) ?? "";
    const end = this.index + number.length;
    const next = this.text.charAt(end);
    if (number && next === "." && IDENTIFIER_START.test(this.text.charAt(end + 1))) {
      throw UNCHECKED; // A method call, such as 1.5.toFixed(1).
    }
    if (!number || /[\w$.]/.test(next)) {
      const token = matchAt(/[\w$.]+/y, this.text, this.index);
      this.fail(
        `Invalid number ${token}: write numbers such as 5, -0.5 or 1e3, without leading zeros or ` +
          "units, and text in quotes",
      );
    }
    this.index = end;
  }
}
