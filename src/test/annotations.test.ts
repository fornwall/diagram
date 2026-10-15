import * as assert from "node:assert";
import { validateAnnotation } from "../annotations";
import { thrown } from "./thrown";

/** What validateAnnotation refuses, for an input that can only be corrected by the model. */
const problems = (input: unknown) => thrown(validateAnnotation, input);

suite("annotations", () => {
  test("takes the marks, their notes and how they read", () => {
    assert.deepStrictEqual(
      validateAnnotation({
        marks: [
          { id: "pay", mark: "problem", note: " times out after 30 s " },
          // Preserve exact chart names; "current" is the default mark.
          { id: " retry " },
          { id: "done", mark: "good" },
          // A model may name a node without saying how to mark it, as a bare id.
          "log",
          // Or write the kind of mark as a word.
          { id: "flag", mark: "Info" },
        ],
        caption: " Step 2 of 3: the request is retried ",
        dim: true,
      }),
      {
        marks: [
          { id: "pay", kind: "problem", note: "times out after 30 s" },
          { id: " retry ", kind: "current" },
          { id: "done", kind: "good" },
          { id: "log", kind: "current" },
          { id: "flag", kind: "info" },
        ],
        caption: "Step 2 of 3: the request is retried",
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
    const cleared = { marks: [], caption: undefined, dim: false };
    assert.deepStrictEqual(validateAnnotation({}), cleared);
    assert.deepStrictEqual(validateAnnotation({ marks: [] }), cleared);
    // Models send null for the properties they leave out.
    assert.deepStrictEqual(validateAnnotation({ marks: null, caption: null, dim: null }), cleared);
    assert.deepStrictEqual(validateAnnotation({ marks: [{ id: "a", mark: null, note: null }] }), {
      ...cleared,
      marks: [{ id: "a", kind: "current" }],
    });
    // A caption alone leaves nothing marked, and a blank one is no caption at all.
    assert.deepStrictEqual(validateAnnotation({ caption: "Look here" }), {
      ...cleared,
      caption: "Look here",
    });
    assert.deepStrictEqual(validateAnnotation({ caption: "  " }), cleared);
    // An empty note is no note, rather than an empty line under the caption.
    assert.deepStrictEqual(validateAnnotation({ marks: [{ id: "a", note: " " }] }), {
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
      /Mark 1: Unknown property "label"; the properties are "id", "mark", "note"\./,
    );
    assert.match(problems({ marks: [{ id: "a", note: 42 }] }), /Mark 1: "note" must be a string/);
    assert.match(
      problems({ marks: [{ id: "a", note: "x".repeat(121) }] }),
      /Mark 1: "note" must be at most 120 characters/,
    );
    assert.match(problems({ caption: 42 }), /"caption" must be a string\./);
    assert.match(problems({ caption: "x".repeat(121) }), /"caption" must be at most 120/);
    assert.match(problems({ dim: "yes" }), /"dim" must be true or false\./);
    assert.match(
      problems({ clear: true }),
      /Unknown property "clear"; the properties are "marks", "caption", "dim"\./,
    );
    // Too many marks to tell apart, and every problem is reported at once.
    const many = Array.from({ length: 51 }, (_, index) => ({ id: `n${index}` }));
    assert.match(problems({ marks: many }), /"marks" has 51 marks, more than the 50/);
    assert.match(
      problems({ marks: [{ id: "" }], caption: 1, dim: 1 }),
      /"id".*\n.*caption.*\n.*dim/s,
    );
  });
});
