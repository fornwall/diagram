import * as assert from "node:assert";
import {
  type DiagramFence,
  fenceAt,
  findDiagramFences,
  findDocumentDiagramFences,
  isClosingFence,
  isDiagramFence,
  relocateFence,
  rewriteFence,
} from "../fences";

/**
 * The diagrams in a document, as "<opening fence line>-<last content line> <language> <prefix>".
 */
function sources(markdown: string): string[] {
  return findDiagramFences(markdown).map(
    ({ language, source, openingLine, lastLine, prefix }) =>
      `${openingLine}-${lastLine} ${language} ${JSON.stringify(prefix)}: ${JSON.stringify(source)}`,
  );
}

/** The document after writing `source` into its first diagram, or why it cannot be written. */
function rewritten(markdown: string, source: string, eol = "\n"): string | number | undefined {
  const [fence] = findDiagramFences(markdown);
  assert.ok(fence, markdown);
  const rewrite = rewriteFence(markdown, fence, source, eol);
  if (!rewrite || !("fence" in rewrite)) {
    return rewrite?.endingLine;
  }
  const written = markdown.slice(0, rewrite.start) + rewrite.text + markdown.slice(rewrite.end);
  // What was written is what is read back, at the same place.
  assert.deepStrictEqual(
    findDiagramFences(written).find((found) => found.openingLine === fence.openingLine),
    rewrite.fence,
  );
  assert.strictEqual(rewrite.fence.source, source);
  return written;
}

