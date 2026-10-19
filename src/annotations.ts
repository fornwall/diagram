// Validate diagram_annotate input.

import {
  type Annotation,
  type DiagramMark,
  isMarkKind,
  isPlainObject,
  MARK_KINDS,
} from "./protocol";
import { brief, givenProperties, quoteAll, unknownProperties } from "./text";

/** As declared in package.json, but a model may not follow the schema exactly. */
export interface AnnotateInput {
  marks?: { id: string; mark?: string }[];
  dim?: boolean;
}

const INPUT_KEYS = ["marks", "dim"] as const satisfies readonly (keyof AnnotateInput)[];
const MARK_KEYS = ["id", "mark"] as const;

const MAX_MARKS = 50;

const EXAMPLE = '{"marks": [{"id": "pay", "mark": "problem"}]}';

/** Each call replaces all marks. Reject malformed input with a list of problems. */
export function validateAnnotation(value: unknown): Annotation {
  if (!isPlainObject(value)) {
    throw new Error(`The marks must be given as an object, e.g. ${EXAMPLE}.`);
  }
  const input = givenProperties(value);
  // The panel showed a caption above the drawing once; the chat answer says it now.
  delete input.caption;
  const problems: string[] = [];
  const unknown = unknownProperties(input, INPUT_KEYS);
  if (unknown !== undefined) {
    problems.push(unknown);
  }

  const marks: DiagramMark[] = [];
  if (input.marks !== undefined) {
    // One mark, as a model may send it without an array.
    if (!Array.isArray(input.marks)) input.marks = [input.marks];
    if (!Array.isArray(input.marks)) {
      problems.push(
        `"marks" must be an array of objects, e.g. ${EXAMPLE}; leave it out to clear the marks.`,
      );
    } else if (input.marks.length > MAX_MARKS) {
      problems.push(
        `"marks" has ${input.marks.length} marks, more than the ${MAX_MARKS} the panel shows; ` +
          "mark only what the user should look at.",
      );
    } else {
      const marked = new Set<string>();
      for (const [index, given] of input.marks.entries()) {
        const mark = parseMark(given, marked);
        if (typeof mark === "string") {
          problems.push(`Mark ${index + 1}: ${mark}`);
        } else {
          marks.push(mark);
        }
      }
    }
  }

  if (input.dim !== undefined && typeof input.dim !== "boolean") {
    problems.push('"dim" must be true or false.');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid marks:\n- ${problems.join("\n- ")}`);
  }
  return { marks, dim: input.dim === true };
}

function parseMark(given: unknown, marked: Set<string>): DiagramMark | string {
  // A model may name a node without saying how to mark it, as a bare id rather than an object.
  const value = typeof given === "string" ? { id: given } : given;
  if (!isPlainObject(value)) {
    return 'A mark must be an object, e.g. {"id": "pay", "mark": "problem"}.';
  }
  const mark = givenProperties(value);
  // As the caption: the chat answer says what a mark is about.
  delete mark.note;
  const unknown = unknownProperties(mark, MARK_KEYS);
  if (unknown !== undefined) {
    return unknown;
  }
  // Chart names are identities: "A" and " A " may name different data items.
  const id = typeof mark.id === "string" ? mark.id : "";
  if (!id.trim()) {
    return '"id" must be the id of a node of the diagram, as a non-empty string.';
  }
  if (marked.has(id)) {
    return `${JSON.stringify(id)} is marked twice; give each node one mark.`;
  }
  marked.add(id);
  // As a model may write it: "Problem".
  const kind = typeof mark.mark === "string" ? mark.mark.toLowerCase() : (mark.mark ?? "current");
  if (!isMarkKind(kind)) {
    return `"mark" is ${brief(kind)}; it must be one of ${quoteAll(MARK_KINDS)}.`;
  }
  return { id, kind };
}

/**
 * Whether the input has a caption or notes, as the panel showed them above the drawing once. It
 * leaves them out, and the model should say them in its answer instead.
 */
export function hasText(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const text = (given: unknown) => typeof given === "string" && given.trim() !== "";
  const marks: unknown[] = Array.isArray(value.marks) ? value.marks : [value.marks];
  return text(value.caption) || marks.some((mark) => isPlainObject(mark) && text(mark.note));
}
