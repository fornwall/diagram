import * as assert from "node:assert";
import * as vscode from "vscode";
import { DIAGRAM_TYPES, describeError } from "../webview/mermaidErrors";
import { RELAYOUT_DELAY } from "../webview/mermaidRenderer";
import { DRAG_IMAGE, MERMAID, suitePage, UNTIL } from "./webviewHarness";

/**
 * Webview code defining `retheme(id)`, which changes the theme's id as a new theme does, taking
 * it away given `undefined`, waits for the diagram drawn in that theme and returns the id it
 * had; with what `UNTIL` defines.
 */
const RETHEME = `
  ${UNTIL}
  const retheme = async (id) => {
    const { dataset } = document.body;
    const previous = dataset.vscodeThemeId;
    const drawn = document.querySelector("#diagram svg");
    if (id === undefined) delete dataset.vscodeThemeId;
    else dataset.vscodeThemeId = id;
    await until(() => !drawn.isConnected, "the diagram drawn in the theme " + id);
    return previous;
  };`;

suite("Mermaid in the webview", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  const page = suitePage();
  const { evaluate, render, draw } = page;
  /** Renders the Mermaid source, for the error it fails with. */
  const renderError = async (source: string): Promise<string | undefined> => {
    const outcome = await render({ source });
    return outcome.ok ? undefined : outcome.error;
  };
  /** Renders each Mermaid source in turn, for the errors they fail with. */
  const errors = async (...sources: string[]): Promise<(string | undefined)[]> => {
    const found = [];
    for (const source of sources) found.push(await renderError(source));
    return found;
  };

  test("renders Mermaid diagrams of the common types, laid out outside the flow of the panel", async () => {
    // Mermaid draws in an element of its own, by default at the end of the body, where it would
    // take room from the panel while rendering. (Text it measures synchronously is not drawn.)
    await evaluate(`(() => {
      window.testBodyDrawings = 0;
      window.testBodyObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.id?.startsWith("ddiagram-")) window.testBodyDrawings++;
          }
        }
      });
      window.testBodyObserver.observe(document.body, {childList: true});
    })()`);
    for (const [diagramType, source] of Object.entries(MERMAID)) {
      assert.deepStrictEqual(await render({ source }), { ok: true, diagramType });
    }
    assert.ok(!(await render({ source: "flowchart TD\n  A@{ shape: nosuch }" })).ok);
    assert.deepStrictEqual(
      await evaluate(`(() => {
        window.testBodyObserver.disconnect();
        return {drawings: window.testBodyDrawings, left: document.querySelectorAll('[id^="ddiagram-"]').length};
      })()`),
      { drawings: 0, left: 0 },
    );
  });

  test("shows each date on a Gantt chart's axis once, apart from the others, also in images", async () => {
    // d3 ticks a week every 12 hours, and a narrow panel has no room for a date at each.
    await evaluate(`document.getElementById("canvas").style.maxWidth = "400px"`);
    try {
      await draw({ source: MERMAID.gantt });
      const dates = (await evaluate(`(async () => {
        const shown = (svg) => [...svg.querySelectorAll("g.grid > g.tick > text")]
          .filter(text => text.getAttribute("visibility") !== "hidden");
        const labels = shown(document.querySelector("#diagram svg"));
        const boxes = labels.map(text => text.getBoundingClientRect());
        ${DRAG_IMAGE}
        const image = (await dragImage()).getData("image/svg+xml");
        return {
          panel: labels.map(text => text.textContent),
          apart: boxes.every((box, i) => i === 0 || box.left > boxes[i - 1].right),
          image: shown(new DOMParser().parseFromString(image, "image/svg+xml")).map(text => text.textContent),
        };
      })()`)) as { panel: string[]; apart: boolean; image: string[] };
      assert.ok(dates.panel.length >= 2, dates.panel.join());
      assert.strictEqual(new Set(dates.panel).size, dates.panel.length, dates.panel.join());
      assert.ok(dates.apart, dates.panel.join());
      assert.strictEqual(new Set(dates.image).size, dates.image.length, dates.image.join());
    } finally {
      await evaluate(`document.getElementById("canvas").style.maxWidth = ""`);
    }
  });

  test("draws Gantt charts at the width of the canvas they are shown in", async () => {
    for (const view of ["split", "visual", "source"]) {
      if (view === "source") {
        // The first chart drawn in the Source view takes the width of the Visual view.
        await evaluate(`(() => {
          document.querySelector(".mermaid-layout").style.width = "";
          document.getElementById("view-source").click();
        })()`);
        await draw({ source: MERMAID.gantt });
        // The canvas fits the drawing in the frame after the one in which it sees its new size.
        await evaluate(`(async () => {
          document.getElementById("view-visual").click();
          for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
        })()`);
      } else {
        await evaluate(`document.getElementById("view-${view}").click()`);
        await draw({ source: MERMAID.gantt });
      }
      const { drawn, room, zoom } = (await evaluate(`(() => {
        const canvas = document.getElementById("canvas");
        const style = getComputedStyle(canvas);
        return {
          drawn: document.querySelector("#diagram svg").viewBox.baseVal.width,
          room: canvas.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          zoom: document.getElementById("zoom-reset").textContent,
        };
      })()`)) as { drawn: number; room: number; zoom: string };
      assert.ok(Math.abs(drawn - room) < 1, `${view}: drawn ${drawn} wide in ${room}`);
      assert.strictEqual(zoom, "100%", view);
    }
  });

  test("lays Gantt charts out again at a new canvas width, keeping zoom, selection and focus", async () => {
    // As the split view would, unless the panel is so narrow that it stacks the panes.
    const narrow = `(() => {
      const canvas = document.getElementById("canvas");
      canvas.style.maxWidth = canvas.offsetWidth * 0.6 + "px";
    })()`;
    // Other diagrams are only scaled.
    await draw({ source: MERMAID["flowchart-v2"] });
    assert.strictEqual(
      await evaluate(`(async () => {
        const svg = document.querySelector("#diagram svg");
        ${narrow};
        // Well past when a Gantt chart would be laid out again, rendering included.
        await new Promise(resolve => setTimeout(resolve, ${RELAYOUT_DELAY + 300}));
        document.getElementById("canvas").style.maxWidth = "";
        return document.querySelector("#diagram svg") === svg;
      })()`),
      true,
    );
    await draw({ source: MERMAID.gantt });
    const result = await evaluate(`(async () => {
      const canvas = document.getElementById("canvas");
      const task = () => document.querySelector('#diagram rect.task[tabindex]');
      task().dispatchEvent(new MouseEvent("click", {bubbles: true}));
      document.getElementById("zoom-in").click();
      const before = document.querySelector("#diagram svg");
      ${narrow};
      task().focus();
      ${UNTIL}
      await until(() => document.querySelector("#diagram svg") !== before);
      const style = getComputedStyle(canvas);
      const result = {
        drawn: Math.round(document.querySelector("#diagram svg").viewBox.baseVal.width),
        room: Math.round(canvas.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
        zoom: document.getElementById("zoom-reset").textContent,
        selected: task().classList.contains("diagram-selected"),
        focused: document.activeElement === task(),
      };
      canvas.style.maxWidth = "";
      document.getElementById("zoom-reset").click();
      return result;
    })()`);
    const { room } = result as { room: number };
    assert.deepStrictEqual(result, {
      drawn: room,
      room,
      zoom: "125%",
      selected: true,
      focused: true,
    });
  });

  test("lays a Gantt chart out again at the next resize after laying it out failed", async () => {
    await draw({ source: MERMAID.gantt });
    const result = await evaluate(`(async () => {
      const canvas = document.getElementById("canvas");
      const layout = document.querySelector(".mermaid-layout");
      const shown = { svg: document.querySelector("#diagram svg"), width: layout.style.width };
      const measure = Element.prototype.getBoundingClientRect;
      let failures = 0;
      Element.prototype.getBoundingClientRect = function () {
        if (this.closest(".mermaid-layout")) {
          failures++;
          throw new Error("Test failure");
        }
        return measure.call(this);
      };
      ${UNTIL}
      try {
        canvas.style.maxWidth = canvas.offsetWidth * 0.6 + "px";
        await until(() => failures > 0);
      } finally {
        Element.prototype.getBoundingClientRect = measure;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      const kept = document.querySelector("#diagram svg") === shown.svg && layout.style.width === shown.width;
      // Less than a relayout takes, but from the width that the shown drawing has.
      canvas.style.maxWidth = parseFloat(canvas.style.maxWidth) - 4 + "px";
      await until(() => document.querySelector("#diagram svg") !== shown.svg);
      const style = getComputedStyle(canvas);
      const room = canvas.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      canvas.style.maxWidth = "";
      return { kept, relaidOut: Math.abs(document.querySelector("#diagram svg").viewBox.baseVal.width - room) < 1 };
    })()`);
    assert.deepStrictEqual(result, { kept: true, relaidOut: true });
  });

  test("scrolls past every side of a Mermaid drawing larger than the canvas", async () => {
    await draw({ source: "flowchart LR\n  A[Left] --> B[Middle] --> C[Right]" });
    const padded = await evaluate(`(async () => {
      for (let i = 0; i < 12; i++) document.getElementById("zoom-in").click();
      const canvas = document.getElementById("canvas");
      const visible = canvas.getBoundingClientRect();
      const right = visible.left + canvas.clientLeft + canvas.clientWidth;
      const bottom = visible.top + canvas.clientTop + canvas.clientHeight;
      const svg = document.querySelector("#diagram svg");
      canvas.scrollTo(0, 0);
      const start = svg.getBoundingClientRect();
      canvas.scrollTo(canvas.scrollWidth, canvas.scrollHeight);
      const end = svg.getBoundingClientRect();
      document.getElementById("zoom-reset").click();
      // Some of the canvas padding shows beyond each side.
      return {left: start.left - visible.left >= 1, top: start.top - visible.top >= 1,
        right: right - end.right >= 1, bottom: bottom - end.bottom >= 1};
    })()`);
    assert.deepStrictEqual(padded, { left: true, top: true, right: true, bottom: true });
  });

  test("shows Mermaid labels whole, in the boxes Mermaid measured for them", async () => {
    // Mermaid measures labels outside the canvas (see layoutContainer), so styles that apply only
    // where the drawing is shown would make labels overflow the boxes laid out for them.
    const diagrams = [
      'flowchart TD\n  A[A label long enough to wrap onto several lines] -->|edge label| B{"`**Bold** and _emphasis_`"}\n  B --> C[Line one<br>line two]\n  subgraph S [A subgraph title]\n    C --> D[漢字のラベル 😀]\n  end',
      "sequenceDiagram\n  actor U as A user\n  U->>S: A long message to the server\n  Note over U,S: A note over both",
      "classDiagram\n  class Animal {\n    <<abstract>>\n    +String name\n    +makeSound(volume int) void\n  }\n  Animal <|-- Duck : inherits",
      "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy : start a long job\n  state Busy {\n    [*] --> Working\n  }",
      'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  CUSTOMER {\n    string name PK "full name"\n  }',
      "mindmap\n  root((A central idea))\n    A branch with a longer label\n    Another",
      "journey\n  section Work\n    Make tea with a long name: 5: Me",
      "kanban\n  todo[To do]\n    t1[Write the documentation for a feature]",
    ];
    for (const source of diagrams) {
      await draw({ source });
      const overflows = await evaluate(`(() => {
        const svg = document.querySelector("#diagram svg");
        const drawing = svg.getBoundingClientRect();
        const problems = [];
        for (const box of svg.querySelectorAll("foreignObject")) {
          if (!box.textContent.trim()) continue;
          const outer = box.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(box);
          for (const line of range.getClientRects()) {
            for (const bounds of [outer, drawing]) {
              if (line.left < bounds.left - 1 || line.right > bounds.right + 1 ||
                line.top < bounds.top - 1 || line.bottom > bounds.bottom + 1) {
                problems.push(box.textContent.trim());
              }
            }
          }
        }
        return [...new Set(problems)];
      })()`);
      assert.deepStrictEqual(overflows, [], source.split("\\n")[0]);
    }
  });

  test("widens the drawing for text that Mermaid draws beyond it, also in images", async () => {
    // Mermaid places long radar axis labels and quadrant point labels partly outside its view box.
    // It draws a line for today far beyond a Gantt chart of other dates, which the view box leaves out.
    for (const source of [
      'radar-beta\n  axis m["Math"], e["English literature and composition"]\n  curve a["Alice"]{85, 80}',
      "quadrantChart\n  A point with a long label near the edge: [0.98, 0.5]",
      "gantt\n  dateFormat YYYY-MM-DD\n  Task :2000-01-01, 7d",
    ]) {
      await draw({ source });
      const result = (await evaluate(`(async () => {
        const svg = document.querySelector("#diagram svg");
        const drawing = svg.getBoundingClientRect();
        const clipped = Array.from(svg.querySelectorAll("text"), text => text.getBoundingClientRect())
          .filter(text => text.width && (text.left < drawing.left - 1 || text.right > drawing.right + 1
            || text.top < drawing.top - 1 || text.bottom > drawing.bottom + 1)).length;
        ${DRAG_IMAGE}
        const image = (await dragImage()).getData("image/svg+xml");
        const exported = new DOMParser().parseFromString(image, "image/svg+xml").documentElement;
        return {clipped, viewBox: svg.getAttribute("viewBox") === exported.getAttribute("viewBox")};
      })()`)) as { clipped: number; viewBox: boolean };
      assert.deepStrictEqual(result, { clipped: 0, viewBox: true }, source);
      assert.ok(
        await evaluate(`(() => {
          const canvas = document.getElementById("canvas");
          return canvas.scrollWidth <= canvas.clientWidth;
        })()`),
        source,
      );
    }
  });

  test("shows Mermaid tooltips in the colors of the theme's hovers", async () => {
    await draw({ source: 'flowchart LR\n  A --> B\n  click A callback "A tooltip"' });
    const colors = await evaluate(`(async () => {
      document.querySelector("#diagram g.node[title]").dispatchEvent(new MouseEvent("mouseover"));
      const tooltip = document.querySelector(".mermaidTooltip");
      const hover = document.createElement("div");
      hover.style.cssText = "color: var(--vscode-editorHoverWidget-foreground); background: var(--vscode-editorHoverWidget-background)";
      document.body.append(hover);
      const [shown, expected] = [tooltip, hover].map(element => {
        const style = getComputedStyle(element);
        return [style.color, style.backgroundColor];
      });
      hover.remove();
      return {text: tooltip.textContent, same: JSON.stringify(shown) === JSON.stringify(expected)};
    })()`);
    assert.deepStrictEqual(colors, { text: "A tooltip", same: true });
  });

  test("selection updates only the changed Mermaid nodes", async () => {
    const source = `flowchart LR\n${Array.from({ length: 24 }, (_, i) => `A${i}[Node ${i}]`).join("\n")}`;
    await draw({ source });
    assert.deepStrictEqual(
      await evaluate(`(() => {
        const diagram = document.getElementById("diagram");
        const observer = new MutationObserver(() => {});
        observer.observe(diagram, {subtree: true, attributes: true, attributeFilter: ["aria-pressed"]});
        const changes = () => [...new Set(observer.takeRecords().map(record => record.target.getAttribute("data-diagram-id")))].sort();
        const click = (id, shiftKey = false) => diagram.querySelector('[data-diagram-id="' + id + '"]').dispatchEvent(new MouseEvent("click", {bubbles: true, shiftKey}));
        try {
          click("A0");
          const first = changes();
          click("A1", true);
          const second = changes();
          click("A1");
          const third = changes();
          document.getElementById("clear-selection").click();
          return [first, second, third, changes()];
        } finally {
          observer.disconnect();
        }
      })()`),
      [["A0"], ["A1"], ["A0"], ["A1"]],
    );
  });

  test("annotation updates touch only changed Mermaid marks", async () => {
    const source = `flowchart LR\n${Array.from({ length: 24 }, (_, i) => `A${i}[Node ${i}]`).join("\n")}`;
    await draw({ source });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const diagram = document.getElementById("diagram");
        const changed = new Set();
        const toggle = DOMTokenList.prototype.toggle;
        const markVisits = [];
        let visits = 0;
        DOMTokenList.prototype.toggle = function (token, ...args) {
          if (token.startsWith("diagram-mark")) visits++;
          return toggle.call(this, token, ...args);
        };
        const observer = new MutationObserver(records => {
          for (const record of records) {
            const id = record.target.getAttribute("data-diagram-id");
            if (id) changed.add(id);
          }
        });
        observer.observe(diagram, {subtree: true, attributes: true, attributeFilter: ["class"]});
        const mark = async (marks, dim = false) => {
          changed.clear();
          visits = 0;
          receive({type: "annotate", marks, dim});
          await new Promise(resolve => setTimeout(resolve, 0));
          markVisits.push(visits);
          return [...changed].sort();
        };
        try {
          const first = await mark([{id: "A0", kind: "problem"}]);
          const notesOnly = await mark([{id: "A0", kind: "problem", note: "More detail"}], true);
          const replacement = await mark([{id: "A0", kind: "good"}, {id: "A1", kind: "info"}]);
          const node = diagram.querySelector('[data-diagram-id="A0"]');
          const replaced = node.classList.contains("diagram-mark-good") && !node.classList.contains("diagram-mark-problem");
          const cleared = await mark([]);
          return {first, notesOnly, replacement, replaced, cleared, markVisits, remaining: diagram.querySelectorAll(".diagram-marked").length};
        } finally {
          DOMTokenList.prototype.toggle = toggle;
          observer.disconnect();
        }
      })()`),
      {
        first: ["A0"],
        notesOnly: [],
        replacement: ["A0", "A1"],
        replaced: true,
        cleared: ["A0", "A1"],
        markVisits: [1, 0, 2, 2],
        remaining: 0,
      },
    );
  });

  test("moves the focus between Mermaid nodes with arrow keys from one tab stop", async () => {
    await draw({ source: "flowchart LR\n  A --> B\n  A --> C\n  C --> D" });
    const moves = (await evaluate(`(() => {
      const stops = () => Array.from(document.querySelectorAll('#diagram [tabindex="0"]'), e => e.dataset.diagramId);
      const press = (key) => {
        document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles: true, cancelable: true}));
        return document.activeElement.dataset.diagramId;
      };
      const initial = stops();
      document.querySelector('#diagram [data-diagram-id="A"][tabindex]').focus();
      return {initial, right: [press("ArrowRight"), press("ArrowRight")], stops: stops(),
        back: [press("ArrowLeft"), press("ArrowLeft")], end: press("End"), home: press("Home"),
        edge: press("ArrowLeft")};
    })()`)) as Record<string, string | string[]>;
    const [edge, target] = moves.right as string[];
    assert.match(edge ?? "", /^edge:L_A_(B|C)_0$/);
    assert.strictEqual(target, edge?.slice("edge:L_A_".length, -2));
    const { initial, stops, back, end, home, edge: leftOfA } = moves;
    assert.strictEqual(initial?.length, 1);
    // Nothing is left of A.
    assert.deepStrictEqual(
      { stops, back, end, home, leftOfA },
      { stops: [target], back: [edge, "A"], end: "D", home: "A", leftOfA: "A" },
    );
  });

  test("keeps keyboard focus on a Mermaid node when a new version of the diagram arrives", async () => {
    await draw({ source: "flowchart LR\n  A --> B" });
    await evaluate(`document.querySelector('#diagram [data-diagram-id="B"][tabindex]').focus()`);
    await draw({ source: "flowchart LR\n  A --> B --> C" });
    assert.strictEqual(
      await evaluate(`document.activeElement.getAttribute("data-diagram-id")`),
      "B",
    );
    await evaluate(`document.querySelector('#diagram [data-diagram-id="C"][tabindex]').focus()`);
    await draw({ source: "flowchart LR\n  A --> B" });
    assert.strictEqual(await evaluate(`document.activeElement.id`), "canvas");
  });

  test("leaves the focus alone when the page lost it during a new rendering", async () => {
    // As if the user went to, say, the command palette while the diagram rendered: a node's
    // focus() would take the focus back within seconds of a click in the panel.
    const leave = `(() => {
      document.querySelector('#diagram [data-diagram-id="B"][tabindex]').focus();
      document.hasFocus = () => false;
    })()`;
    await draw({ source: "flowchart LR\n  A --> B" });
    await evaluate(leave);
    try {
      await draw({ source: "flowchart LR\n  A --> B --> C" });
      const versioned = await evaluate(`document.activeElement.tagName`);
      await evaluate(leave);
      const themed = await evaluate(`(async () => {
        ${RETHEME}
        const original = await retheme("test-theme-unfocused");
        const focused = document.activeElement.tagName;
        await retheme(original);
        return focused;
      })()`);
      assert.deepStrictEqual([versioned, themed], ["BODY", "BODY"]);
    } finally {
      await evaluate(`delete document.hasFocus`);
    }
  });

  test("keeps keyboard focus and selection on a Mermaid node when the theme redraws it", async () => {
    await draw({
      source: MERMAID["flowchart-v2"],
      links: { A: { file: "src/parser.ts", line: 42 } },
    });
    page.panel.annotate({ marks: [{ id: "A", kind: "info" }], dim: true });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const node = document.querySelector('#diagram [data-diagram-id="A"][tabindex]');
        node.dispatchEvent(new MouseEvent("click", {bubbles: true, shiftKey: true}));
        node.focus();
        ${RETHEME}
        const original = document.body.dataset.vscodeThemeId;
        try {
          await retheme("test-theme-redraw");
          const focused = document.activeElement;
          return {
            id: focused?.getAttribute("data-diagram-id"),
            selected: focused?.classList.contains("diagram-selected"),
            pressed: focused?.getAttribute("aria-pressed"),
            marked: focused?.classList.contains("diagram-mark-info"),
            link: focused?.querySelector("title.diagram-link")?.textContent,
            tooltips: focused?.querySelectorAll("title.diagram-link").length
          };
        } finally {
          // The theme coming back redraws too, which the next test must not see.
          await retheme(original);
        }
      })()`),
      {
        id: "A",
        selected: true,
        pressed: "true",
        marked: true,
        link: "Open src/parser.ts#L42",
        tooltips: 1,
      },
    );
  });

  test("leaves the drawing alone while VS Code shows its context menu over the panel", async () => {
    // A redraw would give the focus back to the node right-clicked, taking it from the export
    // format picker that the menu opened, which then closed.
    await draw({ source: MERMAID["flowchart-v2"] });
    assert.strictEqual(
      await evaluate(`(async () => {
        const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let redraws = 0;
        const observer = new MutationObserver(() => redraws++);
        observer.observe(document.getElementById("diagram"), {childList: true});
        for (const visible of [true, false]) {
          document.body.classList.toggle("vscode-context-menu-visible", visible);
          await frames();
        }
        // A theme change redraws after anything the menu would have queued.
        ${RETHEME}
        const original = await retheme("test-context-menu");
        await frames();
        const counted = redraws;
        await retheme(original);
        observer.disconnect();
        return counted;
      })()`),
      1,
    );
  });

  test("names an unknown Mermaid diagram type, and what it could be", async () => {
    assert.deepStrictEqual(
      await errors("flowchar TD\n  A --> B", "sequence\n  A->>B: x", "erdiagram", "C4"),
      [
        'Unknown diagram type "flowchar": did you mean "flowchart"?',
        'Unknown diagram type "sequence": did you mean "sequenceDiagram"?',
        'Unknown diagram type "erdiagram": did you mean "erDiagram"?',
        'Unknown diagram type "C4": did you mean "C4Context", "C4Container" or "C4Component"?',
      ],
    );
    const [unknown, fenced, labeled, empty] = await errors(
      "nonsense\n  A --> B",
      "```mermaid\nflowchart TD\n  A --> B\n```",
      "mermaid\nflowchart TD",
      " \n%% only a comment\n",
    );
    assert.match(
      unknown ?? "",
      /^Unknown diagram type "nonsense": start the diagram with its type, such as flowchart, /,
    );
    assert.match(fenced ?? "", /^Remove the code fence/);
    assert.match(labeled ?? "", /^Remove the "mermaid" line/);
    assert.match(empty ?? "", /^The diagram is empty: start it with the diagram type/);
  });

  test("knows the diagram types that Mermaid detects", async function () {
    this.timeout(60_000);
    for (const type of DIAGRAM_TYPES) {
      assert.doesNotMatch((await renderError(`${type}\n  !`)) ?? "", /Unknown diagram type/, type);
    }
  });

  test("reports Mermaid syntax errors at their line and column in the source", async () => {
    // Mermaid parses the text without front matter, directives, comment lines and leading blank
    // lines, normalizes line breaks and encodes entities, and some diagrams change it further.
    const preamble = ["---", "title: T", "---", '%%{init: {"theme": "dark"}}%%', "%% comment", ""];
    const cases: [string[], string][] = [
      // The flowchart parser drops blank lines after "}".
      [
        ["flowchart TD", "  A{x} --> B{y}", "", "", "  B -> C"],
        'Parse error on line 12, column 5: unexpected "-"',
      ],
      [
        ["flowchart LR", '  A["#quot;Hi#quot;"] -- x'],
        "Parse error on line 9, column 27: unexpected end of the diagram",
      ],
      [
        ["sequenceDiagram", "  Alice->>Bob: Hi", "  Alice->>: x"],
        'Parse error on line 10, column 11: unexpected ": x"',
      ],
      [
        ["classDiagram", "  class A {", "    +x int", "  }", "", "  A <|-- -- B"],
        'Parse error on line 13, column 10: unexpected "--"',
      ],
      [
        ["stateDiagram-v2", "  [*] --> S", "  S --> --> T"],
        'Parse error on line 10, column 9: unexpected "-->"; expected ID or EDGE_STATE.',
      ],
      [
        ["erDiagram", "  A ||--o{ B : has", "  A ||-- B"],
        'Parse error on line 10, column 10: unexpected "B"',
      ],
      [
        ["gantt", "  dateFormat YYYY-MM-DD", "  Task :a1, 2026-01-01, 7d", "  : : :"],
        'Parse error on line 11, column 3: unexpected ": : :"',
      ],
      // Blank lines after the type, which Mermaid fails on in mind maps and kanban boards, are left out.
      [
        ["mindmap", "", "  root((Plan))", "    A", "    B))("],
        'Parse error on line 12, column 8: unexpected "("',
      ],
      [
        ["kanban", " ", "  Todo", "    Task))("],
        'Parse error on line 11, column 11: unexpected "("',
      ],
      // A lexer error, which Jison reports without a column.
      [
        ["quadrantChart", "  x-axis Low --> High", "  Point A: [0.3, 0.6] !"],
        'Parse error on line 10, column 23: unexpected "!".',
      ],
      // The sankey parser drops blank lines.
      [
        ["sankey", "A,B,10", "", 'B,C,"x'],
        "Parse error on line 11, column 7: unexpected end of the diagram",
      ],
      // Spaces at the end are not what the parser stopped at.
      [
        ["block-beta", "  a b", "  a --> "],
        "Parse error on line 10, column 8: unexpected end of the diagram; expected NODE_ID.",
      ],
      [
        ["C4Context", '  Person(a, "A")', "  Rel(a,"],
        "Parse error on line 10, column 9: unexpected end of the diagram",
      ],
      // Langium parsers report each error.
      [
        ["pie", '  "Dogs" : 386', "  Rats : 1", "  Cats : 2"],
        'Parse error on line 10, column 3: unexpected "Rats".\nParse error on line 11, column 3: unexpected "Cats".',
      ],
      [
        ["gitGraph", "  commit", "  comit"],
        'Parse error on line 10, column 3: unexpected "comit"; expected end of the diagram.',
      ],
      [
        ["treemap-beta", '  "A"', '    "B": 1', '    "C" x'],
        'Parse error on line 11, column 9: unexpected "x"; expected STRING2 or CLASS_DEF.',
      ],
      // Agent flows keep comment lines.
      [
        ["agentflow-beta", "  %% kept", "  A --> B", "  B -> --> C"],
        'Parse error on line 11, column 5: unexpected "-"',
      ],
      [
        ["usecase-beta", "  actor A", "  A --> --> B"],
        'Parse error on line 10, column 9: unexpected "-->"',
      ],
    ];
    for (const [[header, ...body], expected] of cases) {
      const source = [...preamble, header, "  %% comment", ...body].join("\r\n");
      const error = await renderError(source);
      assert.ok(error?.startsWith(expected), `${header}: ${error}`);
    }
  });

  test("draws mind maps, kanban boards and Ishikawa diagrams with blank lines after their type", async () => {
    // Mermaid fails on the indentation after them, also after a comment line it removes.
    for (const [header, node] of [
      ["mindmap", "root((Plan))"],
      ["kanban", "Todo"],
      ["ishikawa-beta", "Problem"],
    ] as const) {
      const source = `---\ntitle: T\n---\n${header}\n\n  %% comment\n  \n  ${node}\n    Child`;
      await draw({ source });
      const text = (await evaluate(`document.querySelector("#diagram svg").textContent`)) as string;
      assert.match(text, /Child/, header);
    }
  });

  test("reports invalid YAML at its line and column in the source", async () => {
    assert.deepStrictEqual(
      await errors(
        "---\ntitle: T\nconfig:\n  theme: : x\n---\nflowchart TD",
        "flowchart TD\n  A@{ shape: [ } --> B",
        "flowchart TD\n  A@{\n    label: [\n  } --> B",
      ),
      [
        "Invalid YAML in the front matter on line 4, column 10: bad indentation of a mapping entry.",
        "Invalid YAML in the node's metadata on line 2, column 16: missed comma between flow collection entries.",
        "Invalid YAML in the node's metadata on line 4, column 3: unexpected end of the stream within a flow collection.",
      ],
    );
    // Agent flows check the shapes of nodes themselves, and number the lines of the source.
    assert.strictEqual(
      await renderError("---\ntitle: T\n---\nagentflow-beta\n  %% c\n  A@{ shape: nope } --> B"),
      "Error on line 6, column 4: No such shape: nope.",
    );
  });

  test("finds the lines of errors that Mermaid gives no position for", async () => {
    assert.deepStrictEqual(
      await errors(
        "gantt\n  dateFormat YYYY-MM-DD\n  Task :a1, 2026-01-01, 3d\n  Other :a2, notadate, 7d",
        // Mermaid's own check of the indices misses them.
        "flowchart TD\n  A --> B\n  linkStyle 0 stroke:red\n  linkStyle 0,4 stroke:blue",
        "flowchart TD\n  A --> B\n  C@{ shape: nosuch }",
        "mindmap\n  root((R))\n    A\n  B",
        // Mermaid makes up a parser's error, which put it on line 1.
        "sequenceDiagram\n  Alice->>+Bob: Hi\n  Bob-->>-Alice: Yo\n  deactivate Bob",
        // Others quote what they are about.
        'C4Context\n  Person(u, "User")\n  Rel(u, s, "Uses")',
        "---\nconfig:\n  layout: cose-bilkent\n---\nflowchart TD\n  A --> B",
      ),
      [
        'Error on line 4: Invalid date "notadate": write dates as the dateFormat says, YYYY-MM-DD.',
        "Error on line 4: linkStyle 4 refers to no link: links are numbered from 0, in the order the diagram defines them.",
        "Error on line 3: No such shape: nosuch.",
        'Error on line 4: A mind map has one root: indent "B" below it.',
        'Error on line 4: "Bob" is deactivated, but it is not active.',
        'Error on line 3: C4 rel "u" -> "s" references an unknown shape or boundary',
        'The cose-bilkent layout only lays out mind maps: set "layout" to "dagre" or "elk" instead.',
      ],
    );
    const elk = (message: string, source: string) =>
      (describeError(new Error(message), source, () => "flowchart-v2") as Error).message;
    assert.strictEqual(
      elk(
        "org.eclipse.elk.graph.json.JsonImportException: Referenced shape does not exist: A",
        "flowchart TD\n  subgraph S\n    A\n  end",
      ),
      'Error on line 3: Mermaid cannot lay out the edges of "A": give the groups and the nodes different ids.',
    );
  });

  test("refuses edges in groups inside themselves, which Mermaid would lay out forever", async () => {
    assert.deepStrictEqual(
      await errors(
        "stateDiagram-v2\n  [*] --> A\n  state A {\n    [*] --> A\n  }",
        "stateDiagram-v2\n  state A {\n    A --> B\n  }",
        "flowchart TD\n  X --> A\n  subgraph A\n    subgraph B\n      A\n    end\n  end",
        "flowchart TD\n  subgraph A\n    subgraph B\n      A\n      C --> D\n    end\n  end",
        "classDiagram\n  namespace A {\n    class A\n  }\n  X --> A",
        "classDiagram\n  namespace A {\n    class A\n    class B\n  }\n  A --> B",
        // Of the parents of P.A, Q and P, the layout takes the group that comes last: P.
        "classDiagram\n  namespace Q {\n    class P.A\n  }\n  namespace P.A {\n    class P\n  }\n  X --> P",
        // dagre fails on groups inside themselves without such edges too.
        "---\nconfig:\n  layout: dagre\n---\nclassDiagram\n  namespace A {\n    class A\n  }",
      ),
      [
        [3, "A"],
        [2, "A"],
        [3, "A"],
        [3, "B"],
        [2, "A"],
        [2, "A"],
        [5, "P"],
        [6, "A"],
      ].map(
        ([line, group]) =>
          `Error on line ${line}: "${group}" is inside itself, which Mermaid cannot lay out: give the group and what it contains different ids.`,
      ),
    );
    // Groups inside themselves without such edges draw.
    for (const source of [
      "kanban\n  Review\n    Review\n  Done\n    Ship",
      "kanban\n  todo[Todo]\n    todo[Write docs]",
      "classDiagram\n  namespace A {\n    class A\n  }",
      "classDiagram\n  namespace A {\n    class A\n  }\n  X --> Y",
      "classDiagram\n  namespace A {\n    class A\n    class B\n  }\n  B --> A",
    ]) {
      await draw({ source });
    }
  });

  test("explains Mermaid's limits", async () => {
    const edges = Array.from({ length: 501 }, (_, i) => `  n${i} --> n${i + 1}`);
    const outcome = await render({ source: `flowchart TD\n${edges.join("\n")}` });
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /^The diagram has more than 500 edges/);
    // Mermaid would draw a message in place of the diagram.
    const long = await render({ source: `flowchart TD\n${"  A --> B\n".repeat(5000)}` });
    assert.ok(!long.ok);
    assert.match(long.error, /^The diagram is too long/);
  });

  test("selects sequence footer participants by identity when their labels match", async () => {
    await draw({
      source: "sequenceDiagram\n participant A as Service\n actor B as Service\n A->>B: Hello",
    });
    assert.deepStrictEqual(
      await evaluate(`(() => {
        return [...document.querySelectorAll('#diagram .actor-bottom')].map(footer => {
          footer.dispatchEvent(new MouseEvent('click', {bubbles: true}));
          return {
            name: footer.getAttribute('name'),
            selected: [...document.querySelectorAll('#diagram [data-et="participant"].diagram-selected')]
              .map(node => node.getAttribute('data-id'))
          };
        }).sort((a, b) => a.name.localeCompare(b.name));
      })()`),
      [
        { name: "A", selected: ["A"] },
        { name: "B", selected: ["B"] },
      ],
    );
  });

  test("reports the node ids it drew, and marks them on the diagram it already shows", async () => {
    await draw({ source: MERMAID["flowchart-v2"] });
    assert.deepStrictEqual([...(page.panel.drawnIds ?? [])].sort(), ["A", "B"]);
    const marked = page.panel.annotate({
      marks: [
        { id: "A", kind: "problem", note: "fails here" },
        { id: "B", kind: "good" },
      ],
      caption: "Step 1 of 2",
      dim: true,
    });
    assert.ok(marked.ok);
    assert.deepStrictEqual(marked.unknown, []);
    // The diagram is still the one that was rendered, and it still renders and picks.
    assert.strictEqual(page.panel.current?.source, MERMAID["flowchart-v2"]);
    assert.strictEqual(page.panel.current?.error, undefined);
    await draw({ source: MERMAID.sequence });
    assert.deepStrictEqual([...(page.panel.drawnIds ?? [])].sort(), ["Alice", "Bob"]);

    // A chart's items are its data, which the panel does not name, so ids cannot be checked.
    const pie = '{"series": [{"type": "pie", "data": [1]}]}';
    await draw({ language: "echarts", source: pie });
    assert.strictEqual(page.panel.drawnIds, undefined);
    const chartMarks = page.panel.annotate({ marks: [{ id: "1", kind: "info" }], dim: true });
    assert.ok(chartMarks.ok);
    assert.deepStrictEqual(chartMarks.unknown, []);
  });

  test("finds icon and image shapes, architecture groups, sankey flows and the edges of block, agent flow, swimlane and use case diagrams", async () => {
    const pixel =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const cases: [string, string[]][] = [
      [
        `flowchart LR\n  A@{ icon: "fa:user", label: "User" } --> B@{ img: "${pixel}", label: "Photo" }`,
        ["A: User", "B: Photo", "edge:L_A_B_0: User → Photo"],
      ],
      [
        "architecture-beta\n  group api(cloud)[API]\n  group store(database)\n  service web(server)[Web] in api\n  service db(database)[DB] in store\n  junction j\n  web:R -[queries]-> L:db\n  db:B -- T:j",
        ["api: API", "db: DB", "edge:L_web_db_0: Web → DB: queries", "store: store", "web: Web"],
      ],
      [
        'C4Context\n  Person(u, "User")\n  System(s, "Shop")\n  System(m, "Mail")\n  Enterprise_Boundary(b, "Corp") {\n    System(d, "Data")\n  }\n  Rel(u, s, "Uses")\n  BiRel(s, m, "Sends")\n  Rel_Back(d, s, "Reads")\n  Rel(u, b, "Works at")',
        [
          "b: Corp",
          "d: Data",
          "edge:d → s: Shop → Data: Reads",
          "edge:s → m: Shop ↔ Mail: Sends",
          "edge:u → b: User → Corp: Works at",
          "edge:u → s: User → Shop: Uses",
          "m: Mail",
          "s: Shop",
          "u: User",
        ],
      ],
      [
        "sankey-beta\n  A,B,10\n  A,C,5",
        ["A: A", "B: B", "C: C", "edge:A → B: A → B: 10", "edge:A → C: A → C: 5"],
      ],
      [
        'block-beta\n  columns 3\n  a b c\n  a --> b\n  b -- "go" --> c\n  c --- a',
        ["a: a", "b: b", "c: c", "edge:1-a-b: a → b", "edge:1-b-c: b → c: go", "edge:1-c-a: c — a"],
      ],
      [
        "agentflow-beta\n  start --> plan\n  plan --> done",
        [
          "done: done",
          "edge:L_plan_done_0: plan → done",
          "edge:L_start_plan_0: start → plan",
          "plan: plan",
          "start: start",
        ],
      ],
      [
        "swimlane-beta LR\n  subgraph A\n    a1[Start]\n  end\n  subgraph B\n    b1[End]\n  end\n  a1 -->|x| b1",
        ["A: A", "B: B", "a1: Start", "b1: End", "edge:L_a1_b1_0: Start → End: x"],
      ],
      [
        'usecase-beta\n  actor Customer\n  Customer --> "Place order"\n  Pay <-- Bank',
        [
          "Bank: Bank",
          "Customer: Customer",
          "Pay: Pay",
          "Place_order: Place order",
          "edge:edge-0: Customer → Place order",
          "edge:edge-1: Bank → Pay",
        ],
      ],
    ];
    for (const [source, nodes] of cases) {
      await draw({ source });
      const found = await evaluate(`[...document.querySelectorAll("#diagram [role=button]")]
        .map(node => node.getAttribute("data-diagram-id") + ": " + node.getAttribute("aria-label")).sort()`);
      assert.deepStrictEqual(found, nodes, source);
    }
  });

  test("finds the items of treemaps, packets, radar charts, C4 boundaries, block groups and other diagrams that Mermaid draws without ids", async () => {
    const cases: [string, string[]][] = [
      [
        // Mermaid draws the larger section first, and cuts a long title short.
        'treemap-beta\n"Frontend services of the shop"\n  "Web": 6\n  "Other": 3\n"Backend"\n  "API": 30\n  "Other": 15\n  "Jobs"\n    "Mail": 1',
        [
          "Backend/API: API 30",
          "Backend/Jobs/Mail: Mail 1",
          "Backend/Jobs: Jobs 1",
          "Backend/Other: Other 15",
          "Backend: Backend 46",
          "Frontend services of the shop/Other: Other 3",
          "Frontend services of the shop/Web: Web 6",
          "Frontend services of the shop: Frontend serv... 9",
        ],
      ],
      [
        // The data goes on in the next row.
        'packet\n0-15: "Source Port"\n16-31: "Destination Port"\n32-39: "Reserved"\n40-47: "Reserved"\n48-79: "Data"',
        [
          "Data: <rect> Data 48 63 <rect> Data 64 79",
          "Destination Port: <rect> Destination Port 16 31",
          "Reserved (2): <rect> Reserved 40 47",
          "Reserved: <rect> Reserved 32 39",
          "Source Port: <rect> Source Port 0 15",
        ],
      ],
      [
        // Two fields of the same label, the second at the start of a row.
        'packet\n0-15: "A"\n16-31: "Reserved"\n32-47: "Reserved"\n48-63: "B"',
        [
          "A: <rect> A 0 15",
          "B: <rect> B 48 63",
          "Reserved (2): <rect> Reserved 32 47",
          "Reserved: <rect> Reserved 16 31",
        ],
      ],
      [
        'radar-beta\n  axis m["Math"], s["Science"]\n  axis e\n  curve a["Alice"]{85, 90, 80}\n  curve b{70, 75, 85}',
        ["a: <path> Alice", "b: <path> b", "e: e", "m: Math", "s: Science"],
      ],
      [
        'C4Context\n  Enterprise_Boundary(corp, "Corp") {\n    System_Boundary(core, "Core") {\n      System(s, "Shop")\n    }\n    System(d, "Data")\n  }\n  Boundary(ext, "External", "cloud") {\n    System(m, "Mail")\n  }',
        [
          "core: Core [SYSTEM]",
          "corp: Corp [ENTERPRISE]",
          "d: Data [Software System]",
          "ext: External [cloud]",
          "m: Mail [Software System]",
          "s: Shop [Software System]",
        ],
      ],
      [
        // Mermaid makes up an id for the second group.
        'block-beta\n  block:grp\n    c["C"] d\n  end\n  block\n    e\n  end',
        ["c: <g>", "d: <g>", "e: <g>", "grp: <g>"],
      ],
      [
        "ishikawa-beta\n  Blur\n    Camera\n      Out of focus\n      Training\n    User\n      Training",
        [
          "Blur: Blur",
          "Camera: Camera",
          "Out of focus: Out of focus",
          "Training (2): Training",
          "Training: Training",
          "User: User",
        ],
      ],
      [
        'railroad-ebnf-beta\n  expr = term , { "+" , term } ;\n  term = "x" ;',
        ["expr: term + term expr =", "term: x term ="],
      ],
      [
        "treeView-beta\n  src\n    index.ts\n    lib\n      index.ts\n  package.json",
        [
          "package.json: package.json",
          "src/index.ts: index.ts",
          "src/lib/index.ts: index.ts",
          "src/lib: lib",
          "src: src",
        ],
      ],
      [
        'venn-beta\n  set A["Design"]\n  set B["Code"]\n  set C\n  union B,A["UX"]\n    text t1["Alice"]\n  union B,C',
        ["A,B: UX", "A: Design", "B,C: <g>", "B: Code", "C: C", "t1: <foreignObject>"],
      ],
      [
        // Mermaid draws no link from a pipeline's component to the pipeline.
        "wardley-beta\n  anchor Business [0.95, 0.63]\n  component Cup of Tea [0.79, 0.61]\n  component Kettle [0.43, 0.35]\n  component Power [0.1, 0.7]\n  pipeline Kettle {\n    component Electric [0.6]\n  }\n  Business -> Cup of Tea\n  Cup of Tea -> Kettle; heats\n  Electric -> Kettle\n  Kettle +> Power",
        [
          "Business: Business",
          "Cup of Tea: Cup of Tea",
          "Kettle: Kettle",
          "Kettle_Electric: Electric",
          "Power: Power",
          "edge:Business → Cup of Tea: <line> <line>",
          "edge:Cup of Tea → Kettle: <line> <line> heats",
          "edge:Kettle → Power: <line> <line>",
        ],
      ],
      [
        'cynefin-beta\n  complex\n    "Discovery"\n    "Complex"\n  clear\n    "Payroll"\n  complex --> complicated : "Learn"\n  clear --> chaotic',
        [
          "Complex: Complex",
          "Discovery: Discovery",
          "Payroll: Payroll",
          "chaotic: <rect> Chaotic",
          "clear: <rect> Clear",
          "complex: <rect> Complex",
          "complicated: <rect> Complicated",
          "confusion: <path> Confusion",
          "edge:clear → chaotic: <path> <path>",
          "edge:complex → complicated: <path> <path> Learn",
        ],
      ],
    ];
    for (const [source, items] of cases) {
      await draw({ source });
      // Each item with what is drawn for it: texts, and the kinds of the other elements.
      const found = await evaluate(`(() => {
        const texts = new Map();
        for (const element of document.querySelectorAll("#diagram [data-diagram-id]")) {
          const id = element.getAttribute("data-diagram-id");
          const drawn = element.matches("text") ? [element] : [...element.querySelectorAll("text")];
          const shown = drawn.map(text => text.textContent.trim()).filter(Boolean);
          texts.set(id, [...(texts.get(id) ?? []), ...(shown.length ? shown : ["<" + element.tagName + ">"])]);
        }
        return [...texts].map(([id, drawn]) => id + ": " + drawn.join(" ")).sort();
      })()`);
      assert.deepStrictEqual(found, items, source);
    }
  });

  test("explains that the panel loads no images that a diagram links to", async () => {
    assert.strictEqual(
      await renderError(
        'flowchart LR\n  A@{ img: "data:image/png;base64,", label: "A" }\n  B@{ img: "https://example.com/b.png" }',
      ),
      "Cannot load the image https://example.com/b.png: the panel loads no images, so give it as a data: URL.",
    );
  });
});

