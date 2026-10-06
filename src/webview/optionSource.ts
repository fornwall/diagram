// Turns the source of an ECharts option into a value: JSON, a JavaScript object literal, or a
// JavaScript expression when a callback needs a function. A source that is none of these gets an
// error that says where it is wrong, for the model to repair its output.

import { errorMessage } from "../protocol";

/**
 * The source as a value: JSON when it parses, or a JavaScript object literal, read without
 * evaluating it, or else evaluated as a JavaScript expression, which the webview's content
 * security policy allows only in a trusted workspace. The brackets make a leading "{" an object
 * literal rather than a block, and a top-level "," a list of values rather than a sequence
 * expression that would throw all but the last of them away; the line breaks keep a trailing "//"
 * comment from swallowing the closing bracket.
 */
export function evaluateSource(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    // Read as JavaScript instead.
  }
  const scanned = scan(source);
  let values: unknown[];
  if (Array.isArray(scanned)) {
    values = scanned;
  } else {
    let evaluate: () => unknown[];
    try {
      evaluate = new Function(`"use strict"; return ([\n${source}\n]);`) as () => unknown[];
    } catch (error) {
      throw new Error(describeError(source, error, scanned));
    }
    try {
      values = evaluate();
    } catch (error) {
      // A mistake the scanner found, such as a code fence or "True", may still compile as code.
      throw new Error(
        scanned instanceof SourceError
          ? describeError(source, error, scanned)
          : describeThrown(source, error),
      );
    }
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
 * Whether {@link evaluateSource} evaluates the source as JavaScript, rather than reading its
 * literals, so that code in it runs in the page.
 */
export function runsCode(source: string): boolean {
  try {
    JSON.parse(source);
    return false;
  } catch {
    return !Array.isArray(scan(source));
  }
}

/**
 * The top-level values of a source of literals only; otherwise its first syntax error, where it
 * goes beyond literals, or undefined if it is nested too deeply to scan.
 */
function scan(text: string): unknown[] | SourceError | Code | undefined {
  try {
    return new Scanner(text).scan();
  } catch (thrown) {
    if (thrown instanceof SourceError || thrown instanceof Code) return thrown;
    if (thrown instanceof RangeError) return undefined;
    throw thrown;
  }
}

/**
 * V8 compiles the function above as "function anonymous(\n) {\n" and its body, whose first line
 * comes before the source as well, in what its stack frames refer to.
 */
const LINES_BEFORE_SOURCE = 3;

/** Describes why a source neither parses as JSON nor compiles as JavaScript. */
function describeError(
  text: string,
  error: unknown,
  found: SourceError | Code | undefined,
): string {
  if (found instanceof SourceError) {
    const { at, excerpt } = located(text, found.position);
    return `The ECharts option could not be parsed: ${found.message}${at}.${excerpt}`;
  }
  // What the content security policy throws instead of evaluating code.
  if (error instanceof EvalError) {
    const trust =
      "which the panel runs only in a trusted workspace. Write the option with literal values " +
      "only, as JSON, or trust the workspace (Workspaces: Manage Workspace Trust) to use " +
      "functions such as callbacks.";
    if (!found) {
      return `The ECharts option is nested too deeply to read other than as JavaScript code, ${trust}`;
    }
    const { at, excerpt } = located(text, found.position);
    return `The ECharts option has JavaScript code${at}, ${trust}${excerpt}`;
  }
  const message = errorMessage(error);
  const position =
    found && error instanceof SyntaxError
      ? syntaxErrorAt(text, found.position, message)
      : undefined;
  const { at, excerpt } =
    position === undefined ? { at: "", excerpt: "" } : located(text, position);
  return (
    `The ECharts option is neither valid JSON nor a valid JavaScript object literal: ${message.replace(/\.$/, "")}` +
    `${at}. Write it as one object, as JSON or as JavaScript when a callback needs a function.` +
    excerpt
  );
}

/** Describes what a JavaScript option threw while it was evaluated, and where. */
function describeThrown(text: string, error: unknown): string {
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
  const { at, excerpt } =
    position === undefined ? { at: "", excerpt: "" } : located(text, position);
  return `${message}${at}.${hint}${excerpt}`;
}

/**
 * The errors that the engine also gives a source cut short in the middle of a token, such as a
 * string, and the error of the reserved word that the search below ends each start of the source
 * with: the search cannot tell where these are.
 */
const CUT_SHORT_ERRORS = new Set([
  "Invalid or unexpected token",
  "Unterminated template literal",
  "Invalid regular expression: missing /",
  "Invalid Unicode escape sequence",
  "Invalid hexadecimal escape sequence",
  "Unexpected reserved word",
]);

/**
 * Where the engine finds a syntax error, which it does not say for a function it compiles: where
 * the shortest start of the source that it rejects with the same error ends, as one that ends
 * before the error is only incomplete. The start is ended with a reserved word, which it cannot be
 * continued by, for the engine not to read the end of the function as part of it. The search
 * starts from where the source goes beyond literals, as it holds no error before that.
 */
function syntaxErrorAt(text: string, from: number, message: string): number | undefined {
  if (CUT_SHORT_ERRORS.has(message)) return undefined;
  const failsAlike = (end: number) => {
    try {
      new Function(`"use strict"; return ([\n${text.slice(0, end)}\nenum`);
      return false;
    } catch (error) {
      return errorMessage(error) === message;
    }
  };
  let low = from;
  let high = text.length;
  if (!failsAlike(high)) return undefined;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (failsAlike(middle)) high = middle;
    else low = middle + 1;
  }
  // The search ends after the first character that makes the error, such as the "}" of an
  // "Unexpected token '}'": point at the start of the word or number it is part of.
  let position = Math.max(0, high - 1);
  while (
    position > from &&
    /[\w$]/.test(text.charAt(position - 1)) &&
    /[\w$]/.test(text.charAt(position))
  ) {
    position--;
  }
  return position;
}

