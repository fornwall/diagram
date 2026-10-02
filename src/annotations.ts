// The marks an agent puts on the diagram already shown, as given to the diagram_annotate tool, and
// their validation.

import { quoteAll } from "./chartSpec";
import {
  type Annotation,
  type DiagramMark,
  isMarkKind,
  isPlainObject,
  MARK_KINDS,
} from "./protocol";

/** As declared in package.json, but a model may not follow the schema exactly. */
export interface AnnotateInput {
  marks?: { id: string; mark?: string; note?: string }[];
  caption?: string;
  dim?: boolean;
}

const INPUT_KEYS = ["marks", "caption", "dim"] as const satisfies readonly (keyof AnnotateInput)[];
const MARK_KEYS = ["id", "mark", "note"] as const;

/** How many nodes one annotation marks: a walkthrough points at a few at a time, not at everything. */
const MAX_MARKS = 50;

/** A caption and a note are one line each in the panel, so a longer one is refused, not cut short. */
const MAX_TEXT_LENGTH = 120;

const EXAMPLE = '{"marks": [{"id": "pay", "mark": "problem", "note": "times out here"}]}';

/**
 * Checks the markup a model gave for the diagram shown, the input of the annotate tool, and returns
 * it as an {@link Annotation}. Marks without an id, a caption alone and an empty input all clear the
 * marks, as every annotation replaces the one before it.
 *
 * @throws Error listing everything that needs to be fixed. Unlike a diagram's links, the marks are
 *   the whole point of the call, so a bad one is reported instead of quietly left out.
 */
export function validateAnnotation(value: unknown): Annotation {
  if (!isPlainObject(value)) {
    throw new Error(`The marks must be given as an object, e.g. ${EXAMPLE}.`);
  }
  // Some models send null for the properties they leave out.
  const input = Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined),
  );
  const problems: string[] = [];
  const unknown = Object.keys(input).filter((key) => !isKey(INPUT_KEYS, key));
  if (unknown.length > 0) {
    problems.push(
      `Unknown ${unknown.length === 1 ? "property" : "properties"} ${quoteAll(unknown)}; ` +
        `the properties are ${quoteAll(INPUT_KEYS)}.`,
    );
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

/** One mark as a model gave it, or what is wrong with it. */
function parseMark(given: unknown, marked: Set<string>): DiagramMark | string {
  // A model may name a node without saying how to mark it, as a bare id rather than an object.
  const value = typeof given === "string" ? { id: given } : given;
  if (!isPlainObject(value)) {
    return 'it must be an object, e.g. {"id": "pay", "mark": "problem"}.';
  }
  const unknown = Object.keys(value).filter((key) => !isKey(MARK_KEYS, key));
  if (unknown.length > 0) {
    return `unknown ${unknown.length === 1 ? "property" : "properties"} ${quoteAll(unknown)}; a mark has ${quoteAll(MARK_KEYS)}.`;
  }
  // Node ids are trimmed, as a model may pad them, like the ids of a diagram's links.
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) {
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

/** What is wrong with a caption or a note, if anything: the panel shows each of them on one line. */
function textProblem(value: unknown, key: string): string | undefined {
  if (typeof value !== "string") {
    return `"${key}" must be a string.`;
  }
  return value.trim().length > MAX_TEXT_LENGTH
    ? `"${key}" must be at most ${MAX_TEXT_LENGTH} characters, as the panel shows it on one line.`
    : undefined;
}

function isKey(keys: readonly string[], key: string): boolean {
  return keys.includes(key);
}
