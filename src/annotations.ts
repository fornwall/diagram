// Validate diagram_annotate input.

import {
  type Annotation,
  type DiagramMark,
  isMarkKind,
  isPlainObject,
  MARK_KINDS,
} from "./protocol";
import { givenProperties, quoteAll, unknownProperties } from "./text";

/** As declared in package.json, but a model may not follow the schema exactly. */
export interface AnnotateInput {
  marks?: { id: string; mark?: string; note?: string }[];
  caption?: string;
  dim?: boolean;
}

const INPUT_KEYS = ["marks", "caption", "dim"] as const satisfies readonly (keyof AnnotateInput)[];
const MARK_KEYS = ["id", "mark", "note"] as const;

const MAX_MARKS = 50;
const MAX_TEXT_LENGTH = 120;

const EXAMPLE = '{"marks": [{"id": "pay", "mark": "problem", "note": "times out here"}]}';

/** Each call replaces all marks. Reject malformed input with a list of problems. */
export function validateAnnotation(value: unknown): Annotation {
  if (!isPlainObject(value)) {
    throw new Error(`The marks must be given as an object, e.g. ${EXAMPLE}.`);
  }
  const input = givenProperties(value);
  const problems: string[] = [];
  const unknown = unknownProperties(input, INPUT_KEYS);
  if (unknown !== undefined) {
    problems.push(unknown);
  }

  const marks: DiagramMark[] = [];
  if (input.marks !== undefined) {
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

  let caption: string | undefined;
  if (input.caption !== undefined) {
    const problem = textProblem(input.caption, "caption");
    if (problem) {
      problems.push(problem);
    } else {
      caption = (input.caption as string).trim() || undefined;
    }
  }
  if (input.dim !== undefined && typeof input.dim !== "boolean") {
    problems.push('"dim" must be true or false.');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid marks:\n- ${problems.join("\n- ")}`);
  }
  return { marks, caption, dim: input.dim === true };
}

function parseMark(given: unknown, marked: Set<string>): DiagramMark | string {
  // A model may name a node without saying how to mark it, as a bare id rather than an object.
  const value = typeof given === "string" ? { id: given } : given;
  if (!isPlainObject(value)) {
    return 'A mark must be an object, e.g. {"id": "pay", "mark": "problem"}.';
  }
  const unknown = unknownProperties(value, MARK_KEYS);
  if (unknown !== undefined) {
    return unknown;
  }
  // Chart names are identities: "A" and " A " may name different data items.
  const id = typeof value.id === "string" ? value.id : "";
  if (!id.trim()) {
    return '"id" must be the id of a node of the diagram, as a non-empty string.';
  }
  if (marked.has(id)) {
    return `${JSON.stringify(id)} is marked twice; give each node one mark.`;
  }
  marked.add(id);
  const kind = value.mark ?? "current";
  if (!isMarkKind(kind)) {
    return `"mark" must be one of ${quoteAll(MARK_KINDS)}.`;
  }
  if (value.note === undefined || value.note === null) {
    return { id, kind };
  }
  const problem = textProblem(value.note, "note");
  if (problem) {
    return problem;
  }
  const note = (value.note as string).trim();
  return note ? { id, kind, note } : { id, kind };
}

function textProblem(value: unknown, key: string): string | undefined {
  if (typeof value !== "string") {
    return `"${key}" must be a string.`;
  }
  return value.trim().length > MAX_TEXT_LENGTH
    ? `"${key}" must be at most ${MAX_TEXT_LENGTH} characters, as the panel shows it on one line.`
    : undefined;
}