suite("Mermaid sources from a model or an untrusted repository", function () {
  this.timeout(20_000);

  const page = suitePage();
  const { evaluate } = page;

  const script = "<img src=x onerror='window.pwned=1'>";
  const payloads: Record<string, string> = {
    "HTML labels": `flowchart LR\n  A["${script}"] --> B["<a href='javascript:window.pwned=2'>x</a>"]\n  C["<iframe srcdoc='<script>parent.pwned=3</script>'></iframe>"]`,
    "a link in a label": `flowchart LR\n  A["Docs <a href='https://example.com'>here</a>"]`,
    "click directives": `flowchart LR\n  A --> B --> C --> D\n  click A call alert(1)\n  click B href "javascript:window.pwned=4"\n  click C href "https://example.com/?secret" _blank\n  click D href "vscode://file/etc/passwd"`,
    "links in labels and actor menus": `sequenceDiagram\n  participant A as <a href='https://example.com'>A</a>\n  links A: {"Repo": "https://example.com"}\n  A->>B: <a href='mailto:x@example.com'>mail</a>`,
    "an init directive": `%%{init: {"securityLevel": "loose", "dompurifyConfig": {"ADD_ATTR": ["onerror"]}}}%%\nflowchart LR\n  A["${script}"] --> B\n  click B call alert(1)`,
    "front matter": `---\nconfig:\n  securityLevel: loose\n  dompurifyConfig:\n    ADD_ATTR: [onerror]\n---\nflowchart LR\n  A["${script}"] --> B`,
  };

  for (const [name, source] of Object.entries(payloads)) {
    test(`runs no script and opens no link from ${name}`, async () => {
      assert.ok((await page.panel.render({ language: "mermaid", source, title: name }, "tool")).ok);
      const found = await evaluate(`(() => {
        const elements = [...document.getElementById("diagram").querySelectorAll("*")];
        return {
          handlers: elements.flatMap(e => [...e.attributes].filter(a => /^on/i.test(a.name)).map(a => a.name)),
          frames: elements.filter(e => /^(script|iframe|object|embed)$/i.test(e.tagName)).length,
          links: elements.filter(e => e.localName === "a" && (e.hasAttribute("href") || e.hasAttributeNS("http://www.w3.org/1999/xlink", "href"))).length,
          pwned: window.pwned ?? null,
        };
      })()`);
      assert.deepStrictEqual(found, { handlers: [], frames: 0, links: 0, pwned: null });
    });
  }

  /**
   * Records the URLs that the panel opens for the action in the webview, instead of opening them.
   * The panel handles the page's messages in order, and opens a URL as it handles its message, so
   * it has opened them all by the time the page answers the action.
   */
  async function opening(action: () => Promise<unknown>): Promise<string[]> {
    const openExternal = vscode.env.openExternal;
    const opened: string[] = [];
    vscode.env.openExternal = async (uri) => {
      opened.push(uri.toString(true));
      return true;
    };
    try {
      await action();
      return opened;
    } finally {
      vscode.env.openExternal = openExternal;
    }
  }

  test("opens a node's link on a plain click or Enter, and selects or picks on other clicks", async () => {
    const source = `flowchart LR\n  A[Docs] --> B["Mail <a href='mailto:docs@example.com'>us</a>"] --> C\n  click A href "https://example.com/docs?page=2" "Read the docs" _blank`;
    assert.ok(
      (await page.panel.render({ language: "mermaid", source, title: "Links" }, "tool")).ok,
    );
    let shown: unknown;
    const opened = await opening(async () => {
      shown = await evaluate(`(() => {
        const node = id => document.querySelector('#diagram [data-diagram-id="' + id + '"][tabindex]');
        const click = (element, init) =>
          element.dispatchEvent(new MouseEvent("click", {bubbles: true, ...init}));
        const shown = {
          tooltips: ["A", "B", "C"].map(id => node(id).querySelector("title.diagram-link")?.textContent ?? null),
          hint: document.getElementById("selection-label").textContent,
        };
        click(node("A"), {shiftKey: true});
        click(node("B").querySelector("a"), {ctrlKey: true});
        shown.selected = [...document.querySelectorAll("#diagram .diagram-selected[tabindex]")]
          .map(element => element.getAttribute("data-diagram-id"));
        receive({type: "startPick", pickId: 90001, prompt: "Pick a node", multiple: false});
        click(node("A"));
        shown.picked = document.getElementById("pick").hidden;
        click(node("A"));
        node("A").dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
        click(node("B").querySelector("a"));
        click(node("B"));
        click(node("C"));
        return shown;
      })()`);
    });
    assert.deepStrictEqual(shown, {
      tooltips: ["Open https://example.com/docs?page=2", "Open mailto:docs@example.com", null],
      hint: "Click a linked node to open its link (Ctrl/Cmd/Shift+click to select nodes).",
      selected: ["A", "B"],
      picked: true,
    });
    assert.deepStrictEqual(opened, [
      "https://example.com/docs?page=2",
      "https://example.com/docs?page=2",
      "mailto:docs@example.com",
      "mailto:docs@example.com",
    ]);
  });

  test("opens a Gantt task's link through the extension, keeping the panel", async () => {
    const source =
      'gantt\n  dateFormat YYYY-MM-DD\n  Design :a1, 2026-01-01, 7d\n  click a1 href "https://example.com/plan"';
    assert.ok((await page.panel.render({ language: "mermaid", source, title: "Plan" }, "tool")).ok);
    const opened = await opening(() =>
      evaluate(`document.querySelector('#diagram [data-diagram-id="a1"][tabindex]')
          .dispatchEvent(new MouseEvent("click", {bubbles: true}))`),
    );
    assert.deepStrictEqual(opened, ["https://example.com/plan"]);
    // Mermaid would have taken the panel to the URL itself.
    assert.strictEqual(await evaluate(`document.getElementById("diagram").hidden`), false);
  });

  const actorLinks = `sequenceDiagram
  participant Alice
  participant Bob
  participant Carol
  link Alice: Dashboard @ https://example.com/dash
  links Bob: {"Wiki": "https://example.com/wiki", "Repo": "https://example.com/repo"}
  links Carol: {"Wiki": "https://example.com/wiki", "Repo": "https://example.com/repo", "Docs": "https://example.com/docs"}
  Alice->>Bob: hi`;

  test("opens an actor's link, or offers a menu of its links", async () => {
    assert.ok(
      (await page.panel.render({ language: "mermaid", source: actorLinks, title: "Seq" }, "tool"))
        .ok,
    );
    let shown: unknown;
    const opened = await opening(async () => {
      shown = await evaluate(`(() => {
        const node = id => document.querySelector('#diagram [data-diagram-id="' + id + '"][tabindex]');
        const click = (element, init) =>
          element.dispatchEvent(new MouseEvent("click", {bubbles: true, ...init}));
        const key = (element, key) =>
          element.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles: true}));
        const menu = () => document.querySelector("#canvas .link-menu");
        const focused = () =>
          document.activeElement.getAttribute("data-diagram-id") ?? document.activeElement.textContent;
        const shown = {
          tooltips: ["Alice", "Bob", "Carol"].map(id => node(id).querySelector("title.diagram-link")?.textContent),
          hint: document.getElementById("selection-label").textContent,
        };
        click(node("Alice"));
        click(node("Bob"), {ctrlKey: true});
        shown.selected = [...document.querySelectorAll("#diagram .diagram-selected[tabindex]")]
          .map(element => element.getAttribute("data-diagram-id"));
        shown.menuAfterSelecting = menu() !== null;
        node("Bob").focus();
        key(node("Bob"), "Enter");
        shown.menu = {
          role: menu().getAttribute("role"),
          label: menu().getAttribute("aria-label"),
          items: [...menu().children].map(item => [item.getAttribute("role"), item.textContent, item.title]),
          focused: focused(),
        };
        key(document.activeElement, "ArrowDown");
        shown.afterArrowDown = focused();
        key(document.activeElement, "ArrowDown");
        shown.afterWrapping = focused();
        key(document.activeElement, "End");
        document.activeElement.click();
        shown.afterChoosing = {menu: menu() !== null, focused: focused()};
        key(node("Bob"), "Enter");
        key(document.activeElement, "Escape");
        shown.afterEscape = {menu: menu() !== null, focused: focused()};
        // The footer copy of the actor, which takes no focus.
        click(document.querySelector('#diagram [data-diagram-id="Bob"]:not([tabindex])'));
        shown.footerMenu = menu() !== null;
        document.getElementById("canvas").focus();
        shown.afterFocusElsewhere = menu() !== null;
        return shown;
      })()`);
    });
    assert.deepStrictEqual(shown, {
      tooltips: [
        "Open Dashboard (https://example.com/dash)",
        "Open Wiki or Repo",
        // Without a serial comma, as other lists of words.
        "Open Wiki, Repo or Docs",
      ],
      hint: "Click a linked node to open its link (Ctrl/Cmd/Shift+click to select nodes).",
      selected: ["Bob"],
      menuAfterSelecting: false,
      menu: {
        role: "menu",
        label: "Links of Bob",
        items: [
          ["menuitem", "Wiki", "https://example.com/wiki"],
          ["menuitem", "Repo", "https://example.com/repo"],
        ],
        focused: "Wiki",
      },
      afterArrowDown: "Repo",
      afterWrapping: "Wiki",
      afterChoosing: { menu: false, focused: "Bob" },
      afterEscape: { menu: false, focused: "Bob" },
      footerMenu: true,
      afterFocusElsewhere: false,
    });
    assert.deepStrictEqual(opened, ["https://example.com/dash", "https://example.com/repo"]);
  });

  test("closes an actor's menu when the diagram is drawn again, keeping the focus on the actor", async () => {
    /** Opens Bob's menu, runs the code that draws the diagram again, and tells how it ends up. */
    const redraw = (redraw: string, restore = "") =>
      evaluate(`(async () => {
        const bob = document.querySelector('#diagram [data-diagram-id="Bob"][tabindex]');
        bob.focus();
        bob.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
        const opened = document.querySelector("#canvas .link-menu")?.contains(document.activeElement);
        ${RETHEME}
        ${redraw}
        await until(() => !bob.isConnected);
        const shown = {
          opened,
          redrawn: !bob.isConnected,
          menu: document.querySelector("#canvas .link-menu") !== null,
          focused: document.activeElement.getAttribute("data-diagram-id"),
        };
        ${restore}
        return shown;
      })()`);
    const render = () =>
      page.panel.render({ language: "mermaid", source: actorLinks, title: "Seq" }, "tool");
    assert.ok((await render()).ok);
    const shown = { opened: true, redrawn: true, menu: false, focused: "Bob" };
    assert.deepStrictEqual(
      await redraw(
        `const theme = await retheme("test-theme-link-menu");`,
        // The theme coming back redraws too, which the next render must not race.
        "await retheme(theme);",
      ),
      shown,
    );
    // The render arrives once the menu is open.
    const rendered = redraw("");
    assert.ok((await render()).ok);
    assert.deepStrictEqual(await rendered, shown);
  });

  test("opens the entries of actor menus that sequence.forceMenus shows", async () => {
    const source = `%%{init: {"sequence": {"forceMenus": true}}}%%\n${actorLinks}`;
    assert.ok((await page.panel.render({ language: "mermaid", source, title: "Seq" }, "tool")).ok);
    const opened = await opening(() =>
      evaluate(`(() => {
          const entry = document.querySelector('#diagram .actorPopupMenu a[data-href="https://example.com/wiki"] tspan');
          entry.dispatchEvent(new MouseEvent("click", {bubbles: true}));
        })()`),
    );
    assert.deepStrictEqual(opened, ["https://example.com/wiki"]);
  });

  const linkedImages = {
    "a flowchart":
      'flowchart LR\n  A[Docs] --> B\n  click A href "https://example.com/docs" "Docs"',
    "actor menus": `%%{init: {"sequence": {"forceMenus": true}}}%%\n${actorLinks}`,
  };
  for (const [name, source] of Object.entries(linkedImages)) {
    test(`leaves links out of images of ${name}`, async () => {
      assert.ok(
        (await page.panel.render({ language: "mermaid", source, title: "Links" }, "tool")).ok,
      );
      const svg = await evaluate(`(async () => {
        ${DRAG_IMAGE}
        return (await dragImage()).getData("image/svg+xml");
      })()`);
      assert.ok(typeof svg === "string" && /Docs|Wiki/.test(svg));
      assert.doesNotMatch(svg, /example\.com|href/);
    });
  }
});
