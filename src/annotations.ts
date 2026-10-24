// Validate diagram_annotate input.

import {
  type Annotation,
  type AnnotationStep,
  type DiagramMark,
  isMarkKind,
  isPlainObject,
  MARK_KINDS,
} from "./protocol";
import { brief, givenProperties, quoteAll, unknownProperties } from "./text";

/** As declared in package.json, but a model may not follow the schema exactly. */
export interface AnnotateInput {
  revision?: number;
  marks?: { id: string; mark?: string; text?: string }[];
  dim?: boolean;
  focus?: boolean;
  steps?: { text: string; marks?: AnnotateInput["marks"]; dim?: boolean; focus?: boolean }[];
}

const INPUT_KEYS = [
  "marks",
  "dim",
  "focus",
  "steps",
  "revision",
] as const satisfies readonly (keyof AnnotateInput)[];
const MARK_KEYS = ["id", "mark", "text"] as const;
const STEP_KEYS = ["text", "marks", "dim", "focus"] as const;

const MAX_MARKS = 50;

const EXAMPLE = '{"marks": [{"id": "pay", "mark": "problem"}]}';

/** Each call replaces all marks. Reject malformed input with a list of problems. */
export function validateAnnotation(value: unknown): Annotation {
  if (!isPlainObject(value)) {
    throw new Error(`The marks must be given as an object, e.g. ${EXAMPLE}.`);
  }
  const input = givenProperties(value);
  if (
    input.revision !== undefined &&
    (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0)
  )
    throw new Error('"revision" must be a nonnegative integer from diagram_getState.');
  const problems: string[] = [];
  const unknown = unknownProperties(input, INPUT_KEYS);
  if (unknown !== undefined) {
    problems.push(unknown);
  }

  const marks = parseMarks(input.marks, problems);
  for (const key of ["dim", "focus"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") {
      problems.push(`"${key}" must be true or false.`);
    }
  }

  let steps: AnnotationStep[] | undefined;
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 20) {
      problems.push('"steps" must contain from 1 to 20 walkthrough steps.');
    } else {
      steps = [];
      for (const [index, value] of input.steps.entries()) {
        const issues: string[] = [];
        if (!isPlainObject(value)) {
          issues.push("A step must be an object.");
        } else {
          const step = givenProperties(value);
          const unknown = unknownProperties(step, STEP_KEYS);
          if (unknown) issues.push(unknown);
          if (typeof step.text !== "string" || !step.text.trim() || step.text.length > 1000) {
            issues.push('"text" must contain from 1 to 1,000 characters.');
          }
          for (const key of ["dim", "focus"] as const) {
            if (step[key] !== undefined && typeof step[key] !== "boolean") {
              issues.push(`"${key}" must be true or false.`);
            }
          }
          const marks = parseMarks(step.marks, issues);
          if (issues.length === 0) {
            steps.push({
              text: step.text as string,
              marks,
              dim: (step.dim ?? input.dim) === true,
              ...((step.focus ?? input.focus) !== undefined && {
                focus: (step.focus ?? input.focus) === true,
              }),
            });
          }
        }
        problems.push(...issues.map((issue) => `Step ${index + 1}: ${issue}`));
      }
    }
    if (marks.length > 0) problems.push('Use "marks" inside the steps, not beside "steps".');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid marks:\n- ${problems.join("\n- ")}`);
  }
  return {
    marks,
    dim: input.dim === true,
    ...(input.focus !== undefined && { focus: input.focus === true }),
    ...(steps && { steps, step: 0 }),
  };
}

function parseMarks(input: unknown, problems: string[]): DiagramMark[] {
  const marks: DiagramMark[] = [];
  if (input !== undefined) {
    // One mark, as a model may send it without an array.
    const given = Array.isArray(input) ? input : [input];
    if (given.length > MAX_MARKS) {
      problems.push(
        `"marks" has ${given.length} marks, more than the ${MAX_MARKS} the panel shows; ` +
          "mark only what the user should look at.",
      );
    } else {
      const marked = new Set<string>();
      for (const [index, item] of given.entries()) {
        const mark = parseMark(item, marked);
        if (typeof mark === "string") {
          problems.push(`Mark ${index + 1}: ${mark}`);
        } else {
          marks.push(mark);
        }
      }
    }
  }

  return marks;
}

function parseMark(given: unknown, marked: Set<string>): DiagramMark | string {
  // A model may name a node without saying how to mark it, as a bare id rather than an object.
  const value = typeof given === "string" ? { id: given } : given;
  if (!isPlainObject(value)) {
    return 'A mark must be an object, e.g. {"id": "pay", "mark": "problem"}.';
  }
  const mark = givenProperties(value);
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
  if (
    mark.text !== undefined &&
    (typeof mark.text !== "string" || !mark.text.trim() || mark.text.length > 500)
  ) {
    return '"text" must contain from 1 to 500 characters.';
  }
  return { id, kind, ...(typeof mark.text === "string" && { text: mark.text }) };
}

/** The marks currently displayed, including the selected walkthrough step. */
export function annotationFrame(annotation: Annotation): Annotation | AnnotationStep {
  return annotation.steps?.[annotation.step ?? 0] ?? annotation;
}

/** All marks, including those in later walkthrough steps. */
export function allAnnotationMarks(annotation: Annotation): DiagramMark[] {
  return [...annotation.marks, ...(annotation.steps?.flatMap((step) => step.marks) ?? [])];
}

/** Resolve or remove marks in each frame independently. */
export function mapAnnotationMarks(
  annotation: Annotation,
  map: (marks: DiagramMark[]) => DiagramMark[],
): Annotation {
  return {
    ...annotation,
    marks: map(annotation.marks),
    ...(annotation.steps && {
      steps: annotation.steps.map((step) => ({ ...step, marks: map(step.marks) })),
    }),
  };
}
