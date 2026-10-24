import * as assert from "node:assert";
import {
  allAnnotationMarks,
  annotationFrame,
  mapAnnotationMarks,
  validateAnnotation,
} from "../annotations";
import { thrown } from "./thrown";

/** What validateAnnotation refuses, for an input that can only be corrected by the model. */
const problems = (input: unknown) => thrown(validateAnnotation, input);

suite("annotations", () => {
  test("takes the marks and how they read", () => {
    assert.deepStrictEqual(
      validateAnnotation({
        marks: [
          { id: "pay", mark: "problem" },
          // Preserve exact chart names; "current" is the default mark.
          { id: " retry " },
          { id: "done", mark: "good" },
          // A model may name a node without saying how to mark it, as a bare id.
          "log",
          // Or write the kind of mark as a word.
          { id: "flag", mark: "Info" },
        ],
        dim: true,
      }),
      {
        marks: [
          { id: "pay", kind: "problem" },
          { id: " retry ", kind: "current" },
          { id: "done", kind: "good" },
          { id: "log", kind: "current" },
          { id: "flag", kind: "info" },
        ],
        dim: true,
      },
    );
  });

  test("takes one mark without an array, as a model may send it", () => {
    assert.deepStrictEqual(validateAnnotation({ marks: "pay" }).marks, [
      { id: "pay", kind: "current" },
    ]);
    assert.deepStrictEqual(validateAnnotation({ marks: { id: "pay", mark: "good" } }).marks, [
      { id: "pay", kind: "good" },
    ]);
  });

  test("keeps names that differ only by surrounding spaces distinct", () => {
    assert.deepStrictEqual(validateAnnotation({ marks: ["A", " A "] }).marks, [
      { id: "A", kind: "current" },
      { id: " A ", kind: "current" },
    ]);
  });

  test("reads an input without marks as clearing them", () => {
    const cleared = { marks: [], dim: false };
    assert.deepStrictEqual(validateAnnotation({}), cleared);
    assert.deepStrictEqual(validateAnnotation({ marks: [] }), cleared);
    // Models send null for the properties they leave out.
    assert.deepStrictEqual(validateAnnotation({ marks: null, dim: null }), cleared);
    assert.deepStrictEqual(validateAnnotation({ marks: [{ id: "a", mark: null }] }), {
      ...cleared,
      marks: [{ id: "a", kind: "current" }],
    });
  });

  test("refuses an input that the model has to correct", () => {
    for (const value of [null, undefined, "pay", ["pay"], 42]) {
      assert.match(problems(value), /The marks must be given as an object/);
    }
    assert.match(problems({ marks: 42 }), /Mark 1: A mark must be an object/);
    assert.match(problems({ marks: [42] }), /Mark 1: A mark must be an object/);
    assert.match(problems({ marks: [{}] }), /Mark 1: "id" must be the id of a node/);
    assert.match(problems({ marks: [{ id: " " }] }), /Mark 1: "id" must be the id of a node/);
    assert.match(
      problems({ marks: [{ id: "a" }, { id: "a" }] }),
      /Mark 2: "a" is marked twice; give each node one mark\./,
    );
    assert.match(
      problems({ marks: [{ id: "a", mark: "red" }] }),
      /Mark 1: "mark" is "red"; it must be one of "current", "problem", "good", "info"\./,
    );
    // Long or odd values are named briefly.
    assert.match(
      problems({ marks: [{ id: "a", mark: "x".repeat(50) }] }),
      /Mark 1: "mark" is "x{40}…"; it must be one of/,
    );
    assert.match(problems({ marks: [{ id: "a", mark: 3 }] }), /Mark 1: "mark" is 3; it must be/);
    assert.match(
      problems({ marks: [{ id: "a", label: "Pay" }] }),
      /Mark 1: Unknown property "label"; the properties are "id", "mark", "text"\./,
    );
    assert.match(problems({ dim: "yes" }), /"dim" must be true or false\./);
    assert.match(
      problems({ clear: true }),
      /Unknown property "clear"; the properties are "marks", "dim", "focus", "steps", "revision"\./,
    );
    assert.match(
      problems({ caption: "Look here" }),
      /Unknown property "caption"; the properties are "marks", "dim", "focus", "steps", "revision"\./,
    );
    assert.match(
      problems({ marks: [{ id: "pay", note: "times out after 30 s" }] }),
      /Mark 1: Unknown property "note"; the properties are "id", "mark", "text"\./,
    );
    // Too many marks to tell apart, and every problem is reported at once.
    const many = Array.from({ length: 51 }, (_, index) => ({ id: `n${index}` }));
    assert.match(problems({ marks: many }), /"marks" has 51 marks, more than the 50/);
    assert.match(problems({ marks: [{ id: "" }], dim: 1 }), /"id".*\n.*dim/s);
  });

  test("keeps literal callout text and resolves marks independently per walkthrough step", () => {
    const annotation = validateAnnotation({
      dim: true,
      focus: true,
      steps: [
        { text: "Request arrives", marks: [{ id: "A", text: "<script> is plain text" }] },
        {
          text: "Request fails",
          marks: [{ id: "A", mark: "problem", text: "Timeout" }],
          dim: false,
          focus: false,
        },
      ],
    });
    assert.strictEqual(annotation.step, 0);
    assert.deepStrictEqual(annotationFrame(annotation), {
      text: "Request arrives",
      marks: [{ id: "A", kind: "current", text: "<script> is plain text" }],
      dim: true,
      focus: true,
    });
    assert.deepStrictEqual(annotationFrame({ ...annotation, step: 1 }), {
      text: "Request fails",
      marks: [{ id: "A", kind: "problem", text: "Timeout" }],
      dim: false,
      focus: false,
    });
    assert.strictEqual(allAnnotationMarks(annotation).length, 2);
    const mapped = mapAnnotationMarks(annotation, (marks) =>
      marks.map((mark) => ({ ...mark, id: "B" })),
    );
    assert.deepStrictEqual(
      allAnnotationMarks(mapped).map(({ id }) => id),
      ["B", "B"],
    );
    assert.strictEqual(mapped.steps?.[0]?.marks[0]?.text, "<script> is plain text");
    assert.strictEqual(annotation.steps?.[0]?.marks[0]?.id, "A");
  });

  test("bounds walkthroughs and callouts and rejects conflicting frames", () => {
    assert.match(problems({ focus: 1 }), /"focus" must be true or false/);
    for (const text of ["", " ", 1, "x".repeat(501)]) {
      assert.match(problems({ marks: [{ id: "A", text }] }), /"text" must contain/);
    }
    for (const steps of [[], 1, Array(21).fill({ text: "Step" })]) {
      assert.match(problems({ steps }), /from 1 to 20/);
    }
    assert.match(problems({ steps: [{ text: "x".repeat(1001) }] }), /Step 1: "text"/);
    assert.match(problems({ steps: [null] }), /Step 1: A step must be an object/);
    assert.match(problems({ steps: [{ text: "One", unknown: 1 }] }), /Unknown property/);
    assert.match(problems({ steps: [{ text: "One", focus: 1 }] }), /Step 1: "focus"/);
    assert.match(problems({ steps: [{ text: "One", marks: ["A", "A"] }] }), /marked twice/);
    assert.match(problems({ marks: ["A"], steps: [{ text: "One" }] }), /inside the steps/);
    assert.deepStrictEqual(
      validateAnnotation({ steps: [{ text: "One", marks: null, dim: null }] }),
      {
        marks: [],
        dim: false,
        steps: [{ text: "One", marks: [], dim: false }],
        step: 0,
      },
    );
  });
});