suite("fences", () => {
  test("document scans are shared until an edit, and never shared across documents", () => {
    let reads = 0;
    let text = "```mermaid\nA --> B\n```\n";
    const document = {
      version: 1,
      getText: () => {
        reads++;
        return text;
      },
    };
    const original = findDocumentDiagramFences(document);
    assert.strictEqual(original[0]?.source, "A --> B");
    assert.strictEqual(findDocumentDiagramFences(document), original);
    assert.strictEqual(reads, 1);

    text = "# Moved and edited\n```mermaid\nA --> C\n```\n";
    document.version++;
    const edited = findDocumentDiagramFences(document);
    assert.strictEqual(edited[0]?.source, "A --> C");
    assert.strictEqual(edited[0]?.openingLine, 1);
    assert.strictEqual(original[0]?.source, "A --> B");
    assert.strictEqual(reads, 2);
    assert.strictEqual(findDocumentDiagramFences(document), edited);

    const reopened = { version: 1, getText: () => "No diagrams remain." };
    assert.deepStrictEqual(findDocumentDiagramFences(reopened), []);
    text = "";
    document.version++;
    assert.deepStrictEqual(findDocumentDiagramFences(document), []);
  });

  test("findDiagramFences finds mermaid and echarts blocks with their content lines", () => {
    const markdown = [
      "# Notes",
      "",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "",
      "```echarts",
      '{"series": []}',
      "```",
      "",
    ].join("\n");
    assert.deepStrictEqual(findDiagramFences(markdown), [
      {
        language: "mermaid",
        source: "flowchart TD\n  A --> B",
        openingLine: 2,
        lastLine: 4,
        prefix: "",
      },
      { language: "echarts", source: '{"series": []}', openingLine: 7, lastLine: 8, prefix: "" },
    ]);
  });

  test("findDiagramFences reads an info string with words after the language", () => {
    assert.deepStrictEqual(sources("```mermaid title=Flow {highlight}\nflowchart TD\n```"), [
      '0-1 mermaid "": "flowchart TD"',
    ]);
    // The language must be the whole first word.
    assert.deepStrictEqual(sources("```mermaidx\nflowchart TD\n```"), []);
    // Only spaces and tabs are trimmed from the info string.
    assert.deepStrictEqual(sources("``` \tmermaid\u00a0\nA\n```"), ['0-1 mermaid "": "A"']);
    assert.deepStrictEqual(sources("```\u00a0mermaid\nA\n```"), []);
  });

  test("findDiagramFences handles longer fences and tilde fences", () => {
    assert.deepStrictEqual(sources("````mermaid\n```\nflowchart TD\n```\n````"), [
      '0-3 mermaid "": "```\\nflowchart TD\\n```"',
    ]);
    assert.deepStrictEqual(sources("~~~ echarts\n{}\n~~~~~\n"), ['0-1 echarts "": "{}"']);
    // A shorter closing fence, or one of the other character, does not close the block.
    assert.deepStrictEqual(sources("````mermaid\nA --> B\n```\n"), [
      '0-2 mermaid "": "A --> B\\n```"',
    ]);
    assert.deepStrictEqual(sources("~~~mermaid\nA --> B\n```\n"), [
      '0-2 mermaid "": "A --> B\\n```"',
    ]);
  });

  test("isClosingFence follows CommonMark: matching markers, indented less than 4 columns", () => {
    const backticks = { fence: "````" };
    for (const line of ["````", "   ````` \r\n", "```` \t\n", "````\r"]) {
      assert.ok(isClosingFence(line, backticks), JSON.stringify(line));
    }
    for (const line of [
      // Tabs stop every 4 columns.
      " \t````",
      "```",
      "    ````",
      "\t````",
      "~~~~",
      "```` text",
      "````~",
      "` ` ` `",
      // Only spaces and tabs are indentation and trailing whitespace.
      "\u00a0````",
      "````\u00a0",
      "x".repeat(1_000_000),
    ]) {
      assert.ok(!isClosingFence(line, backticks), JSON.stringify(line));
    }
  });

  test("findDiagramFences closes a block only at a fence indented by less than 4 columns", () => {
    // As in CommonMark, an indented fence is content, e.g. in a JavaScript template literal.
    assert.deepStrictEqual(sources("```echarts\n{}\n    ```\n```\n"), [
      '0-2 echarts "": "{}\\n    ```"',
    ]);
    assert.deepStrictEqual(sources("```mermaid\nA\n\t```\n"), ['0-2 mermaid "": "A\\n\\t```"']);
    // The opening fence's indentation is removed from the content, not from the closing fence.
    assert.deepStrictEqual(sources("  ```mermaid\n  A\n   ```\n"), ['0-1 mermaid "  ": "A"']);
    assert.deepStrictEqual(sources("  ```mermaid\n  A\n    ```\n"), [
      '0-2 mermaid "  ": "A\\n  ```"',
    ]);
    // Only spaces and tabs indent a fence.
    assert.deepStrictEqual(sources("\u00a0```mermaid\nA\n```\n"), []);
  });

  test("findDiagramFences skips fences in indented code, paragraphs and HTML blocks", () => {
    // Indented by 4 columns, outside a list item, a fence is indented code.
    assert.deepStrictEqual(sources("    ```mermaid\n    A\n    ```\n"), []);
    assert.deepStrictEqual(sources("\t```mermaid\n\tA\n\t```\n"), []);
    // Indented code cannot interrupt a paragraph, so this continues it.
    assert.deepStrictEqual(sources("Text\n    ```mermaid\n    A\n    ```\n"), []);
    // An HTML block runs to a blank line, or a comment to its end, with Markdown inside left alone.
    assert.deepStrictEqual(sources("<details>\n```mermaid\nA\n```\n</details>\n"), []);
    assert.deepStrictEqual(sources("<!--\n\n```mermaid\nA\n```\n-->\n"), []);
    assert.deepStrictEqual(
      sources("<details>\n<summary>Flow</summary>\n\n```mermaid\nA\n```\n\n</details>\n"),
      ['3-4 mermaid "": "A"'],
    );
    assert.deepStrictEqual(sources("<!-- A comment -->\n```mermaid\nA\n```\n"), [
      '1-2 mermaid "": "A"',
    ]);
    // Any other tag alone on its line cannot interrupt a paragraph.
    assert.deepStrictEqual(sources('Text\n<img src="flow.png">\n```mermaid\nA\n```\n'), [
      '2-3 mermaid "": "A"',
    ]);
    assert.deepStrictEqual(sources('<img src="flow.png">\n```mermaid\nA\n```\n'), []);
  });

  test("findDiagramFences keeps the indentation of a fence in a list item", () => {
    const markdown = [
      "1. The flow:",
      "",
      "   ```mermaid",
      "   flowchart TD",
      "       A --> B",
      "",
      "   ```",
      "",
      "2. Done.",
    ].join("\n");
    // The item's indentation is removed from each line, and deeper indentation is kept.
    assert.deepStrictEqual(sources(markdown), ['2-5 mermaid "   ": "flowchart TD\\n    A --> B"']);
    // A fence may start the item, whose content is indented by the marker and the spaces after it.
    assert.deepStrictEqual(sources("- ```mermaid\n  A\n    B\n  ```\n"), [
      '0-2 mermaid "  ": "A\\n  B"',
    ]);
    assert.deepStrictEqual(sources("10.  ```echarts\n     {}\n     ```\n"), [
      '0-1 echarts "     ": "{}"',
    ]);
    // A line indented less than the item's content ends the item, and the block in it.
    assert.deepStrictEqual(sources("1. ```mermaid\n   A\nB\n```\n"), ['0-1 mermaid "   ": "A"']);
    // Blank lines continue the item, and keep the whitespace beyond its indentation.
    assert.deepStrictEqual(sources("* ```mermaid\n  A\n\n \n     \n  B\n  ```\n"), [
      '0-5 mermaid "  ": "A\\n\\n\\n   \\nB"',
    ]);
    // In a nested item, under a paragraph that continued lazily.
    assert.deepStrictEqual(sources("- a\n  - b\nc\n\n    ```mermaid\n    A\n    ```\n"), [
      '4-5 mermaid "    ": "A"',
    ]);
    // Indented by 4 columns more than the item's content, a fence is indented code.
    assert.deepStrictEqual(sources("- a\n\n      ```mermaid\n      A\n      ```\n"), []);
    // A list marker indented by 4 columns is not one, even below a wider item (examples 312, 313).
    assert.deepStrictEqual(sources("-    a\n    - ```mermaid\n      A\n      ```\n"), []);
    assert.deepStrictEqual(sources("-    a\n\n    - ```mermaid\n      A\n      ```\n"), []);
    // Only an ordered list from 1 interrupts a paragraph, and a list item must not be empty.
    assert.deepStrictEqual(sources("Text\n2. ```mermaid\nA\n```\n"), []);
    assert.deepStrictEqual(sources("Text\n1. ```mermaid\n   A\n   ```\n"), [
      '1-2 mermaid "   ": "A"',
    ]);
    // Tabs indent to the next multiple of 4 columns.
    assert.deepStrictEqual(sources("-\t```mermaid\n\tA\n\t\tB\n\t```"), [
      '0-2 mermaid " \\t": "A\\n\\tB"',
    ]);
  });

  test("findDiagramFences finds blocks in block quotes, removing their markers", () => {
    const note = [
      "> [!NOTE]",
      "> The flow:",
      ">",
      "> ```mermaid",
      "> flowchart TD",
      ">   A --> B",
      ">",
      ">   B --> C",
      "> ```",
      "",
    ].join("\n");
    assert.deepStrictEqual(sources(note), [
      '3-7 mermaid "> ": "flowchart TD\\n  A --> B\\n\\n  B --> C"',
    ]);
    // The space after the marker is optional, and written back after it.
    assert.deepStrictEqual(sources(">```mermaid\n>A\n> B\n>```\n"), ['0-2 mermaid "> ": "A\\nB"']);
    assert.deepStrictEqual(sources("> > ```mermaid\n> > A\n> > ```\n"), [
      '0-1 mermaid "> > ": "A"',
    ]);
    // A line without the marker ends the block quote, and the block in it: code is never lazy.
    assert.deepStrictEqual(sources("> ```mermaid\n> A\nB\n> ```\n"), ['0-1 mermaid "> ": "A"']);
    assert.deepStrictEqual(sources("> > ```mermaid\n> > A\n> B\n"), ['0-1 mermaid "> > ": "A"']);
    assert.deepStrictEqual(sources("> ```mermaid\n> A\n\n> B\n"), ['0-1 mermaid "> ": "A"']);
    // A paragraph's lazy continuation line keeps the block quote open.
    assert.deepStrictEqual(sources("> Text\nlazy\n> ```mermaid\n> A\n> ```\n"), [
      '2-3 mermaid "> ": "A"',
    ]);
    // Block quotes and list items nest.
    assert.deepStrictEqual(sources("> - ```mermaid\n>   A\n>   ```\n"), [
      '0-1 mermaid ">   ": "A"',
    ]);
    assert.deepStrictEqual(sources("- > ```mermaid\n  > A\n  > ```\n"), [
      '0-1 mermaid "  > ": "A"',
    ]);
    // The optional space may be a column of a tab, whose other columns indent the fence.
    assert.deepStrictEqual(sources(">\t```mermaid\n>\tA\n>\t\tB\n>\t```\n"), [
      '0-2 mermaid ">\\t": "A\\n\\tB"',
    ]);
  });

  test("findDiagramFences takes a fence that is never closed to the end of the document", () => {
    assert.deepStrictEqual(sources("```mermaid\nflowchart TD\n  A --> B\n"), [
      '0-2 mermaid "": "flowchart TD\\n  A --> B"',
    ]);
    assert.deepStrictEqual(sources("```mermaid\nflowchart TD"), ['0-1 mermaid "": "flowchart TD"']);
    assert.deepStrictEqual(sources("```mermaid\n"), []);
    assert.deepStrictEqual(sources("```mermaid"), []);
  });

  test("findDiagramFences skips other languages, their contents and empty blocks", () => {
    // A diagram fence inside another code block is code, not a diagram of its own.
    assert.deepStrictEqual(sources("````md\n```mermaid\nflowchart TD\n```\n````\n"), []);
    assert.deepStrictEqual(sources("```ts\nconst x = 1;\n```\n"), []);
    assert.deepStrictEqual(sources("```\nflowchart TD\n```\n"), []);
    assert.deepStrictEqual(sources("```mermaid\n```\n```mermaid\n\n  \n```\n"), []);
    // Fences that are not on a line of their own neither open nor close a block.
    assert.deepStrictEqual(sources("Use a ```mermaid``` block.\n"), []);
  });

  test("findDiagramFences counts lines as VS Code does, whatever the line endings", () => {
    assert.deepStrictEqual(sources("# Notes\r\n```mermaid\r\nflowchart TD\r\n```\r\n"), [
      '1-2 mermaid "": "flowchart TD"',
    ]);
  });

  test("findDiagramFences skips long prose and code while preserving diagram positions", () => {
    const prose = "A paragraph with an inline ```mermaid marker.\n".repeat(10_000);
    const code = "````text\n```mermaid\nNot a diagram\n```\n````\n";
    assert.deepStrictEqual(findDiagramFences(`${prose}${code}  ~~~echarts\r\n  {}\r\n\r\n  ~~~`), [
      {
        language: "echarts",
        source: "{}",
        openingLine: 10_005,
        lastLine: 10_007,
        prefix: "  ",
      },
    ]);
  });

  test("rewriteFence writes every line behind the block's prefix", () => {
    assert.strictEqual(
      rewritten("Before\n```mermaid\nA\n```\nAfter\n", "B\n  C"),
      "Before\n```mermaid\nB\n  C\n```\nAfter\n",
    );
    // Empty lines keep only the block quote markers, which hold the block quote together.
    // Whitespace-only lines are written like any other line.
    assert.strictEqual(
      rewritten("> Note:\n> ```mermaid\n> A\n> ```\n> End.\n", "B\n\n  C\n \t\nD"),
      "> Note:\n> ```mermaid\n> B\n>\n>   C\n>  \t\n> D\n> ```\n> End.\n",
    );
    assert.strictEqual(
      rewritten("  ```mermaid\n  A\n  ```\n", "B\n\n  \nC"),
      "  ```mermaid\n  B\n\n    \n  C\n  ```\n",
    );
    assert.strictEqual(
      rewritten("> - ```mermaid\n>   A\n>   ```\n", "B\n\nC"),
      "> - ```mermaid\n>   B\n>\n>   C\n>   ```\n",
    );
    assert.strictEqual(
      rewritten("1. Flow:\n\n   ```mermaid\n   A\n   ```\n2. Done\n", "B\n\n C\n  \nD"),
      "1. Flow:\n\n   ```mermaid\n   B\n\n    C\n     \n   D\n   ```\n2. Done\n",
    );
    // The marker's optional space is added, so that a line starting with a space keeps it.
    assert.strictEqual(
      rewritten(">>```mermaid\n>>A\n>>```\n", " B"),
      ">>```mermaid\n> >  B\n>>```\n",
    );
    // Tabs are kept, unless they follow an added space and would change width.
    assert.strictEqual(
      rewritten(">\t```mermaid\n>\tA\n", "B\n\tC"),
      ">\t```mermaid\n>\tB\n>\t\tC\n",
    );
    assert.strictEqual(rewritten(">>\t```mermaid\n>>\tA", " B"), ">>\t```mermaid\n> >   B");
    assert.strictEqual(
      rewritten("-\t```mermaid\r\n\tA\r\n\t```\r\n", "B\n C", "\r\n"),
      "-\t```mermaid\r\n \tB\r\n \t C\r\n\t```\r\n",
    );
  });

  test("rewriteFence keeps the blank lines around the source as they are", () => {
    assert.strictEqual(
      rewritten("```mermaid\n\nA\n  \n```\nAfter\n", "B\n\nC"),
      "```mermaid\n\nB\n\nC\n  \n```\nAfter\n",
    );
    assert.strictEqual(
      rewritten("> ```mermaid\r\n>\r\n> A\r\n>\r\n> ```\r\n", "B", "\r\n"),
      "> ```mermaid\r\n>\r\n> B\r\n>\r\n> ```\r\n",
    );
    // Also at the end of a block that is never closed.
    assert.strictEqual(rewritten("```mermaid\nA\n\t", "B\nC"), "```mermaid\nB\nC\n\t");
    assert.strictEqual(rewritten("```mermaid\n\nA", "B\nC"), "```mermaid\n\nB\nC");
    // A closing fence in the source is reported by its line in the source.
    assert.strictEqual(rewritten("```mermaid\n\n\nA\n```\n", "B\nC\n```\nD"), 2);
  });

  test("findDiagramFences and rewriteFence keep lines of no-break spaces around a diagram", () => {
    // Only lines of spaces and tabs are blank in Markdown.
    assert.deepStrictEqual(sources("```mermaid\n \t\n\u00a0\nA\n\u00a0\n\n```"), [
      '0-5 mermaid "": "\u00a0\\nA\\n\u00a0"',
    ]);
    assert.strictEqual(
      rewritten("> ```mermaid\n> A\n> ```\n", "\u00a0\nB\n\u00a0"),
      "> ```mermaid\n> \u00a0\n> B\n> \u00a0\n> ```\n",
    );
  });

  test("rewriteFence reports the source line that would end the block", () => {
    assert.strictEqual(rewritten("```mermaid\nA\n```\n", "B\n```\nC"), 1);
    assert.strictEqual(rewritten("> ~~~mermaid\n> A\n> ~~~\n", "~~~~"), 0);
    // A fence indented by 4 columns in the block is content.
    assert.strictEqual(
      rewritten("- ```mermaid\n  A\n  ```\n", "    ```"),
      "- ```mermaid\n      ```\n  ```\n",
    );
  });

  test("findDiagramFences does not mistake in-line separators for new document lines", () => {
    for (const separator of ["\r", "\u2028", "\u2029"]) {
      assert.deepStrictEqual(sources(`prose${separator}\`\`\`mermaid\nA\n\`\`\``), []);
      assert.deepStrictEqual(sources(`\`\`\`mermaid${separator}x\nA\n\`\`\``), [
        '0-1 mermaid "": "A"',
      ]);
      assert.deepStrictEqual(sources(`\`\`\`mermaid\nA${separator}\`\`\`\nB\n\`\`\``), [
        `0-2 mermaid "": ${JSON.stringify(`A${separator}\`\`\`\nB`)}`,
      ]);
    }
  });

  test("fenceAt finds the fence at, below and above the cursor", () => {
    //         0     1            2   3     4            5   6
    const text = "a\n```mermaid\nA\n```\n```mermaid\nB\n```\nz\n";
    const fences = findDiagramFences(text);
    assert.deepStrictEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map((line) => fenceAt(fences, line)?.source),
      ["A", "A", "A", "A", "B", "B", "B", "B"],
    );
    assert.strictEqual(fenceAt([], 0), undefined);
  });

  test("relocateFence finds a fence that moved, and nothing when it changed", () => {
    const read: DiagramFence = {
      language: "mermaid",
      source: "flowchart TD\n  A --> B",
      openingLine: 2,
      lastLine: 4,
      prefix: "",
    };
    const moved = findDiagramFences(
      "# Notes\n\nText was added above.\n\n```mermaid\nflowchart TD\n  A --> B\n```\n",
    );
    assert.strictEqual(relocateFence(moved, read)?.openingLine, 4);
    // Edited in the document, gone from it, or now written in another language.
    const edited = findDiagramFences("```mermaid\nflowchart TD\n  A --> C\n```\n");
    assert.strictEqual(relocateFence(edited, read), undefined);
    assert.strictEqual(relocateFence([], read), undefined);
    const other = findDiagramFences("```echarts\nflowchart TD\n  A --> B\n```\n");
    assert.strictEqual(relocateFence(other, read), undefined);
  });

  test("relocateFence keeps an unchanged block but refuses ambiguous moved copies", () => {
    const text = "```mermaid\nA\n```\n```mermaid\nA\n```\n```mermaid\nA\n```\n";
    const fences = findDiagramFences(text);
    const read = { language: "mermaid", source: "A", prefix: "" } as const;
    const near = (openingLine: number) =>
      relocateFence(fences, { ...read, openingLine, lastLine: openingLine + 1 })?.openingLine;
    assert.deepStrictEqual([near(0), near(3), near(5), near(9)], [0, 3, undefined, undefined]);
  });

  test("relocateFence does not substitute a duplicate for a block edited in place", () => {
    const original = "```mermaid\nA\n```\n```mermaid\nA\n```\n";
    const read = findDiagramFences(original)[0];
    assert.ok(read);
    const edited = findDiagramFences(original.replace("\nA\n", "\nB\n"));
    assert.strictEqual(relocateFence(edited, read), undefined);
  });

  test("isDiagramFence accepts only fences, as a command may be called with anything", () => {
    const fence: DiagramFence = {
      language: "mermaid",
      source: "flowchart TD",
      openingLine: 0,
      lastLine: 1,
      prefix: "",
    };
    assert.ok(isDiagramFence(fence));
    const malformed: unknown[] = [
      null,
      undefined,
      "```mermaid",
      [fence],
      { ...fence, language: "dot" },
      { ...fence, source: 1 },
      { ...fence, prefix: undefined },
      { ...fence, openingLine: -1 },
      { ...fence, openingLine: 1.5 },
      // The content must be at least one line long, below the opening fence.
      { ...fence, lastLine: 0 },
    ];
    for (const value of malformed) {
      assert.ok(!isDiagramFence(value), JSON.stringify(value));
    }
  });
});
