import * as assert from "node:assert";
import * as vscode from "vscode";
import { validateAnnotation } from "../annotations";
import type { Diagram } from "../panel";
import { recordMessages, replace } from "./afterTest";
import { DRAG_IMAGE, MERMAID, suitePage, UNTIL } from "./webviewHarness";

suite("images in the webview", function () {
  // The first render loads the webview and the libraries, which can take a while.
  this.timeout(20_000);

  const page = suitePage();
  const { evaluate, draw } = page;

  test("exports chart dimensions while its rendering is hidden in Source view", async () => {
    await draw({
      language: "echarts",
      source: '{"series": [{"type": "pie", "data": [1, 2]}]}',
    });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const chart = document.querySelector("#chart svg");
        const width = chart.width.baseVal.value;
        const height = chart.height.baseVal.value;
        document.getElementById("view-source").click();
        try {
          ${DRAG_IMAGE}
          const svg = await dragImage();
          const image = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
          return {
            hidden: chart.getBoundingClientRect().width === 0,
            sized: width > 0 && height > 0 && Number(image.getAttribute("width")) === width &&
              Number(image.getAttribute("height")) === height,
            viewBox: image.getAttribute("viewBox") === "0 0 " + width + " " + height
          };
        } finally {
          document.getElementById("view-visual").click();
        }
      })()`),
      { hidden: true, sized: true, viewBox: true },
    );
  });

  test("exports complete chart items while their entrance animations are pending", async () => {
    const option = {
      animation: true,
      animationDelay: 60_000,
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: {},
      series: [{ type: "bar", data: [10, 20], itemStyle: { color: "#123456" } }],
    };
    const paths: unknown[] = [];
    for (const animation of [true, false]) {
      await draw({ language: "echarts", source: JSON.stringify({ ...option, animation }) });
      paths.push(
        await evaluate(`(async () => {
          ${DRAG_IMAGE}
          const svg = await dragImage({shiftKey: true});
          const image = new DOMParser().parseFromString(svg, "image/svg+xml");
          // The bars are the filled paths: a bar under the system pointer, whose emphasis the export
          // ends at once, has its color written as rgb(18,52,86) instead.
          return [...image.querySelectorAll("path")]
            .filter(path => path.getAttribute("fill") !== "none")
            .map(path => path.getAttribute("d"));
        })()`),
      );
    }
    assert.ok(Array.isArray(paths[1]) && paths[1].length === 2);
    assert.deepStrictEqual(paths[0], paths[1]);
  });

  test("exports chart labels that are still fading in", async () => {
    await draw({
      language: "echarts",
      source: JSON.stringify({
        animationDuration: 60_000,
        series: [{ type: "pie", data: [{ name: "Fading label", value: 1 }] }],
      }),
    });
    const labels = await evaluate(`(async () => {
      ${DRAG_IMAGE}
      const svg = await dragImage({shiftKey: true});
      const image = new DOMParser().parseFromString(svg, "image/svg+xml");
      return [...image.querySelectorAll("text")].map(text =>
        text.textContent + " " + (text.getAttribute("fill-opacity") ?? text.getAttribute("opacity") ?? 1));
    })()`);
    assert.deepStrictEqual(labels, ["Fading label 1"]);
  });

  test("leaves out of chart images what the pointer shows on the chart", async () => {
    await draw({
      language: "echarts",
      source: JSON.stringify({
        animation: false,
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        xAxis: { type: "category", data: ["A", "B"] },
        yAxis: {},
        series: [
          {
            type: "bar",
            data: [10, 20],
            itemStyle: { color: "#0000ff" },
            emphasis: { itemStyle: { color: "#ff0000" } },
          },
        ],
      }),
    });
    page.panel.annotate(validateAnnotation({ marks: [{ id: "A" }] }));
    const images = await evaluate(`(async () => {
      ${DRAG_IMAGE}
      ${UNTIL}
      // What is drawn, without the ids that ECharts numbers anew in each drawing.
      const image = async () => (await dragImage({shiftKey: true}))
        .replace(/ (id|clip-path)="[^"]*"/g, "");
      const red = () => document.querySelectorAll('#chart svg path[fill="#ff0000"]').length;
      const marked = await until(() => red() === 1, "the marked item");
      const before = await image();
      // As when exporting from the context menu by keyboard, with the pointer left on the chart.
      const bar = document.querySelectorAll('#chart svg path[fill="#0000ff"]')[0];
      const box = bar.getBoundingClientRect();
      bar.dispatchEvent(new MouseEvent("mousemove", {bubbles: true,
        clientX: box.x + box.width / 2, clientY: box.y + box.height / 2}));
      const hovered = await until(() => red() === 2, "the hovered item");
      return {marked, hovered, same: (await image()) === before};
    })()`);
    assert.deepStrictEqual(images, { marked: true, hovered: true, same: true });
  });

  test("leaves the toolbox out of chart images, but not out of the panel", async () => {
    const chart = {
      animation: false,
      xAxis: { type: "category", data: ["A", "B"] },
      yAxis: {},
      series: [{ type: "bar", data: [1, 2] }],
    };
    const drawn = [];
    for (const toolbox of [undefined, { feature: { saveAsImage: {}, restore: {} } }]) {
      await draw({ language: "echarts", source: JSON.stringify({ ...chart, toolbox }) });
      drawn.push(
        await evaluate(`(async () => {
          ${DRAG_IMAGE}
          const svg = await dragImage({shiftKey: true});
          const image = new DOMParser().parseFromString(svg, "image/svg+xml");
          await new Promise(requestAnimationFrame);
          return {
            image: image.querySelectorAll("path").length,
            panel: document.querySelectorAll("#chart svg path").length,
          };
        })()`),
      );
    }
    const [plain, withToolbox] = drawn as { image: number; panel: number }[];
    assert.strictEqual(withToolbox?.image, plain?.image);
    assert.ok((withToolbox?.panel ?? 0) > (plain?.panel ?? 0));
  });

  test("exports the current chart size before the resize observer runs", async () => {
    await draw({
      language: "echarts",
      source: '{"series": [{"type": "pie", "data": [1, 2]}]}',
    });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        const chart = document.getElementById("chart");
        try {
          chart.style.width = "321px";
          chart.style.height = "234px";
          const expected = [chart.clientWidth, chart.clientHeight];
          ${DRAG_IMAGE}
          const svg = await dragImage({shiftKey: true});
          const image = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
          return {expected, actual: [Number(image.getAttribute("width")), Number(image.getAttribute("height"))]};
        } finally {
          chart.style.width = "";
          chart.style.height = "";
        }
      })()`),
      { expected: [321, 234], actual: [321, 234] },
    );
  });

  const svgDrags = {
    "the browser cannot create a PNG": [
      "null",
      "Dragging the drawing as SVG, as the PNG failed: The browser could not create a PNG at this image size.",
    ],
    // Chromium does not download a file to drop from a data URL of over 2 MB.
    "the PNG is too large to drop": [
      'new Blob([new Uint8Array(1_600_000)], {type: "image/png"})',
      "The PNG is too large to drop as a file. Dragging the drawing as SVG instead.",
    ],
  };
  for (const [name, [blob, hint]] of Object.entries(svgDrags)) {
    test(`drags SVG and says why when ${name}`, async () => {
      await draw({
        language: "echarts",
        source: '{"series": [{"type": "pie", "data": [1, 2]}]}',
        // Which names the file after what it is.
        title: "",
      });
      const download = (await evaluate(`(async () => {
        const original = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = (callback) => callback(${blob});
        const label = document.getElementById("selection-label");
        try {
          ${DRAG_IMAGE}
          ${UNTIL}
          // Without Shift, which an earlier drag may have held, to ask for a PNG.
          await dragImage({shiftKey: false});
          let dataTransfer;
          await until(() => {
            dataTransfer = new DataTransfer();
            document.getElementById("drag-out")
              .dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
            return label.textContent === ${JSON.stringify(hint)};
          }, "the hint");
          return {url: dataTransfer.getData("DownloadURL"), hint: label.textContent};
        } finally {
          HTMLCanvasElement.prototype.toBlob = original;
        }
      })()`)) as { url: string; hint: string };
      assert.match(download.url, /^image\/svg\+xml:chart\.svg:data:image\/svg\+xml/);
      assert.strictEqual(download.hint, hint);
    });
  }

  test("advises exporting SVG when a PNG fails, but not a model that views the drawing", async () => {
    await draw({
      language: "echarts",
      title: "Chart",
      source: '{"series": [{"type": "pie", "data": [1]}]}',
    });
    const errors = recordMessages("showErrorMessage");
    replace(vscode.window, "showQuickPick", (async (items: { format: string }[]) =>
      items.find(
        (item) => item.format === "png",
      )) as unknown as typeof vscode.window.showQuickPick);
    await evaluate(`(() => {
      window.originalToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = (callback) => callback(null);
    })()`);
    try {
      await page.panel.exportDiagram();
      const viewed = await page.panel.captureImage({ maxSide: 1024, maxPixels: 1_000_000 });
      const failure = "The browser could not create a PNG at this image size.";
      assert.deepStrictEqual(
        [...errors, viewed],
        [`Could not export the chart: ${failure} Try exporting as SVG.`, failure],
      );
    } finally {
      await evaluate("void (HTMLCanvasElement.prototype.toBlob = window.originalToBlob)");
    }
  });

  test("keeps SVG export and rendering available while PNG decoding stalls", async () => {
    await draw({
      language: "echarts",
      source:
        '{"animation": false, "series": [{"type": "pie", "data": [{"name": "Original", "value": 1}]}]}',
    });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
      const original = HTMLImageElement.prototype.decode;
      let release;
      let decoding = false;
      const pending = new Promise(resolve => { release = resolve; });
      HTMLImageElement.prototype.decode = function () {
        decoding = true;
        return pending.then(() => original.call(this));
      };
      const handle = document.getElementById("drag-out");
      ${UNTIL}
      try {
        handle.dispatchEvent(new PointerEvent("pointerenter"));
        await until(() => decoding, "the image decoding");
        const dataTransfer = new DataTransfer();
        handle.dispatchEvent(new DragEvent("dragstart", {dataTransfer, cancelable: true}));
        const svgAvailable = dataTransfer.getData("image/svg+xml").includes("Original");
        receive({
          type: "render", language: "echarts", requestId: -1, title: "Incoming",
          source: JSON.stringify({animation: false, series: [{type: "pie", data: [{name: "Incoming", value: 1}]}]})
        });
        const rendered = await until(() =>
          document.querySelector("#chart svg")?.textContent.includes("Incoming"), "the incoming chart");
        return {svgAvailable, rendered};
      } finally {
        HTMLImageElement.prototype.decode = original;
        release();
      }
    })()`),
      { svgAvailable: true, rendered: true },
    );
  });

  test("exports Mermaid images that draw the same without their style sheets", async () => {
    const sources = [
      ...Object.values(MERMAID),
      // Classes, styles of nodes and edges, and an animated edge, which keeps its keyframes.
      `flowchart LR
        A e1@--> B --> C
        e1@{ animate: true }
        classDef hot fill:#f96,stroke:#333,stroke-width:4px
        class B hot
        style C fill:#bbf,stroke-dasharray: 5 5
        linkStyle 1 stroke:#ff3`,
      // Hollow arrowheads, which Mermaid fills in a transparent color.
      "classDiagram\n  Animal o-- Leg\n  Animal <|-- Duck",
    ];
    for (const source of sources) {
      await draw({ source });
      const drawn = (await evaluate(`(async () => {
        ${DRAG_IMAGE}
        const svg = await dragImage({shiftKey: true});
        const pixels = async (markup) => {
          const image = new Image();
          image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const styled = await pixels(svg);
        const unstyled = await pixels(svg.replace(/<style[^]*?<\\/style>/g, ""));
        return {
          same: styled.every((value, index) => value === unstyled[index]),
          // Such as a quoted url(), in a style attribute or sheet, or a transparent color, which
          // not every application reads.
          portable: !/url\\((?:&quot;|")|rgba\\(/.test(svg),
          // A style sheet is left only for the keyframes of an animation.
          keyframes: /<style>@keyframes/.test(svg) === svg.includes("animation-name"),
        };
      })()`)) as { same: boolean; portable: boolean; keyframes: boolean };
      assert.deepStrictEqual(drawn, { same: true, portable: true, keyframes: true }, source);
    }
  });

  test("exports Mermaid labels as SVG text despite diagram configuration", async () => {
    const exported = async (source: string) => {
      await draw({ source });
      return evaluate(`(async () => {
        ${DRAG_IMAGE}
        const svg = await dragImage();
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        return {
          htmlLabels: parsed.querySelectorAll("foreignObject").length,
          text: Array.from(parsed.querySelectorAll("text"), node => node.textContent).join("").replace(/\\s/g, "")
        };
      })()`);
    };
    assert.deepStrictEqual(
      await exported(
        "---\nconfig:\n  htmlLabels: true\n---\nflowchart LR\n A[Exported label] --> B[Other label]",
      ),
      { htmlLabels: 0, text: "ExportedlabelOtherlabel" },
    );
    assert.deepStrictEqual(
      await exported(
        "---\nconfig:\n  flowchart:\n    htmlLabels: true\n---\nswimlane-beta LR\n  subgraph Lane\n    a[Start]\n  end",
      ),
      { htmlLabels: 0, text: "LaneStart" },
    );
    // User journeys draw task names as HTML with a text fallback.
    const journey = (await exported("journey\n  section Work\n    Brew tea: 5: Me")) as {
      htmlLabels: number;
      text: string;
    };
    assert.strictEqual(journey.htmlLabels, 0);
    assert.match(journey.text, /Brewtea/);
  });

  test("exports the HTML labels that Mermaid draws anyway as SVG text, where they show", async () => {
    const cases: [string, string[]][] = [
      // Event models and the texts of Venn diagrams are HTML whatever Mermaid is told: a bold
      // name that does not wrap, data, and a text that does.
      [
        "eventmodeling\n  tf 01 cmd AddItemToTheCartWithAVeryLongName\n  tf 02 evt ItemAdded { id: 1, name: thing }",
        // Mermaid writes the spaces of data as &nbsp;.
        ["AddItemToTheCartWithAVeryLongName", "ItemAdded", "id: 1, name: thing"],
      ],
      [
        'venn-beta\n  set A\n  set B\n  union A,B["AB"]\n    text t1["Alice and her friends"]',
        ["Alice and her", "friends"],
      ],
      // A diagram with a formula keeps its HTML labels, such as a lane title that it turns.
      ['swimlane-beta LR\n  subgraph Lane one\n    a["$$x^2$$"]\n  end', ["Lane one"]],
    ];
    for (const [source, lines] of cases) {
      await draw({ source });
      const exported = await evaluate(`(async () => {
        ${DRAG_IMAGE}
        const host = document.createElement("div");
        host.innerHTML = await dragImage();
        document.body.append(host);
        /** The edges of the boxes in the drawing's units. */
        const edges = (svg, rects) => rects.flatMap(rect => {
          const outer = svg.getBoundingClientRect();
          const { x, y, width, height } = svg.viewBox.baseVal;
          return [rect.left, rect.top, rect.right, rect.bottom].map((at, i) => i % 2
            ? y + (at - outer.top) * height / outer.height
            : x + (at - outer.left) * width / outer.width);
        });
        const image = host.querySelector("svg");
        const panel = document.querySelector("#diagram svg");
        // The lines of the labels in the panel, and the texts in groups of their own in the image.
        const range = document.createRange();
        const shown = [];
        for (const label of panel.querySelectorAll("foreignObject:not(:has(math))")) {
          const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            range.selectNodeContents(walker.currentNode);
            shown.push(...range.getClientRects());
          }
        }
        const texts = [...image.querySelectorAll("g:not([class]) > text")];
        const imageEdges = edges(image, texts.map(text => text.getBoundingClientRect()));
        const panelEdges = edges(panel, shown);
        const result = {
          htmlLabels: image.querySelectorAll("foreignObject:not(:has(math))").length,
          lines: texts.map(text => text.textContent),
          // Within half a unit, rather than rounded: edges on half units, as those of 19px lines
          // are, round apart for the smallest difference in how the two are laid out.
          moved: imageEdges.length !== panelEdges.length ||
            imageEdges.some((at, i) => Math.abs(at - panelEdges[i]) >= 0.5),
        };
        host.remove();
        return result;
      })()`);
      assert.deepStrictEqual(exported, { htmlLabels: 0, lines, moved: false }, source);
    }
  });

  test("exports text fallbacks of Mermaid labels in the colors of their labels", async () => {
    await draw({ source: "journey\n  section Work\n    Brew tea: 5: Me" });
    const colors = await evaluate(`(async () => {
      const shown = document.querySelector("#diagram switch .label");
      ${DRAG_IMAGE}
      const host = document.createElement("div");
      host.innerHTML = await dragImage();
      document.body.append(host);
      try {
        const text = Array.from(host.querySelectorAll("switch > text"))
          .find(text => text.textContent === shown.textContent);
        return {
          label: getComputedStyle(shown).color,
          text: getComputedStyle(text).fill,
          box: getComputedStyle(text.closest("g").querySelector("rect")).fill,
        };
      } finally {
        host.remove();
      }
    })()`);
    const { label, text, box } = colors as Record<string, string>;
    assert.strictEqual(text, label);
    assert.notStrictEqual(text, box);
  });

  test("centers Mermaid labels that Mermaid leaves to CSS, in images and in the panel", async () => {
    // Mermaid starts these labels at the middle of the node, or at the left of a state's least
    // width, for CSS that only flowcharts have.
    for (const source of [
      "mindmap\n  root((Central idea with long text))\n    sq[Square node text]\n    hx{{Hexagon node text}}\n    Default node text",
      'usecase-beta\n  actor Customer\n  Customer --> "Place an order with a long name"',
      "flowchart LR\n  A((Circle label)) --> B[Rectangle label]",
      'stateDiagram-v2\n  [*] --> Idle\n  state "A state with a long name" as Long\n  Idle --> Long',
    ]) {
      await draw({ source });
      const offCenter = await evaluate(`(async () => {
        ${DRAG_IMAGE}
        const host = document.createElement("div");
        host.innerHTML = await dragImage();
        document.body.append(host);
        const center = (box) => (box.left + box.right) / 2;
        const problems = Array.from(host.querySelectorAll("g.node:has(text)"), node => {
          const text = node.querySelector("text").getBoundingClientRect();
          const shape = node.querySelector(":scope > :is(circle, ellipse, path, polygon, rect)").getBoundingClientRect();
          // Mermaid itself places some labels, like those under use case actors, a few pixels off.
          return Math.abs(center(text) - center(shape)) > 8 ? node.textContent : undefined;
        }).filter(Boolean);
        host.remove();
        return problems;
      })()`);
      assert.deepStrictEqual(offCenter, [], source);
    }
    // The panel too, for a diagram that asks for SVG labels.
    await draw({
      source:
        "---\nconfig:\n  htmlLabels: false\n---\nmindmap\n  root((Central idea with long text))",
    });
    const offset = await evaluate(`(() => {
      const node = document.querySelector("#diagram g.node:has(text)");
      const [text, shape] = [node.querySelector("text"), node.querySelector("circle")].map(e => e.getBoundingClientRect());
      return Math.round(Math.abs(text.left + text.right - shape.left - shape.right) / 2);
    })()`);
    assert.ok((offset as number) <= 8, `${offset}`);
  });

  test("exports well-formed XML whatever the labels hold", async () => {
    const drawings: [Partial<Diagram>, string][] = [
      // HTML labels, which formulas keep, with a line break and a no-break space.
      ['flowchart LR\n  A["$$x^2$$"] --> B["one<br>two&nbsp;three"]', "two three"],
      ["sequenceDiagram\n  A->>B: $$x^2$$\n  B->>A: one<br/>two three", "two three"],
      // Control characters, which XML does not allow even as references.
      ['flowchart LR\n  A["one\u0001two"] --> B', "onetwo"],
    ].map(([source, text]) => [{ source }, text] as [Partial<Diagram>, string]);
    drawings.push([
      {
        language: "echarts",
        source: '{"series": [{"type": "pie", "data": [{"name": "one\\u0001two", "value": 1}]}]}',
      },
      "onetwo",
    ]);
    for (const [drawing, text] of drawings) {
      await draw(drawing);
      const image = await evaluate(`(async () => {
        ${DRAG_IMAGE}
        const svg = await dragImage({shiftKey: true});
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        return {
          error: parsed.querySelector("parsererror")?.textContent ?? null,
          text: parsed.documentElement.textContent.includes(${JSON.stringify(text)}),
        };
      })()`);
      assert.deepStrictEqual(image, { error: null, text: true }, drawing.source ?? "");
    }
  });

  test("exports the text of HTML in Mermaid labels, without its tags", async () => {
    const source = [
      "flowchart LR",
      '  A["<b>Bold</b> and <i>italic</i>"] -->|"<u>edge</u>"| B["<a href=\'https://example.com\'>Link</a>"]',
      '  B --> C["First<br>second"]',
      "  C --> D[\"1 &lt; 2 <span style='color: red'>red</span>\"]",
    ].join("\n");
    await draw({ source });
    const exported = await evaluate(`(async () => {
      ${DRAG_IMAGE}
      const image = await dragImage();
      const parsed = new DOMParser().parseFromString(image, "image/svg+xml");
      return Array.from(parsed.querySelectorAll("text"), text =>
        Array.from(text.querySelectorAll(".text-outer-tspan"), line => line.textContent.replace(/\\s+/g, " ").trim()).join("|"));
    })()`);
    assert.deepStrictEqual(exported, [
      "edge",
      "Bold and italic",
      "Link",
      "First|second",
      "1 < 2 red",
    ]);
  });

  test("shows formulas whole, beyond the boxes Mermaid sizes to their line boxes", async () => {
    // Italic letters and limits draw beyond those boxes, which would clip them.
    await draw({ source: "sequenceDiagram\n  A->>B: $$\\sum_{i=1}^{n} x_i$$" });
    const overflow = await evaluate(`(async () => {
      const shown = getComputedStyle(document.querySelector("#diagram foreignObject")).overflow;
      ${DRAG_IMAGE}
      const host = document.createElement("div");
      host.innerHTML = await dragImage();
      document.body.append(host);
      const exported = Array.from(host.querySelectorAll("foreignObject"), box => getComputedStyle(box).overflow);
      host.remove();
      return {shown, exported};
    })()`);
    assert.deepStrictEqual(overflow, { shown: "visible", exported: ["visible"] });
  });

  test("draws formulas as in the panel, also in images and in participant boxes", async () => {
    const sources = [
      'flowchart LR\n  A["$$x^2$$"] -->|"$$\\alpha$$"| B[Plain]',
      "stateDiagram-v2\n  s1 : $$\\sqrt{x}$$\n  s1 --> s2 : $$\\beta$$",
      'classDiagram\n  class C["$$\\gamma$$"]\n  C <|-- D : $$\\delta$$',
      // Mermaid leaves the labels of both boxes of the participant empty.
      "sequenceDiagram\n  participant A as $$\\alpha_1$$\n  A->>B: $$\\int x$$",
    ];
    for (const source of sources) {
      await draw({ source });
      const formulas = await evaluate(`(async () => {
        const formulas = root => Array.from(root.querySelectorAll("math"), math => math.textContent).sort();
        const shown = formulas(document.querySelector("#diagram svg"));
        ${DRAG_IMAGE}
        const image = await dragImage();
        const parsed = new DOMParser().parseFromString(image, "image/svg+xml");
        // A formula's text fallback in a switch is its TeX.
        const tex = Array.from(parsed.querySelectorAll("text"))
          .some(text => !text.closest("switch") && text.textContent.includes("$$"));
        return {shown, exported: formulas(parsed), tex};
      })()`);
      const expected = (
        {
          "flowchart LR": ["x2", "α"],
          "stateDiagram-v2": ["β", "x"],
          classDiagram: ["δ", "γ"],
          sequenceDiagram: ["α1", "α1", "∫x"],
        }[source.split("\n")[0] as string] as string[]
      ).sort();
      assert.deepStrictEqual(formulas, { shown: expected, exported: expected, tex: false }, source);
    }
  });

  test("gives each Mermaid image its own ids, which its styles and arrowheads go by", async () => {
    const ids: { id: string; scoped: boolean }[] = [];
    // Drawn again, as the same diagram in another session would be, which keeps no image from
    // this one: written apart from the first, which this session would take the image of again.
    for (const source of ["flowchart LR\n A --> B", "flowchart LR\n  A --> B"]) {
      await draw({ source });
      const svg = (await evaluate(`(async () => {
        ${DRAG_IMAGE}
        return await dragImage();
      })()`)) as string;
      const id = /<svg[^>]* id="([^"]+)"/.exec(svg)?.[1] ?? "";
      const references = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1] ?? "");
      ids.push({
        id,
        scoped: references.length > 0 && references.every((name) => name.startsWith(id)),
      });
    }
    assert.deepStrictEqual(
      ids.map(({ scoped }) => scoped),
      [true, true],
    );
    assert.notStrictEqual(ids[0]?.id, ids[1]?.id);
  });

  /** Drags the image out of the panel, saying how many images of the drawing it took for it. */
  const drag = () =>
    evaluate(`(async () => {
      const original = XMLSerializer.prototype.serializeToString;
      let drawn = 0;
      XMLSerializer.prototype.serializeToString = function (node) {
        if (node.localName === "svg") drawn++;
        return original.call(this, node);
      };
      try {
        ${DRAG_IMAGE}
        const svg = await dragImage();
        return {drawn, svg};
      } finally {
        XMLSerializer.prototype.serializeToString = original;
      }
    })()`) as Promise<{ drawn: number; svg: string }>;

  test("keeps a prepared Mermaid image across hovers, but takes a chart's again", async () => {
    const images = [];
    for (const diagram of [
      { source: "flowchart LR\n A[Kept] --> B" },
      { language: "echarts" as const, source: '{"series": [{"type": "pie", "data": [1, 2]}]}' },
    ]) {
      await draw(diagram);
      images.push((await drag()).drawn + (await drag()).drawn);
    }
    assert.deepStrictEqual(images, [1, 2]);
  });

  test("takes the image of a Mermaid diagram again while the diagram and theme stay", async () => {
    // A large diagram takes seconds to draw, and the panel draws an image of it anew.
    const source = "flowchart LR\n A[Again] --> B";
    await draw({ source });
    const first = await drag();
    // Rendering the diagram again forgets the image prepared for a drag.
    await draw({ source });
    const again = await drag();
    await draw({ source: `${source}\n B --> C` });
    const changed = await drag();
    assert.deepStrictEqual(
      [first.drawn, again.drawn, changed.drawn, again.svg === first.svg, changed.svg === first.svg],
      [1, 0, 1, true, false],
    );
  });

  /** The limits of an image for a model, as diagram_getImage asks for them. */
  const MODEL_LIMITS = { maxSide: 1568, maxPixels: 1_150_000 };

  /**
   * Webview code defining `decoded(png)`: the pixels of the PNG, given as base64, by `pixel(x, y)`,
   * an [r, g, b] array, and its size.
   */
  const DECODE = `
    const decoded = async (png) => {
      const image = new Image();
      image.src = "data:image/png;base64," + png;
      await image.decode();
      const canvas = document.createElement("canvas");
      [canvas.width, canvas.height] = [image.width, image.height];
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const pixel = (x, y) => [...data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
      return { pixel, width: image.width, height: image.height };
    };`;

  test("shows a model the part of a Mermaid diagram around items, its labels where the panel shows them", async () => {
    await draw({
      source:
        "flowchart LR\n  A[Parser of input] --> B[A checker of types] --> C[Writer of output]",
    });
    const shown = (await evaluate(`(() => {
      const svg = document.querySelector("#diagram svg");
      const { width, height } = svg.viewBox.baseVal;
      const zoom = Number(svg.getAttribute("width")) / width;
      const box = svg.querySelector('[data-diagram-id="B"]').getBoundingClientRect();
      return { width, height, zoom, node: [box.width / zoom, box.height / zoom] };
    })()`)) as { width: number; height: number; zoom: number; node: [number, number] };
    const view = async () => {
      const image = await page.panel.captureImage(MODEL_LIMITS, ["B", "nope"]);
      if (typeof image === "string") assert.fail(image);
      assert.ok(image.view);
      const { area, panel, ...rest } = image.view;
      return {
        png: Buffer.from(image.png).toString("base64"),
        view: {
          ...rest,
          area: area && [area.width, area.height].map(Math.round),
          zoom: panel?.zoom,
        },
      };
    };
    // B with a margin, as far as the drawing goes, at 100%, which shows its 16 px text legibly.
    const expected = {
      width: shown.width,
      height: shown.height,
      area: [shown.node[0] + 80, Math.min(shown.node[1] + 80, shown.height)].map(Math.round),
      textSize: 16,
      scale: 1,
      missing: ["nope"],
    };
    const visual = await view();
    assert.deepStrictEqual(visual.view, { ...expected, zoom: shown.zoom });
    // B's text is centered in it, as in the panel, rather than as the style sheet of the drawing
    // centers SVG text.
    const text = await evaluate(`(async () => {
      ${DECODE}
      const { pixel, width, height } = await decoded(${JSON.stringify(visual.png)});
      // B's fill, just inside its left edge, 40 pixels into the image, and the columns inside it
      // that its text is in, on its lines, between its top and bottom edges.
      const top = Math.ceil((height - ${shown.node[1]}) / 2) + 4;
      const bottom = Math.floor((height + ${shown.node[1]}) / 2) - 4;
      const fill = pixel(44, top);
      const columns = [];
      for (let x = 44; x < width - 44; x++) {
        for (let y = top; y <= bottom; y++) {
          const differs = pixel(x, y).reduce((sum, value, i) => sum + Math.abs(value - fill[i]), 0) > 100;
          if (differs) { columns.push(x); break; }
        }
      }
      return { width, height, center: (columns[0] + columns.at(-1)) / 2 };
    })()`);
    const [width = 0, height = 0] = expected.area;
    assert.deepStrictEqual(
      { ...(text as { width: number; height: number; center: number }), center: undefined },
      { width, height, center: undefined },
    );
    assert.ok(Math.abs((text as { center: number }).center - width / 2) <= 3, JSON.stringify(text));
    // The Source view hides the drawing, but not from the model: only the panel shows none of it.
    await evaluate(`document.getElementById("view-source").click()`);
    try {
      const source = await view();
      assert.deepStrictEqual(source, { png: visual.png, view: { ...expected, zoom: undefined } });
    } finally {
      await evaluate(`document.getElementById("view-visual").click()`);
    }
  });

  test("shows a model the labels of Mermaid edges on their backgrounds, as the panel does", async () => {
    await draw({
      source: [
        '%%{init: {"themeVariables": {"edgeLabelBackground": "#ff0000"}}}%%',
        "flowchart LR",
        "  A[Parser] -->|feeds the checker| B[Checker]",
      ].join("\n"),
    });
    const image = await page.panel.captureImage(MODEL_LIMITS, ["edge:L_A_B_0"]);
    if (typeof image === "string") assert.fail(image);
    // How many pixels of the middle of the label, just inside its top edge above its text, are of
    // its background, as red as the page reads the image.
    const label = await evaluate(`(async () => {
      ${DECODE}
      const { pixel, width, height } = await decoded(${JSON.stringify(Buffer.from(image.png).toString("base64"))});
      const differs = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) > 30;
      const background = pixel(0, 0);
      // The edge starts 40 pixels into the image, as its line goes through the middle of the label.
      const line = Array.from({length: height}, (_, y) => y).find((y) => differs(pixel(50, y), background));
      // The label is 24 pixels high, as its text is 16 pixels high on lines of 1.5 times that.
      return Array.from({length: 40}, (_, i) => pixel(Math.round(width / 2) - 20 + i, line - 11))
        .filter(([r, g, b]) => r > 150 && g < 60 && b < 60).length;
    })()`);
    assert.strictEqual(label, 40);
  });

  test("shows a model a chart without its marks and selection, which the panel goes on showing", async () => {
    const colors = ["#0000ff", "#00ff00", "#ff0000"];
    await draw({
      language: "echarts",
      source: JSON.stringify({
        animation: false,
        xAxis: { type: "category", data: ["Alpha category", "Beta category", "Gamma category"] },
        yAxis: {},
        series: [
          {
            type: "bar",
            data: colors.map((color, index) => ({ value: 10 + index, itemStyle: { color } })),
          },
        ],
      }),
    });
    /**
     * Whether each bar is faded, and whether Beta's is outlined, as ECharts shows it selected. The
     * states change how ECharts writes the fills of the bars: they go by their color as drawn.
     */
    const shown = `(() => {
      const paths = [...document.querySelectorAll("#chart svg path")];
      const bars = ["rgb(0, 0, 255)", "rgb(0, 255, 0)", "rgb(255, 0, 0)"].map((color) =>
        paths.find((path) => getComputedStyle(path).fill === color));
      return [
        ...bars.map((bar) => Number(bar?.getAttribute("fill-opacity") ?? bar?.getAttribute("opacity") ?? 1) < 1),
        Boolean(bars[1]?.getAttribute("stroke")),
      ].join();
    })()`;
    const plain = await page.panel.captureImage(MODEL_LIMITS);
    if (typeof plain === "string") assert.fail(plain);
    // Selects Beta's bar, and leaves the chart, where the pointer would emphasize it. ZRender takes
    // a click only after a press and a release on the same item.
    await evaluate(`(async () => {
      const path = document.querySelector('#chart svg path[fill="#00ff00"]');
      const bar = path.getBoundingClientRect();
      for (const type of ["mousedown", "mouseup", "click"]) {
        path.dispatchEvent(new MouseEvent(type, {
          bubbles: true, clientX: bar.x + bar.width / 2, clientY: bar.y + bar.height / 2
        }));
      }
      const svg = document.querySelector("#chart svg");
      const corner = svg.getBoundingClientRect();
      svg.dispatchEvent(new MouseEvent("mousemove", {bubbles: true, clientX: corner.x + 2, clientY: corner.y + 2}));
      ${UNTIL}
      await until(() => ${shown}.endsWith(",true"), "the selected bar outlined");
    })()`);
    page.panel.annotate({ marks: [{ id: "Gamma category", kind: "info" }], dim: true });
    // Alpha faded around the mark, and Beta outlined, whether ECharts fades it or not, which
    // depends on whether it took the pointer's emphasis.
    const marks = /^true,(true|false),false,true$/;
    await evaluate(`(async () => {
      ${UNTIL}
      await until(() => ${marks}.test(${shown}), "the chart dimmed around its mark");
    })()`);
    const marked = await page.panel.captureImage(MODEL_LIMITS);
    if (typeof marked === "string") assert.fail(marked);
    // The same image as of the chart before, while the panel shows them again at once.
    assert.ok(Buffer.from(marked.png).equals(Buffer.from(plain.png)));
    assert.match(String(await evaluate(shown)), marks);
    // Around Beta's bar, with its label on the axis, which lies outside its box.
    const part = await page.panel.captureImage(MODEL_LIMITS, ["Beta category"]);
    if (typeof part === "string") assert.fail(part);
    const reach = (await evaluate(`(() => {
      const bar = document.querySelector('#chart svg path[fill="#00ff00"]').getBoundingClientRect();
      const label = [...document.querySelectorAll("#chart svg text")]
        .find((text) => text.textContent === "Beta category").getBoundingClientRect();
      return [Math.max(bar.width, label.width), label.bottom - bar.top];
    })()`)) as [number, number];
    const area = part.view?.area;
    assert.ok(
      area && area.width >= reach[0] && area.height >= reach[1] + 40,
      JSON.stringify({ area, reach }),
    );
  });

  test("keeps Mermaid image export separate from an incoming render", async () => {
    await draw({ source: "flowchart LR\n A[Original label] --> B" });
    assert.deepStrictEqual(
      await evaluate(`(async () => {
        let exported;
        // The image is drawn where Mermaid lays out its drawings.
        const observer = new MutationObserver(records => {
          for (const svg of records.flatMap(record => [...record.addedNodes])) {
            if (svg.id?.startsWith("diagram-image-")) {
              exported = {
                htmlLabels: svg.querySelectorAll("foreignObject").length,
                originalLabel: svg.textContent.includes("Original label")
              };
            }
          }
        });
        observer.observe(document.body, {childList: true, subtree: true});
        try {
          document.getElementById("drag-out").dispatchEvent(new PointerEvent("pointerenter"));
          receive({
            type: "render", language: "mermaid", requestId: -1,
            source: "flowchart LR\\n C[Incoming label] --> D", title: "Incoming"
          });
          ${UNTIL}
          await until(() => exported && document.querySelector("#diagram").textContent.includes("Incoming label"),
            "the image and the incoming diagram");
          return exported;
        } finally {
          observer.disconnect();
        }
      })()`),
      { htmlLabels: 0, originalLabel: true },
    );
  });
});