function lineAndColumn(text: string, position: number) {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1;
  return {
    lineStart,
    line: text.slice(0, lineStart).split("\n").length,
    column: position - lineStart + 1,
  };
}

/** " (line L, column C)", and on the next lines the source line with a caret under the position. */
function located(text: string, position: number): { at: string; excerpt: string } {
  const { lineStart, line, column } = lineAndColumn(text, position);
  return {
    at: ` (line ${line}, column ${column})`,
    excerpt: `\n${excerpt(text, position, lineStart, line)}`,
  };
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

/** Thrown where the source goes beyond literal syntax, such as at a function, which only the engine can evaluate. */
class Code {
  constructor(readonly position: number) {}
}

const WORDS: Record<string, unknown> = {
  true: true,
  false: false,
  null: null,
  undefined: undefined,
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
};
const ESCAPES: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  0: "\0",
};

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
 * Reads a source written as JSON or as a JavaScript object literal, which may use comments,
 * unquoted keys, single quotes and trailing commas, into the values it holds, or locates its first
 * syntax error. It stops (throwing a Code) where the source goes beyond literals, as a function, a
 * variable or an operator does, which only the engine can evaluate.
 */
class Scanner {
  private index = 0;
  /** The objects and arrays that are open, innermost last. */
  private readonly open: { close: "}" | "]"; position: number }[] = [];

  constructor(private readonly text: string) {}

  scan(): unknown[] {
    const values: unknown[] = [];
    this.space();
    if (this.text.startsWith("```", this.index)) {
      this.fail(
        "Remove the code fence around the option: the source must be the option object alone, " +
          "as JSON or as a JavaScript object literal",
      );
    }
    while (this.char() !== "") {
      values.push(this.value());
      this.space();
      if (this.char() === "") break;
      if (this.char() !== ",") {
        this.operator();
        this.fail(
          `Unexpected ${this.found()} after the end of the option: only one top-level object is ` +
            'allowed, so check for a "}" that closes it too early',
        );
      }
      // More values: evaluateSource says how many there are.
      this.index++;
      this.space();
    }
    return values;
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

  /** Stops at an operator after a value, which makes the value part of an expression. */
  private operator(): void {
    if (matchAt(OPERATOR, this.text, this.index) !== undefined) throw new Code(this.index);
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
    if ("(/!~".includes(char)) throw new Code(this.index);
    this.fail(`Unexpected ${this.found()} while expecting ${what}`);
  }

  private value(): unknown {
    this.space();
    const char = this.char();
    if (char === "{" || char === "[") {
      return this.container(char === "{" ? "}" : "]");
    }
    if (char === '"' || char === "'") {
      return this.string(char);
    }
    if (char === "`") {
      return this.template();
    }
    if (this.text.startsWith("...", this.index) || char === "…") {
      const end = this.index + (char === "…" ? 1 : 3);
      if (char === "…" || matchAt(PLACEHOLDER_END, this.text, end) !== undefined) {
        this.fail('Write out all values: there are no placeholders such as "..."');
      }
      throw new Code(this.index); // A spread.
    }
    if (char === "-" || char === "+") {
      const sign = this.index;
      this.index++;
      this.space();
      let magnitude: number;
      if (matchAt(IDENTIFIER, this.text, this.index) === "Infinity") {
        this.index += "Infinity".length;
        magnitude = Infinity;
      } else if (/[\d.]/.test(this.char())) {
        magnitude = this.number();
      } else {
        throw new Code(sign); // The sign of an expression.
      }
      return char === "-" ? -magnitude : magnitude;
    }
    if (/[\d.]/.test(char)) {
      return this.number();
    }
    const word = matchAt(IDENTIFIER, this.text, this.index);
    if (word === undefined) this.unexpected("a value");
    return this.word(word);
  }

  private word(word: string): unknown {
    if (Object.hasOwn(WORDS, word)) {
      this.index += word.length;
      return WORDS[word];
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
    throw new Code(this.index); // A variable, a function, a "new" expression, …
  }

  private container(close: "}" | "]"): unknown[] | Record<string, unknown> {
    const array: unknown[] = [];
    const object: Record<string, unknown> = {};
    this.open.push({ close, position: this.index });
    this.index++;
    for (;;) {
      this.space();
      const char = this.char();
      if (char === close) {
        // Also after a trailing comma, which JavaScript allows.
        this.open.pop();
        this.index++;
        return close === "]" ? array : object;
      }
      if (close === "]" && char === ",") {
        // An array hole, which JavaScript allows too.
        this.index++;
        array.length++;
        continue;
      }
      if (close === "}") {
        const key = this.property();
        object[key] = this.value();
      } else {
        array.push(this.value());
      }
      if (this.separator(close)) {
        return close === "]" ? array : object;
      }
    }
  }

  /** Reads a property name and skips the ":" after it. */
  private property(): string {
    const start = this.index;
    const char = this.char();
    let name: string | undefined;
    let key: string;
    if (char === '"' || char === "'") {
      key = this.string(char);
    } else if (/[\d.]/.test(char)) {
      key = String(this.number());
    } else {
      name = matchAt(IDENTIFIER, this.text, this.index);
      if (name === undefined) {
        // A computed name, a spread or a generator method.
        if (char === "[" || char === "*" || this.text.startsWith("...", this.index)) {
          throw new Code(this.index);
        }
        this.unexpected("a property name");
      }
      this.index += name.length;
      key = name;
    }
    this.space();
    const next = this.char();
    if (next === ":") {
      // In an object literal, "__proto__" sets the prototype rather than a property.
      if (key === "__proto__") throw new Code(start);
      this.index++;
      return key;
    }
    // A method, a shorthand property or an accessor: JavaScript, but no literal to read.
    if (
      next === "(" ||
      (name !== undefined &&
        (next === "," ||
          next === "}" ||
          (/^(?:get|set|async)$/.test(name) && /["'[\p{ID_Start}$_*]/u.test(next))))
    ) {
      throw new Code(start);
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

  private string(quoteChar: string): string {
    const start = this.index;
    const missing = `missing the closing ${quoteChar === '"' ? "double" : "single"} quote`;
    this.index++;
    let value = "";
    let from = this.index;
    for (;;) {
      const char = this.char();
      if (char === quoteChar) {
        value += this.text.slice(from, this.index);
        this.index++;
        return value;
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
        value += this.text.slice(from, this.index) + this.escape();
        from = this.index;
      } else {
        this.index++;
      }
    }
  }

  /** Reads an escape sequence, rejecting the ones that strict mode JavaScript rejects. */
  private escape(): string {
    const at = this.index;
    const escaped = this.text.charAt(at + 1);
    this.index += 2;
    if (escaped === "u" || escaped === "x") {
      const digits =
        escaped === "u"
          ? matchAt(/[\da-fA-F]{4}|\{[\da-fA-F]+\}/y, this.text, this.index)
          : matchAt(/[\da-fA-F]{2}/y, this.text, this.index);
      if (digits === undefined) {
        this.fail(
          escaped === "u"
            ? 'Invalid escape: write "\\u" with four hexadecimal digits, as in "\\u00e9"'
            : 'Invalid escape: write "\\x" with two hexadecimal digits, as in "\\x41"',
          at,
        );
      }
      this.index += digits.length;
      const code = Number.parseInt(digits.replace(/[{}]/g, ""), 16);
      if (code > 0x10ffff) {
        this.fail("Invalid escape: Unicode ends at \\u{10FFFF}", at);
      }
      return String.fromCodePoint(code);
    }
    if (/[1-9]/.test(escaped) || (escaped === "0" && /\d/.test(this.char()))) {
      this.fail(
        `Invalid escape "\\${escaped}": there are no octal escapes; write "\\u" with four ` +
          "hexadecimal digits instead",
        at,
      );
    }
    if (escaped === "\r" && this.char() === "\n") {
      this.index++;
    }
    // A line continuation adds nothing.
    return /[\n\r\u2028\u2029]/.test(escaped) ? "" : (ESCAPES[escaped] ?? escaped);
  }

  private template(): string {
    const start = this.index;
    this.index++;
    let value = "";
    for (;;) {
      const char = this.char();
      if (char === "`") {
        this.index++;
        return value;
      }
      if (char === "") {
        this.fail("Unterminated template literal: missing the closing backtick", start);
      }
      if (this.text.startsWith("${", this.index)) throw new Code(this.index);
      if (char === "\\") {
        value += this.escape();
      } else if (char === "\r") {
        // A template turns its line breaks into "\n".
        value += "\n";
        this.index += this.text.charAt(this.index + 1) === "\n" ? 2 : 1;
      } else {
        value += char;
        this.index++;
      }
    }
  }

  private number(): number {
    const number = matchAt(NUMBER, this.text, this.index) ?? "";
    const end = this.index + number.length;
    const next = this.text.charAt(end);
    if (number && next === "." && IDENTIFIER_START.test(this.text.charAt(end + 1))) {
      throw new Code(this.index); // A method call, such as 1.5.toFixed(1).
    }
    if (!number || /[\w$.]/.test(next)) {
      const token = matchAt(/[\w$.]+/y, this.text, this.index);
      this.fail(
        `Invalid number ${token}: write numbers such as 5, -0.5 or 1e3, without leading zeros or ` +
          "units, and text in quotes",
      );
    }
    if (number.endsWith("n")) throw new Code(this.index); // A BigInt, which no chart takes.
    this.index = end;
    return Number(number.replaceAll("_", ""));
  }
}
